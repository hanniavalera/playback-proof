import { expectHealthyPlayback } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { explainUndocumentedGap, versionDrift } from './support/gaps.ts';

// What the probe of the matrix requires of a flavour (docs/CODEC_MATRIX.md): 1 s of media time and 5 frames presented.
const MEDIA_SECONDS = 1;
const MIN_FRAMES = 5;

// The environment check. Where the committed matrix says an engine cannot play here, the shared fixture has already skipped this
// test with that evidence. Everywhere else the engine must play a real stream of the flavour the matrix selected, through the player
// itself: when it cannot, nothing documents the gap, so this is the failure that says "the environment changed", before a pile of
// playback failures says something misleading.
test(
  'PB-ENV-001 the engine plays the selected flavour through the player, or the engine and OS pair is a documented gap',
  { tag: '@merge' },
  async ({ browser, environment, newSession, streamFor, player }, testInfo) => {
    const protocol = 'dash';
    const stream = streamFor('vod', protocol);
    const version = browser.version();
    testInfo.annotations.push({
      type: 'environment',
      description: `${environment.envId}: ${environment.engine} ${version}; evidence: ${environment.basis}`,
    });
    const drift = versionDrift(environment, version);
    if (drift) testInfo.annotations.push({ type: 'evidence-drift', description: drift });

    const session = await newSession({ stream, protocol });
    const qa = player(session);
    try {
      await qa.open();
      await qa.waitFor('firstframe');
      await qa.waitForMediaTime(MEDIA_SECONDS);
    } catch (error) {
      const info = await qa.info().catch(() => null);
      throw new Error(
        explainUndocumentedGap(environment, {
          stream,
          protocol,
          actualVersion: version,
          ...(info ? { userAgent: info.userAgent } : {}),
          cause: (error as Error).message,
        }),
        { cause: error },
      );
    }

    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expect(metrics.frames.decoded, 'decoded frames (metrics.frames.decoded)').toBeGreaterThanOrEqual(
      MIN_FRAMES,
    );
    const info = await qa.info();
    expect(info.loadMode, 'load mode (qa.info().loadMode)').toBe('media-source');
  },
);
