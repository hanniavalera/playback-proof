import { profile } from '../../src/shared/profiles.ts';
import type { Protocol } from '../../src/shared/streams.ts';
import { expectHealthyPlayback, expectNoErrors } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import type { TestSession } from './support/fixtures.ts';
import { DEFAULT_WAIT_MS } from './support/player.ts';
import type { PlayerHandle } from './support/player.ts';
import { streamInfoOf } from './support/session.ts';
import { describeEntry, requestsFor, rungsFetched, segmentNumbersFetched } from './support/waiting.ts';

const MEDIA_SECONDS = 3;

/**
 * The start of a title on a clean network, as the player and as the origin tell it: a first frame, 3 s of media time, no error and
 * a healthy instrument; and the server's log shows the manifest, the first two segments delivered whole and nothing refused.
 * Nothing here depends on how fast the machine is: the waits are on the media clock and on the log with a bound, there is no count
 * of frames or requests, and the order of the first requests is not read.
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

  // The origin's side of the same facts. The player's clock and the server's log are two channels that nothing orders: an entry is
  // completed when the service has handed the last byte to the socket, which can be after the player already has it, so reading the
  // log once could find a segment the player has played still marked as in flight. The player proved that 3 s of media time needed
  // segments 1 and 2 (0 to 4 s), so the log gets a bounded chance to show them delivered; what it holds then is judged below, and
  // a timeout here is not an error of its own (the assertion that follows says what is missing).
  const videoReps = (await streamInfoOf(session)).reps
    .filter((rep) => rep.track === 'video')
    .map((rep) => rep.id);
  await session.service
    .waitForLog(
      session.id,
      (entries) =>
        [1, 2].every(
          (number) =>
            requestsFor(entries, { kind: 'segment', rep: videoReps, number, status: 'ok' }).length > 0,
        ),
      { timeoutMs: DEFAULT_WAIT_MS },
    )
    .catch(() => undefined);
  const log = await session.service.log(session.id);

  // The origin must not have failed anybody: no 4xx or 5xx and no response it cut short (an abort fault). It may NOT be held
  // responsible for a client that hangs up: a player cancels an in-flight request when it switches rung or seeks, and a slow machine
  // makes it switch early (the first CI run, a 3-CPU runner: `GET seg/v720/8.m4s -> 200, aborted by the client, 0 bytes`, with no
  // fault rule). `status: 'error'` leaves those out; they are listed in the message because a reader of a failure wants to see them.
  const hangUps = requestsFor(log, { clientAborted: true });
  expect(
    requestsFor(log, { status: 'error' }).map(describeEntry),
    `requests the origin answered with an error or cut short (the player's own hang-ups are not counted: ${hangUps.map(describeEntry).join('; ') || 'there were none'})`,
  ).toEqual([]);
  const delivered = rungsFetched(log).flatMap((rung) => segmentNumbersFetched(log, rung, { status: 'ok' }));
  expect(delivered, 'video segments the origin delivered whole (request log)').toEqual(
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
