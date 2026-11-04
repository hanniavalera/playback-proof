import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startService } from '../../../src/lab/measure/service.ts';
import type { RunningService } from '../../../src/lab/measure/service.ts';

const FAKE = fileURLToPath(new URL('./fake-service.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function start(
  mode: string,
  extra: { timeoutMs?: number; stopGraceMs?: number } = {},
): Promise<RunningService> {
  return startService({
    root: ROOT,
    port: await freePort(),
    env: { FAKE_MODE: mode },
    command: { file: process.execPath, args: [FAKE] },
    ...extra,
  });
}

describe('PB-PERF service: a child process of the harness', () => {
  it('starts it, waits until it answers /health, and stops it by pid', async () => {
    const service = await start('ok');
    expect(service.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.health).toMatchObject({ status: 'ok', player: 'built' });
    expect(service.pid).not.toBe(process.pid);
    expect(alive(service.pid)).toBe(true);
    expect((await service.client.health()).status).toBe('ok');
    await service.stop();
    expect(alive(service.pid)).toBe(false);
    await expect(fetch(`${service.origin}/health`)).rejects.toThrow();
  });

  it('can be stopped twice', async () => {
    const service = await start('ok');
    await service.stop();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('fails with the output of a child that ended before it answered (a port in use, a missing stream)', async () => {
    const attempt = start('crash');
    await expect(attempt).rejects.toThrow(
      /ended with code 1 before it answered http:\/\/127\.0\.0\.1:\d+\/health/,
    );
    await expect(start('crash')).rejects.toThrow(/EADDRINUSE: address already in use/);
  });

  it('gives up on a child that never answers and leaves nothing running', async () => {
    const before = process.listenerCount('exit');
    await expect(start('silent', { timeoutMs: 600 })).rejects.toThrow(/was not healthy within 600 ms/);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('refuses a service that has no player page', async () => {
    await expect(start('no-player')).rejects.toThrow(/has no player page: run npm run build:player/);
  });

  it('kills a service that ignores SIGTERM after the grace period', async () => {
    const service = await start('stubborn', { stopGraceMs: 250 });
    const started = Date.now();
    await service.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(alive(service.pid)).toBe(false);
  });
});
