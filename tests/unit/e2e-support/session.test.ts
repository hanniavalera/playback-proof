import { describe, expect, it } from 'vitest';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import { streamInfoOf } from '../../../tests/e2e/support/session.ts';

const stream = (id: string, durationSec: number) =>
  ({ id, durationSec, segmentCount: durationSec / 2 }) as unknown as StreamInfo;

describe('streamInfoOf', () => {
  it("returns the catalog entry of the session's own stream", async () => {
    const service = { streams: async () => [stream('vod-cmaf', 60), stream('vod-cmaf-short', 12)] };
    await expect(streamInfoOf({ stream: 'vod-cmaf-short', service } as never)).resolves.toMatchObject({
      id: 'vod-cmaf-short',
      durationSec: 12,
      segmentCount: 6,
    });
  });

  it('says which streams the service lists when it does not list the one asked for', async () => {
    const service = { streams: async () => [stream('vod-cmaf', 60)] };
    await expect(streamInfoOf({ stream: 'live-cmaf', service } as never)).rejects.toThrow(
      'the service does not list the stream live-cmaf (it lists: vod-cmaf)',
    );
    await expect(
      streamInfoOf({ stream: 'live-cmaf', service: { streams: async () => [] } } as never),
    ).rejects.toThrow('(it lists: none)');
  });
});
