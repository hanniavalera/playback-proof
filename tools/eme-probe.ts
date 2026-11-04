// `npx tsx tools/eme-probe.ts --engine chromium|firefox|webkit [--origin <service origin>]`
//
// What one engine does with the ClearKey stream (vod-cmaf-clearkey), measured with the instrument of the spec (tests/e2e/eme/evidence.ts)
// and the real player page: whether the engine has EME at all, whether the stream plays with its key and who decrypts it, what a wrong
// key and no key do, and whether the engine's ClearKey module shares keys between pages (the measurements behind ADR-104 and ADR-105 in
// docs/decisions/e2e-eme.md). It prints a Markdown table and asserts nothing: the spec (tests/e2e/eme.spec.ts) is the judge, this is the
// measurement, so that every number of the ADR can be taken again.
//
// It uses a service at --origin, or starts one on a free port (the player is built when dist/player is missing). Firefox does not start on
// the macOS development host: `npm run docker:pw -- npx tsx tools/eme-probe.ts --engine firefox`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import type { BrowserType, Page } from '@playwright/test';
import { ServiceClient } from '../src/lab/service-client.ts';
import { serveFromEnv } from '../src/server/cli.ts';
import type { RunningServer } from '../src/server/index.ts';
import type { ClearKeyParam } from '../src/shared/qa.ts';
import { decryptorOf, watchEme } from '../tests/e2e/eme/evidence.ts';
import { PlayerHandle } from '../tests/e2e/support/player.ts';
import { PLAYER_DIST, buildPlayer } from './build-player.ts';

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
const USAGE =
  'usage: npx tsx tools/eme-probe.ts --engine chromium|firefox|webkit [--origin <service origin>]';
const MEDIA_SECONDS = 3;
const WINDOW_MS = 8000;

interface Outcome {
  verdict: string;
  detail: string;
}

function parseArgs(argv: string[]): { engine: string; origin: string | null } {
  let engine = '';
  let origin: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--engine') engine = argv[(i += 1)] ?? '';
    else if (arg === '--origin') origin = argv[(i += 1)] ?? null;
    else throw new Error(`unknown argument ${String(arg)}\n${USAGE}`);
  }
  if (!(engine in ENGINES))
    throw new Error(`--engine must be one of ${Object.keys(ENGINES).join(', ')}\n${USAGE}`);
  return { engine, origin };
}

/** Plays the stream on `page` with `pair` (or none) and says what came first: media time reached, a critical error, or nothing within the window. */
async function attempt(service: ServiceClient, page: Page, pair: ClearKeyParam | null): Promise<Outcome> {
  const session = await service.createSession({
    stream: 'vod-cmaf-clearkey',
    protocol: 'dash',
    label: 'eme-probe',
  });
  try {
    const eme = await watchEme(page);
    const qa = await new PlayerHandle(page, service.origin, session).open(pair ? { clearKey: pair } : {});
    const verdict = await page.evaluate(
      ([seconds, windowMs]) =>
        Promise.race([
          window.__qa
            .waitForMediaTime(seconds, { timeoutMs: windowMs })
            .then(() => `plays (${seconds} s of media time)`),
          window.__qa
            .waitFor('error', { timeoutMs: windowMs, detail: { severity: 2 } })
            .then((event) => `error ${String(event.detail?.codeName)} (${String(event.detail?.code)})`),
        ]).catch(() => `nothing within ${windowMs / 1000} s (the player stalls)`),
      [MEDIA_SECONDS, WINDOW_MS] as const,
    );
    const metrics = await qa.metrics();
    const evidence = eme.evidence();
    return {
      verdict,
      detail: `decoded ${metrics.frames.decoded}, presented ${metrics.frames.presented ?? 'n/a'}, media time ${metrics.playback.currentTime.toFixed(2)} s, decryptor ${decryptorOf(evidence)}, licenses ${evidence.licenseUpdates}, key status ${evidence.keyStatuses.join('/') || 'none'}`,
    };
  } finally {
    await service.deleteSession(session.id).catch(() => {});
  }
}

