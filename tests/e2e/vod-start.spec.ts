import { profile } from '../../src/shared/profiles.ts';
import type { Protocol } from '../../src/shared/streams.ts';
import { expectHealthyPlayback, expectNoErrors } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import type { TestSession } from './support/fixtures.ts';
import type { PlayerHandle } from './support/player.ts';
import { requestsFor, rungsFetched, segmentNumbersFetched } from './support/waiting.ts';

const MEDIA_SECONDS = 3;

/**
 * The start of a title on a clean network, as the player and as the origin tell it: a first frame, 3 s of media time, no error and
 * a healthy instrument; and the server's log shows the manifest, the first two segments delivered and nothing refused.
 */
async function expectStartsAndPlays(
  qa: PlayerHandle,
  session: TestSession,
  protocol: Protocol,
): Promise<void> {
  await qa.waitFor('firstframe');
  const reached = await qa.waitForMediaTime(MEDIA_SECONDS);
  expect(reached, 'media time reached').toBeGreaterThanOrEqual(MEDIA_SECONDS);

  const metrics = await qa.metrics();
  expectHealthyPlayback(metrics);
  expectNoErrors(metrics);

  const info = await qa.info();
  expect(
    info.loadMode,
    'load mode (qa.info().loadMode): the lab plays everything through Media Source Extensions',
  ).toBe('media-source');

  const log = await session.service.log(session.id);
  expect(
    requestsFor(log, { status: 'error' }),
    'requests the origin answered with an error or aborted',
  ).toEqual([]);
  const delivered = rungsFetched(log).flatMap((rung) => segmentNumbersFetched(log, rung, { status: 'ok' }));
  expect(delivered, 'video segments the origin delivered (request log)').toEqual(
    expect.arrayContaining([1, 2]),
  );
  if (protocol === 'hls') {
    const playlists = requestsFor(log, { kind: 'manifest' }).filter((entry) => entry.rep !== undefined);
    expect(playlists.length, 'HLS media playlists requested (request log)').toBeGreaterThan(0);
  }
}

test(
  'PB-VOD-001 DASH VOD starts: first frame presented, 3 s of media time reached, no error',
  { tag: ['@merge', '@cpu', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const qa = await player(session).open();
    await expectStartsAndPlays(qa, session, 'dash');
  },
);

test(
  'PB-VOD-002 HLS VOD starts: first frame presented, 3 s of media time reached, no error',
  { tag: ['@merge', '@hls'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'hls'),
      protocol: 'hls',
      faults: profile('clean'),
    });
    const qa = await player(session).open();
    await expectStartsAndPlays(qa, session, 'hls');
  },
);
