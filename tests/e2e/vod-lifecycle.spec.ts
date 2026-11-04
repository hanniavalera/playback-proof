import { profile } from '../../src/shared/profiles.ts';
import { expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { END_TOLERANCE_SEC, waitForEnded } from './vod/ending.ts';
import { allSegments, distinctAscending, segmentNumbers } from './vod/segments.ts';

test(
  'PB-VOD-003 plays a short title to the end (vod-cmaf-short): ended fires near the duration, no rebuffer, no error',
  { tag: ['@release', '@dash'] },
  async ({ newSession, player }) => {
    const session = await newSession({
      stream: 'vod-cmaf-short',
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const ended = await waitForEnded(qa, session, info);

    // The player's side: the clock reached the end of the title (the catalog's duration, not the player's own idea of it).
    expect(
      Math.abs(ended.mediaTime - info.durationSec),
      `distance in seconds between the media time of the \`ended\` event (${ended.mediaTime} s) and the end of the title (${info.durationSec} s)`,
    ).toBeLessThanOrEqual(END_TOLERANCE_SEC);
    const metrics = await qa.metrics();
    expect(metrics.state, 'player state (metrics.state) after the end of the title').toBe('ended');
    expectNoRebuffer(metrics);
    expectNoErrors(metrics);

    // The origin's side: every segment of the title, the last one included, was delivered for both tracks.
    const log = await session.service.log(session.id);
    for (const track of ['video', 'audio'] as const) {
      expect(
        distinctAscending(segmentNumbers(log, info, track, { status: 'ok' })),
        `${track} segment numbers the origin delivered (request log), over every representation`,
      ).toEqual(allSegments(info.segmentCount));
    }
  },
);
