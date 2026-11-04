import type { BrowserContext } from '@playwright/test';
import { initPath } from '../../src/shared/urls.ts';
import { newIsolatedContext } from './eme/context.ts';
import { DOCUMENTED_DECRYPTOR, decryptorOf, describeDecryptor, watchEme } from './eme/evidence.ts';
import { NO_EME_ERROR, emeGap } from './eme/gaps.ts';
import {
  CLEARKEY_SYSTEM_ID,
  MP4_PROTECTION_SCHEME,
  protectionOfAdaptationSets,
  protectionOfInit,
  textFormsOfKey,
  uuidOfKeyId,
} from './eme/protection.ts';
import { describeError, expectHealthyPlayback, expectNoErrors } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestsFor, segmentNumbersFetched, waitForRequests } from './support/waiting.ts';

const MEDIA_SECONDS = 3;
// The window in which a player that could decrypt would have presented its first frame (the right key does it in about 0.3 s):
// 30 animation frames of the page are half a second at 60 Hz, counted after the first segments were delivered.
const OBSERVED_FRAMES = 30;
// Shaka's error category of everything about licenses and keys (shaka.util.Error.Category.DRM).
const DRM_CATEGORY = 6;

/** The same key with its first hex digit changed: a different key for the same key id. */
const otherKey = (key: string): string => `${key.startsWith('0') ? '1' : '0'}${key.slice(1)}`;