async function main(): Promise<void> {
  const { engine, origin: given } = parseArgs(process.argv.slice(2));
  let server: RunningServer | null = null;
  if (!given) {
    if (!existsSync(join(PLAYER_DIST, 'index.html'))) await buildPlayer();
    server = await serveFromEnv({ ...process.env, PB_PORT: '0' }, { out: () => {}, err: console.error });
  }
  const service = new ServiceClient(given ?? (server as RunningServer).origin);
  const browser = await ENGINES[engine]!.launch();
  try {
    const stream = (await service.streams()).find((entry) => entry.id === 'vod-cmaf-clearkey');
    const drm = stream?.drm;
    if (!drm) throw new Error('the service lists no vod-cmaf-clearkey with a test key (StreamInfo.drm)');
    const wrong: ClearKeyParam = {
      keyId: drm.keyId,
      key: `${drm.key.startsWith('0') ? '1' : '0'}${drm.key.slice(1)}`,
    };
    const rows: Array<[string, string, string]> = [];
    const fresh = async (): Promise<Page> => (await browser.newContext()).newPage();

    const emePage = await fresh();
    await emePage.goto(service.origin + '/player/', { waitUntil: 'domcontentloaded' });
    await emePage.waitForFunction(() => window.__qa !== undefined && window.__qa.ready.then(() => true));
    rows.push([
      'EME available (navigator.requestMediaKeySystemAccess)',
      await emePage.evaluate(async () => {
        if (typeof navigator.requestMediaKeySystemAccess !== 'function') return 'no: the API does not exist';
        try {
          const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
            {
              initDataTypes: ['keyids', 'cenc'],
              videoCapabilities: [{ contentType: 'video/mp4; codecs="vp09.00.21.08"' }],
              audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
            },
          ]);
          return `yes (init data types ${access.getConfiguration().initDataTypes?.join(', ')})`;
        } catch (error) {
          return `no: ${(error as Error).name}`;
        }
      }),
      '',
    ]);

    for (const [label, pair] of [
      ['right key', drm],
      ['wrong key (the right key id, one digit of the key changed)', wrong],
      ['no key', null],
    ] as const) {
      const outcome = await attempt(service, await fresh(), pair);
      rows.push([label, outcome.verdict, outcome.detail]);
    }

    // Does the ClearKey module keep keys per page, per context or per browser? A page with the right key stays open; a second page
    // asks for the same key id with a wrong key, in the same context and in another one; then the same with the order swapped, and
    // with the first page closed before the second one starts.
    const sharing = async (label: string, outcome: Promise<Outcome>): Promise<void> => {
      const { verdict, detail } = await outcome;
      rows.push([`sharing: ${label}`, verdict, detail]);
    };
    const holder = await (await browser.newContext()).newPage();
    await sharing('page A, right key, stays open', attempt(service, holder, drm));
    await sharing(
      'page B, wrong key, SAME context as A',
      attempt(service, await holder.context().newPage(), wrong),
    );
    await sharing(
      'page B, wrong key, OTHER context of the same browser',
      attempt(service, await fresh(), wrong),
    );

    const wrongFirst = await (await browser.newContext()).newPage();
    await sharing('page A, wrong key, stays open', attempt(service, wrongFirst, wrong));
    await sharing(
      'page B, right key, SAME context as A',
      attempt(service, await wrongFirst.context().newPage(), drm),
    );

    const closing = await (await browser.newContext()).newPage();
    await sharing('page A, right key, closed afterwards', attempt(service, closing, drm));
    const closedContext = closing.context();
    await closing.close();
    await sharing(
      'page B, wrong key, SAME context as the closed A',
      attempt(service, await closedContext.newPage(), wrong),
    );

    console.log(
      `${engine} ${browser.version()}, ${process.platform}, shaka ${(await emePage.evaluate(() => window.__qa.info().shakaVersion)) || '?'}`,
    );
    console.log('');
    console.log('| measurement | result | detail |');
    console.log('| --- | --- | --- |');
    for (const [label, verdict, detail] of rows) console.log(`| ${label} | ${verdict} | ${detail} |`);
  } finally {
    await browser.close();
    await server?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
