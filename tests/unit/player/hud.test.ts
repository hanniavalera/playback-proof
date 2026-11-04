import { describe, expect, it } from 'vitest';
import { formatHud } from '../../../src/player/hud.ts';
import { computeMetrics } from '../../../src/player/metrics.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';

const events: QAEvent[] = [
  { index: 0, t: 0, name: 'load-requested', mediaTime: 0 },
  { index: 1, t: 400, name: 'firstframe', mediaTime: 0 },
];

const snapshot = (overrides: Partial<Parameters<typeof computeMetrics>[0]> = {}) =>
  computeMetrics({
    events,
    now: 1000,
    playback: {
      currentTime: 1.5,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 8.25,
      readyState: 4,
    },
    frames: { decoded: 40, dropped: 1, presented: null },
    variant: { id: 2, bandwidth: 764_000, width: 640, height: 360, videoCodec: null, audioCodec: null },
    live: { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null },
    ...overrides,
  });

describe('formatHud', () => {
  it('shows the state, startup, rung and frames of a VOD session, with a dash where nothing is known', () => {
    const text = formatHud(snapshot());
    expect(text).toContain('state     loading');
    expect(text).toContain('startup   400 ms');
    expect(text).toContain('rung      360p @ 764 kbps (0 switches)');
    expect(text).toContain('frames    40 decoded, 1 dropped, ? presented');
    expect(text).toContain('time      1.50 s, 8.3 s ahead');
    expect(text).not.toContain('live ');
    expect(text).not.toContain('errors');
  });

  it('shows no startup before the first frame and no rung before a variant is active', () => {
    const text = formatHud(snapshot({ events: events.slice(0, 1), variant: null }));
    expect(text).toContain('startup   -');
    expect(text).toContain('rung      -');
  });

  it('adds the live line and the error count when they apply', () => {
    const text = formatHud(
      snapshot({
        events: [
          ...events,
          {
            index: 2,
            t: 900,
            name: 'error',
            mediaTime: 1,
            detail: { code: 1001, codeName: 'BAD_HTTP_STATUS', severity: 1 },
          },
        ],
        live: { isLive: true, latencyMs: 6100, latencyMaxMs: 7000, presentationDelayMs: 6000 },
      }),
    );
    expect(text).toContain('live      6100 ms behind the edge (max 7000, delay 6000), 0 edge seeks');
    expect(text).toContain('errors    1, last BAD_HTTP_STATUS');
  });
});
