import { profile } from '../../src/shared/profiles.ts';
import { expect, test } from './support/fixtures.ts';

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

    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(3);

    const metrics = await qa.metrics();
    expect(metrics.startupMs).not.toBeNull();
    expect(metrics.errors).toEqual([]);
    expect(metrics.frames.decoded).toBeGreaterThan(0);
  },
);
