import type { RepInfo, StreamInfo } from '../../../src/shared/streams.ts';

// The ladder of a stream as the ABR specs reason about it: which rungs exist, what each one declares, and which of them a link of a
// given rate can carry. Everything is read from the service's catalog (`streamInfoOf`), never hard-coded: a spec that says "240p"
// must say it because the stream's lowest rung is 240p.

export interface Rung {
  /** The representation id the request log uses (`v240`). */
  rep: string;
  height: number;
  /**
   * What a player that picks this rung declares it needs, bits per second: the video representation plus the audio one. It is the
   * `bandwidth` of the hook's `variant-changed` events and the number Shaka compares its estimate with.
   */
  variantBandwidth: number;
}

export interface Ladder {
  /** Ascending by bandwidth. */
  rungs: readonly Rung[];
  lowest: Rung;
  top: Rung;
  audio: RepInfo;
}

/** The ladder of a stream with one audio representation (every VOD stream of the lab). */
export function ladderOf(stream: Pick<StreamInfo, 'id' | 'reps'>): Ladder {
  const audio = stream.reps.find((rep) => rep.track === 'audio');
  if (!audio) throw new Error(`stream ${stream.id} has no audio representation`);
  const rungs = stream.reps
    .filter((rep) => rep.track === 'video')
    .map((rep): Rung => {
      if (rep.height === undefined)
        throw new Error(`video representation ${rep.id} of ${stream.id} has no height`);
      return { rep: rep.id, height: rep.height, variantBandwidth: rep.bandwidth + audio.bandwidth };
    })
    .sort((a, b) => a.variantBandwidth - b.variantBandwidth);
  const lowest = rungs[0];
  const top = rungs[rungs.length - 1];
  if (!lowest || !top || lowest === top) {
    throw new Error(
      `stream ${stream.id} needs at least two video rungs for an adaptive test, it has ${rungs.length}`,
    );
  }
  return { rungs, lowest, top, audio };
}

/** The rung of a representation id (`v240`) or a height (`240`); throws when the ladder has none. */
export function rungOf(ladder: Ladder, by: { rep: string } | { height: number }): Rung {
  const found = ladder.rungs.find((rung) => ('rep' in by ? rung.rep === by.rep : rung.height === by.height));
  if (!found) {
    const have = ladder.rungs.map((rung) => `${rung.rep} (${rung.height}p)`).join(', ');
    throw new Error(`the ladder has no rung for ${JSON.stringify(by)}; it has ${have}`);
  }
  return found;
}

/**
 * The rungs a link of `kbps` carries: those whose declared variant bandwidth (video + audio) is not above the link rate. A link that
 * carries a rung is not enough for Shaka to pick it (the player wants headroom, `bandwidthDowngradeTarget` 0.95), so this is the
 * necessary condition the arithmetic of `src/shared/profiles.ts` states ("600 kbps carries only 240p"), not a prediction.
 */
export function rungsCarriedBy(ladder: Ladder, kbps: number): Rung[] {
  return ladder.rungs.filter((rung) => rung.variantBandwidth <= kbps * 1000);
}

/** The best rung the link carries, or null when it carries none. */
export function bestRungCarriedBy(ladder: Ladder, kbps: number): Rung | null {
  return rungsCarriedBy(ladder, kbps).at(-1) ?? null;
}
