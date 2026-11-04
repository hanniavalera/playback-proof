import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HealthInfo } from '../../../src/shared/api.ts';
import { CliError, isLoopbackHost, parsePort, serveFromEnv } from '../../../src/server/cli.ts';
import type { CliIo } from '../../../src/server/cli.ts';
import { makeScratch } from '../support/scratch.ts';
import { FAKE_LIVE, FAKE_VOD, FAKE_WEBM, createFakeMedia } from './fake-media.ts';
import { call } from './harness.ts';

// `npm run serve`: its environment, its one line of output, and the refusals. The happy path with the real streams (and the
// signals) is covered by `npm run smoke:service`, which spawns the CLI: the unit job has no generated streams.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const READY = [FAKE_VOD, FAKE_LIVE, FAKE_WEBM];

function io(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => void out.push(line), err: (line) => void err.push(line) }, out, err };
}

describe('serveFromEnv', () => {
  it('listens where PB_PORT=0 says (a free port) and prints exactly one line: where', async () => {
    const { io: sink, out, err } = io();
    const server = await serveFromEnv({ PB_PORT: '0' }, sink, { media: createFakeMedia(), required: READY });
    try {
      expect(out).toEqual([`playback-proof service listening on http://127.0.0.1:${server.port}`]);
      expect(err).toEqual([]);
      expect((await call(server.origin, 'GET', '/health')).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('refuses to start when a stream that has a spec is missing, and says how to fix it for each one', async () => {
    const { io: sink, out } = io();
    // the catalog has five specs, the fake store holds three streams
    const refusal = serveFromEnv({ PB_PORT: '0' }, sink, { media: createFakeMedia() });
    await expect(refusal).rejects.toThrow(CliError);
    await expect(refusal).rejects.toThrow(
      'stream vod-cmaf is missing: run npm run generate:streams\nstream vod-cmaf-clearkey is missing: run npm run generate:streams',
    );
    expect(out).toEqual([]);
  });

  it('starts when every stream that has a spec is there, whatever the optional ones', async () => {
    const { io: sink, out } = io();
    const server = await serveFromEnv({ PB_PORT: '0' }, sink, {
      media: createFakeMedia(),
      required: [FAKE_VOD],
    });
    try {
      expect(out).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('writes one line per request to stderr when PB_LOG=1, and nothing otherwise', async () => {
    const quiet = io();
    const a = await serveFromEnv({ PB_PORT: '0' }, quiet.io, { media: createFakeMedia(), required: READY });
    await call(a.origin, 'GET', '/health');
    await a.close();
    expect(quiet.err).toEqual([]);

    const loud = io();
    const b = await serveFromEnv({ PB_PORT: '0', PB_LOG: '1' }, loud.io, {
      media: createFakeMedia(),
      required: READY,
    });
    await call(b.origin, 'GET', '/health');
    await b.close();
    expect(loud.err).toHaveLength(1);
    expect(loud.err[0]).toMatch(/ GET \/health 200 \d+\.\dms$/);
  });

  it('serves the player from PB_PLAYER_DIR', async () => {
    const dir = makeScratch('cli-player-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const server = await serveFromEnv({ PB_PORT: '0', PB_PLAYER_DIR: dir }, io().io, {
      media: createFakeMedia(),
      required: READY,
    });
    try {
      expect((await call(server.origin, 'GET', '/health')).json<HealthInfo>().player).toBe('built');
      expect((await call(server.origin, 'GET', '/player/')).status).toBe(200);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what to do when the port is taken', async () => {
    const first = await serveFromEnv({ PB_PORT: '0' }, io().io, {
      media: createFakeMedia(),
      required: READY,
    });
    try {
      await expect(
        serveFromEnv({ PB_PORT: String(first.port) }, io().io, { media: createFakeMedia(), required: READY }),
      ).rejects.toThrow(new RegExp(`port ${first.port} on 127\\.0\\.0\\.1 is already in use: set PB_PORT`));
    } finally {
      await first.close();
    }
  });
});

describe('the environment', () => {
  it('reads PB_PORT: 4600 when it is not set, 0 for a free port, and nothing else than an integer up to 65535', () => {
    expect(parsePort(undefined)).toBe(4600);
    expect(parsePort('')).toBe(4600);
    expect(parsePort('0')).toBe(0);
    expect(parsePort('4631')).toBe(4631);
    expect(parsePort('65535')).toBe(65_535);
    for (const bad of ['65536', '-1', '4600.5', 'abc', '4600 ', '0x10', '1e3']) {
      expect(() => parsePort(bad), bad).toThrow(/PB_PORT must be an integer from 0 to 65535/);
    }
  });

  it('knows which hosts only this machine can reach: anything else is warned about', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.test'])
      expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('tools/serve.ts as a process', () => {
  function run(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/serve.ts'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('exits 1 without printing anything on stdout when the streams were not generated, naming each missing stream', () => {
    const empty = makeScratch('cli-empty-cache-');
    try {
      const result = run({ PB_PORT: '0', PB_CACHE_DIR: empty });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      for (const id of ['vod-cmaf', 'vod-cmaf-short', 'vod-webm', 'live-cmaf', 'vod-cmaf-clearkey'])
        expect(result.stderr).toContain(`stream ${id} is missing: run npm run generate:streams`);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('exits 1 with a message for a PB_PORT that is not a port, before it looks at any stream', () => {
    const result = run({ PB_PORT: 'http' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('PB_PORT must be an integer from 0 to 65535');
  });
});
