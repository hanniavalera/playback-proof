import type { QAEvent, QAMetrics } from '../shared/qa.ts';

// The optional overlay (?hud=1): state, startup, rebuffers, rung and live latency, for a person watching the page. It is
// off by default, so that the page under test carries no extra work, and it only reads `metrics()`.

const fixed = (value: number | null, digits = 0, unit = ''): string =>
  value === null ? '-' : `${value.toFixed(digits)}${unit}`;

export function formatHud(metrics: QAMetrics): string {
  const rung = metrics.bitrate.current;
  const lines = [
    `state     ${metrics.state}`,
    `startup   ${fixed(metrics.startupMs, 0, ' ms')}`,
    `rebuffer  ${metrics.rebuffer.count} x, ${fixed(metrics.rebuffer.totalMs, 0, ' ms')}, ratio ${(metrics.rebuffer.ratio * 100).toFixed(2)} %`,
    `rung      ${rung ? `${rung.height ?? '?'}p @ ${Math.round(rung.bandwidth / 1000)} kbps` : '-'} (${metrics.bitrate.switches} switches)`,
    `frames    ${metrics.frames.decoded} decoded, ${metrics.frames.dropped} dropped, ${metrics.frames.presented ?? '?'} presented`,
    `time      ${fixed(metrics.playback.currentTime, 2, ' s')}, ${fixed(metrics.playback.bufferedAheadSec, 1, ' s')} ahead`,
  ];
  if (metrics.live.isLive) {
    lines.push(
      `live      ${fixed(metrics.live.latencyMs, 0, ' ms')} behind the edge (max ${fixed(metrics.live.latencyMaxMs, 0)}, delay ${fixed(metrics.live.presentationDelayMs, 0)}), ${metrics.live.edgeSeeks} edge seeks`,
    );
  }
  if (metrics.errors.length > 0) {
    const last = metrics.errors[metrics.errors.length - 1];
    lines.push(`errors    ${metrics.errors.length}, last ${last?.codeName ?? last?.code ?? '?'}`);
  }
  return lines.join('\n');
}

export interface HudSource {
  metrics(): QAMetrics;
  subscribe(listener: (event: QAEvent) => void): () => void;
}

/** Shows the overlay in `element` and keeps it current: on every timeline event and every `timeupdate` of the video. */
export function createHud(element: HTMLElement, video: HTMLVideoElement, source: HudSource): void {
  const render = (): void => {
    element.textContent = formatHud(source.metrics());
  };
  element.hidden = false;
  source.subscribe(render);
  video.addEventListener('timeupdate', render);
  render();
}
