import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPlayer } from '../../../tools/build-player.ts';
import { makeScratch } from '../support/scratch.ts';

const out = makeScratch('player-build-');
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the player build', () => {
  it('copies Shaka verbatim and bundles the lab code separately, in well under the 5 s budget', async () => {
    const result = await buildPlayer(out);
    expect(result.ms).toBeLessThan(5000);
    expect(result.shaka.version).toBe('5.3.3');
    expect(sha256(join(out, 'shaka.js'))).toBe(
      sha256('node_modules/shaka-player/dist/shaka-player.compiled.js'),
    );
    expect(result.shaka.sha256).toBe(sha256(join(out, 'shaka.js')));
    expect(existsSync(join(out, 'player.js.map'))).toBe(true);
  });

  it('is deterministic: the same inputs give the same bytes', async () => {
    await buildPlayer(out);
    const first = ['player.js', 'player.js.map', 'shaka.js', 'index.html', 'player.css'].map((name) =>
      sha256(join(out, name)),
    );
    await buildPlayer(out);
    const second = ['player.js', 'player.js.map', 'shaka.js', 'index.html', 'player.css'].map((name) =>
      sha256(join(out, name)),
    );
    expect(second).toEqual(first);
  });

  it('produces a page whose every script and stylesheet exists, loads Shaka before the lab code, and allows no inline script', async () => {
    await buildPlayer(out);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]);
    expect(scripts).toEqual(['shaka.js', 'player.js']);
    for (const reference of [
      ...scripts,
      ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((match) => match[1]),
    ]) {
      expect(existsSync(join(out, reference ?? '')), `${reference} is missing from the build`).toBe(true);
    }
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('puts the hook on window first thing and imports nothing at run time (no require, no dynamic import)', async () => {
    await buildPlayer(out);
    const code = readFileSync(join(out, 'player.js'), 'utf8');
    expect(code).toContain('window.__qa');
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bimport\(/);
  });
});
