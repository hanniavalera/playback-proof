import type { PageRead, PlayerSnapshot, SoakDriver, SoakStart } from '../../../src/lab/readiness/soak.ts';
import type { HarnessSample, RequestDigest } from '../../../src/lab/readiness/report.ts';
import type { HeapSample, SoakInput } from '../../../src/lab/readiness/soak-evaluators.ts';
import { T0 } from './soak-fixtures.ts';

// A soak driver on a virtual clock: the series a real soak would have recorded is generated up front (soak-fixtures.ts), and the driver
// releases it as the harness's clock passes it, answers the readings the harness asks for, and can make the page disappear. A thirty-minute
// soak, its end, a hung player and a crashed page are all run through the real loop in milliseconds.

export interface VirtualScript {
  /** What the soak would record, from the first frame at `T0`: reads, stalls, errors, frames, faults. */
  recorded: SoakInput;
  heapMb?: (sec: number) => number;
  heapSupported?: boolean;
  /** The page is gone from this many seconds after the first frame: draining it fails. */
  crashAtSec?: number;
  consoleProblems?: string[];
  /** A reading of the heap that fails (a CDP error), by the number of the reading. */
  failHeapReading?: number;
  /** The player stalls for good from this many seconds, whatever the recorded reads say after it (the fixture must hold them). */
  stallsForever?: boolean;
}

export class VirtualDriver implements SoakDriver {
  readonly heapSupported: boolean;
  clock = T0;
  readonly calls = {
    drains: 0,
    snapshots: 0,
    heapReadings: [] as number[],
    harnessReadings: [] as number[],
    sleeps: [] as number[],
  };
  stopped = false;
  samplerEveryMs = 0;
  private released = 0;
  private heapCount = 0;

  constructor(private readonly script: VirtualScript) {
    this.heapSupported = script.heapSupported ?? script.recorded.heap !== null;
  }

  now(): number {
    return this.clock;
  }

  async sleep(ms: number): Promise<void> {
    this.calls.sleeps.push(ms);
    this.clock += ms;
  }

  async start(): Promise<SoakStart> {
    this.clock = T0;
    return {
      firstFrameMs: T0,
      faults: [...this.script.recorded.faults],
      player: null,
      stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
    };
  }

  async startSampler(everyMs: number): Promise<void> {
    this.samplerEveryMs = everyMs;
  }

  async drainSamples(): Promise<PageRead> {
    this.calls.drains += 1;
    if (this.crashed()) throw new Error('Target page, context or browser has been closed');
    const all = this.script.recorded.samples;
    const out = [];
    while (this.released < all.length && (all[this.released]?.atMs ?? Infinity) <= this.clock)
      out.push(all[this.released++]!);
    return { samples: out, lost: 0, problems: [] };
  }

  async snapshot(): Promise<PlayerSnapshot> {
    this.calls.snapshots += 1;
    if (this.crashed()) throw new Error('Target page, context or browser has been closed');
    const recorded = this.script.recorded;
    const lastRead = recorded.samples.filter((sample) => sample.atMs <= this.clock).at(-1);
    return {
      episodes: recorded.episodes.filter((episode) => episode.startMs <= this.clock),
      errors: recorded.errors.filter((error) => error.atMs <= this.clock),
      frames: recorded.frames,
      state: lastRead?.state ?? 'playing',
    };
  }

  async drainLog(): Promise<void> {
    // The recorded manifest arrivals are released by the clock in requestDigest().
  }

  requestDigest(): { requests: RequestDigest; manifestArrivalsMs: number[] } {
    const arrivals = this.script.recorded.manifestArrivalsMs.filter((at) => at <= this.clock);
    return {
      requests: {
        total: arrivals.length,
        refusedCount: 0,
        byKind: { manifest: arrivals.length },
        refused: [],
        repeated: [],
      },
      manifestArrivalsMs: arrivals,
    };
  }

  async readHeap(): Promise<HeapSample> {
    this.heapCount += 1;
    if (this.script.failHeapReading === this.heapCount)
      throw new Error('Protocol error (HeapProfiler.collectGarbage): Target closed');
    this.calls.heapReadings.push(this.clock);
    return { atMs: this.clock, usedMb: (this.script.heapMb ?? (() => 14))((this.clock - T0) / 1000) };
  }

  async readHarness(): Promise<HarnessSample> {
    this.calls.harnessReadings.push(this.clock);
    return {
      atMs: this.clock,
      heapUsedMb: 40 + (this.clock - T0) / 1_000_000,
      rssMb: 120,
      serviceRssMb: 150,
    };
  }

  consoleProblems(): string[] {
    return this.script.consoleProblems ?? [];
  }

  crashed(): string | null {
    return this.script.crashAtSec !== undefined && this.clock >= T0 + this.script.crashAtSec * 1000
      ? 'the page crashed (Target crashed)'
      : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