// ClearKey is the one EME system a lab can run without a license service or a vendor module: the key travels in the page's
// configuration, the browser's CDM (or, where the browser's ClearKey is not trusted, the player) decrypts what the origin serves
// encrypted. The positive half proves the stream plays with its key; the two controls prove the key is what makes it play: the same
// stream with the right key id and a different key reaches the decryption and does not play, and without a key the player refuses it.
// What each engine does and what the spec asserts about it is ADR-104 and ADR-105 in docs/decisions/e2e-eme.md.
test(
  'PB-EME-001 ClearKey playback: vod-cmaf-clearkey plays with a ClearKey license (first frame, 3 s of media time, no error); a wrong key and no key do not play',
  { tag: ['@release', '@eme', '@dash'] },
  async ({ environment, newSession, player, browser, page }, testInfo) => {
    const session = await newSession({ stream: 'vod-cmaf-clearkey', protocol: 'dash' });
    const stream = await streamInfoOf(session);
    const drm = stream.drm;
    if (!drm) throw new Error('the service lists vod-cmaf-clearkey without its test key (StreamInfo.drm)');

    // Each control gets a context of its own: Firefox's ClearKey module shares keys between the pages of a context (ADR-105).
    // They are closed when the test has passed; after a failure they stay open so that the diagnostics can still read their pages.
    const controlContexts: BrowserContext[] = [];
    const controlPage = async () => {
      const controlContext = await newIsolatedContext(browser, testInfo.project.use);
      controlContexts.push(controlContext);
      return controlContext.newPage();
    };

    // A documented gap is confirmed by this run before it skips: the engine must still fail in exactly the documented way. If it
    // plays now (or fails otherwise) the wait below fails with the player's timeline, and the evidence is what has to change.
    const gap = emeGap(environment);
    if (gap) {
      const qa = await player(session).open({ clearKey: drm });
      await qa.waitFor('error', { detail: { codeName: NO_EME_ERROR } });
      testInfo.skip(true, gap);
      return;
    }

    await test.step('the origin serves the stream protected: the manifest names the protection and has no key, the init segments are encrypted', async () => {
      const origin = session.service.origin;
      const manifest = await fetch(origin + session.manifestUrl);
      expect(manifest.status, 'manifest status').toBe(200);
      const mpd = await manifest.text();

      const sets = protectionOfAdaptationSets(mpd);
      const tracks = new Set(stream.reps.map((rep) => rep.track));
      expect(sets, 'AdaptationSets of the manifest (one per track)').toHaveLength(tracks.size);
      for (const [index, elements] of sets.entries()) {
        const generic = elements.find((element) => element.schemeIdUri === MP4_PROTECTION_SCHEME);
        expect(generic, `AdaptationSet ${index}: ContentProtection ${MP4_PROTECTION_SCHEME}`).toBeDefined();
        expect(generic?.value, `AdaptationSet ${index}: its scheme`).toBe('cenc');
        expect(generic?.defaultKid, `AdaptationSet ${index}: cenc:default_KID`).toBe(uuidOfKeyId(drm.keyId));
        expect(
          elements.map((element) => element.schemeIdUri),
          `AdaptationSet ${index}: the protection systems it names`,
        ).toContain(CLEARKEY_SYSTEM_ID);
      }
      for (const [form, text] of Object.entries(textFormsOfKey(drm.key))) {
        expect(mpd.includes(text), `the manifest contains the key written as ${form}`).toBe(false);
      }

      for (const rep of stream.reps) {
        const response = await fetch(origin + initPath(session.id, stream.id, rep.id, rep.initExt));
        expect(response.status, `init segment ${rep.id} status`).toBe(200);
        const protection = protectionOfInit(Buffer.from(await response.arrayBuffer()), drm);
        expect(protection.protectedEntries, `init segment ${rep.id}: protected sample entries`).toEqual([
          rep.track === 'video' ? 'encv' : 'enca',
        ]);
        expect(protection.hasTenc, `init segment ${rep.id} has a tenc box`).toBe(true);
        expect(protection.namesKeyId, `init segment ${rep.id} names the key id of StreamInfo.drm`).toBe(true);
        expect(protection.containsKey, `init segment ${rep.id} contains the key`).toBe(false);
      }
    });

    await test.step('with its ClearKey license the stream plays: a first frame, 3 s of media time, no error, through EME', async () => {
      const eme = await watchEme(page);
      const qa = await player(session).open({ clearKey: drm });
      await qa.waitFor('firstframe');
      const reached = await qa.waitForMediaTime(MEDIA_SECONDS);
      expect(reached, 'media time reached').toBeGreaterThanOrEqual(MEDIA_SECONDS);

      const metrics = await qa.metrics();
      expectHealthyPlayback(metrics);
      expectNoErrors(metrics);
      const info = await qa.info();
      expect(info.loadMode, 'load mode (qa.info().loadMode): the lab plays everything through MSE').toBe(
        'media-source',
      );

      // The key exchange ran through EME: a session opened with the key id, the license applied, the CDM reporting the key usable.
      const evidence = eme.evidence();
      expect(evidence.sessionRequests, 'init data types of the EME sessions').toContain('keyids');
      expect(evidence.licenseUpdates, 'licenses handed to the CDM (MediaKeySession.update)').toBeGreaterThan(
        0,
      );
      expect(evidence.keyStatuses, 'key statuses the CDM reported').toContain('usable');
      // And who decrypted differs by engine, on purpose (ADR-105): the assertion is the measurement, the annotation is the report.
      const decryptor = decryptorOf(evidence);
      const documented = DOCUMENTED_DECRYPTOR[environment.engine];
      testInfo.annotations.push({
        type: 'eme-decryptor',
        description: `${environment.engine}: ${describeDecryptor(decryptor)}`,
      });
      expect(
        decryptor,
        `who decrypts in ${environment.engine} (init segments that reached MSE: ${JSON.stringify(evidence.initSegments)}); documented: ${documented} (DOCUMENTED_DECRYPTOR in tests/e2e/eme/evidence.ts, ADR-105)`,
      ).toBe(documented);

      const log = await session.service.log(session.id);
      expect(
        requestsFor(log, { status: 'error' }),
        'requests the origin answered with an error or aborted',
      ).toEqual([]);
      for (const rep of stream.reps) {
        expect(
          segmentNumbersFetched(log, rep.id, { status: 'ok' }),
          `${rep.id} segments the origin delivered (request log)`,
        ).toEqual(expect.arrayContaining([1, 2]));
      }
    });

    await test.step('with the right key id and a different key the same stream reaches the decryption and does not play', async () => {
      const wrong = await newSession({ stream: 'vod-cmaf-clearkey', protocol: 'dash' });
      const wrongPage = await controlPage();
      const eme = await watchEme(wrongPage);
      const qa = await player(wrong, wrongPage).open({
        clearKey: { keyId: drm.keyId, key: otherKey(drm.key) },
      });

      // The first segment of each track was delivered: what the right key needed to present a frame. Chromium and Firefox then
      // fail with a decode error; WebKit's player stalls without one. Nothing positive ends a stall, so what follows is a negative
      // observation: a window of the page's own frames, and the positive control above is the same flow with the right key.
      await waitForRequests(
        wrong,
        (entry) => entry.kind === 'segment' && entry.number === 1 && !entry.pending && entry.status === 200,
        { count: stream.reps.length },
      );
      await qa.observeFrames(OBSERVED_FRAMES);

      const events = await qa.events();
      expect(
        events.map((event) => event.name),
        'events of the player with a wrong key',
      ).not.toContain('firstframe');
      const metrics = await qa.metrics();
      expect(metrics.startupMs, 'startup time (metrics.startupMs) with a wrong key').toBeNull();
      // Presented, not decoded: WebKit's decoder sometimes counts one frame out of the garbage (2 of 10 runs measured) that nothing ever
      // presents, and what a viewer gets is what counts here.
      expect(
        metrics.frames.presented ?? 0,
        'frames presented (metrics.frames.presented) with a wrong key',
      ).toBe(0);
      expect(metrics.playback.currentTime, 'media time (metrics.playback.currentTime) with a wrong key').toBe(
        0,
      );

      // The control is valid only if it differs from the positive run in the key alone: the CDM took the license and called the
      // key usable, so the failure is in the decryption (or in what the decoder made of it), not in the exchange.
      const evidence = eme.evidence();
      expect(evidence.licenseUpdates, 'licenses handed to the CDM with the wrong key').toBeGreaterThan(0);
      expect(evidence.keyStatuses, 'key statuses the CDM reported with the wrong key').toContain('usable');

      const critical = metrics.errors.find((error) => error.severity >= 2) ?? metrics.errors[0];
      testInfo.annotations.push({
        type: 'eme-wrong-key',
        description: `${environment.engine}: ${critical ? describeError(critical) : 'no error event: the player stalled'}; frames decoded ${metrics.frames.decoded}`,
      });
    });

    await test.step('without a key the player refuses the encrypted stream with a DRM error', async () => {
      const keyless = await newSession({ stream: 'vod-cmaf-clearkey', protocol: 'dash' });
      const keylessPage = await controlPage();
      const qa = await player(keyless, keylessPage).open();

      const error = await qa.waitFor('error', { detail: { category: DRM_CATEGORY, severity: 2 } });
      const metrics = await qa.metrics();
      expect(metrics.state, 'player state (metrics.state) without a key').toBe('error');
      expect(metrics.startupMs, 'startup time (metrics.startupMs) without a key').toBeNull();
      expect(metrics.frames.decoded, 'decoded frames (metrics.frames.decoded) without a key').toBe(0);
      testInfo.annotations.push({
        type: 'eme-no-key',
        description: `${environment.engine}: ${String(error.detail?.codeName)} (${String(error.detail?.code)})`,
      });
    });

    await Promise.all(controlContexts.map((controlContext) => controlContext.close()));
  },
);
