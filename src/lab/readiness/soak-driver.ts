import type { CDPSession } from '@playwright/test';
import type { ShakaConfigPatch } from '../../player/configs.ts';
import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { FaultRule } from '../../shared/faults.ts';
import { originStall, staleManifest } from '../../shared/profiles.ts';
import { evidenceOf, JOIN_TIMEOUT_MS, refreshSeries } from './checks.ts';
import type { PlayerEvidence } from './checks.ts';
import { enableHeapProbe, exposeGc, readChromiumHeap, readHarnessMemory } from './heap.ts';
import type { HarnessSample, RequestDigest } from './report.ts';
import { DRAIN_EXPRESSION, STOP_EXPRESSION, installExpression, toSoakSample } from './sampler.ts';
import type { Drained, InstallResult } from './sampler.ts';
import {
  RequestLogDigester,
  episodesOf,
  errorsOf,
  outageSegment,
  outageWindow,
  staleWindow,
} from './soak-data.ts';
import type { PageRead, PlayerSnapshot, SoakDriver, SoakStart } from './soak.ts';
import type { FaultWindow, HeapSample } from './soak-evaluators.ts';
import type { Limits } from './verdict.ts';
import type { PlaywrightRun, PlaywrightWorld } from './playwright-world.ts';

// The soak driver of the command line: the session with its outages, the page, the in-page sampler, the DevTools session for the heap
// (Chromium), the digest of the origin's log, and the readings of the harness's own memory. Not unit-tested (it needs a browser); the loop
// that calls it is (soak.ts, on a virtual clock), and so is every conversion it makes (soak-data.ts, sampler.ts, heap.ts).

export interface SoakDriverOptions {
  minutes: number;
  /** When the origin stops publishing, in minutes from the creation of the session; null: never. */
  stallAtMinutes: number | null;
  /** When the manifest goes stale, in minutes from the first media request; null: never. */
  staleAtMinutes: number | null;
  /** The configuration under test, applied with `qa.configure()` after the page boots; null: A. */
  patch: ShakaConfigPatch | null;
  /** The pid of the service the harness started, for its resident memory. */
  servicePid: number | null;
  limits?: Limits;
  /** The harness's clock and its sleep: the real ones unless the unit tests give a virtual pair that also drives the page's timers. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

const realClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function playwrightSoakDriver(world: PlaywrightWorld, options: SoakDriverOptions): SoakDriver {
  const limits = options.limits ?? LIVE_LIMITS;
  const clock = options.clock ?? realClock;
  const gc = exposeGc();
  let run: PlaywrightRun | null = null;
  let cdp: CDPSession | null = null;
  let timeOrigin = 0;
  let digester: RequestLogDigester | null = null;
  let evidence: PlayerEvidence | null = null;

  const current = (): PlaywrightRun => {
    if (!run) throw new Error('the soak has not started');
    return run;
  };

  return {
    heapSupported: world.engine === 'chromium',
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),

    async start(): Promise<SoakStart> {
      run = await world.newRun({
        label: `PB-RDY-005 soak ${options.minutes} min`,
        // The soak, its warm-up and the grace at its end, with room: a session that expires under a soak ends it with 404s that look like a defect.
        ttlSec: Math.ceil(options.minutes * 60 + 900),
      });
      const { session, player } = run;
      const live = session.live;
      if (!live)
        throw new Error(
          `the service reports no live clock for session ${session.id}: the soak needs a live stream`,
        );

      // The outages are rules of the session, installed before the page exists. The origin stops publishing when segment `atNumber` is
      // published, which for a session created with the stream a whole number of segments on air is `atMinutes` after its creation; the
      // stale manifest's clock starts at the first media request.
      const faults: FaultWindow[] = [];
      const rules: FaultRule[] = [];
      if (options.stallAtMinutes !== null) {
        const atNumber = outageSegment(live.edgeNumber, options.stallAtMinutes, live.segmentDurationSec);
        rules.push(...originStall(atNumber, limits.injectedStallMs));
        faults.push(
          outageWindow(live.availabilityStartTime, atNumber, live.segmentDurationSec, limits.injectedStallMs),
        );
      }
      const staleAfterMs =
        options.staleAtMinutes === null ? null : Math.round(options.staleAtMinutes * 60_000);
      if (staleAfterMs !== null) rules.push(...staleManifest(limits.injectedStallMs, staleAfterMs));
      if (rules.length > 0) await session.service.addFaults(session.id, rules);

      await player.open();
      if (options.patch) await player.configure(options.patch as Record<string, unknown>);
      evidence = evidenceOf(await player.info());
      const frame = await player.waitFor('firstframe', { timeoutMs: JOIN_TIMEOUT_MS });
      timeOrigin = await player.evaluate<number>('performance.timeOrigin', 'performance.timeOrigin');
      if (world.engine === 'chromium') {
        cdp = await run.context.newCDPSession(run.page);
        await enableHeapProbe(cdp);
      }

      const audioReps =
        world.protocol === 'hls'
          ? ((await session.service.streams()).find((stream) => stream.id === world.stream)?.reps ?? [])
              .filter((rep) => rep.track === 'audio')
              .map((rep) => rep.id)
          : [];
      digester = new RequestLogDigester(
        (entry) => refreshSeries([entry], world.protocol, audioReps).length > 0,
      );

      if (staleAfterMs !== null) {
        const firstMedia = (await session.service.log(session.id)).find(
          (entry) => entry.kind === 'init' || entry.kind === 'segment',
        );
        if (!firstMedia)
          throw new Error('the player had made no media request when the first frame was presented');
        faults.push(staleWindow(firstMedia.t, staleAfterMs, limits.injectedStallMs));
      }
      return {
        firstFrameMs: timeOrigin + frame.t,
        faults,
        player: evidence,
        stream: { id: world.stream, protocol: world.protocol, contentHash: null },
      };
    },

    async startSampler(everyMs: number): Promise<void> {
      const installed = await current().player.evaluate<InstallResult>(
        'install the sampler',
        installExpression(everyMs),
      );
      timeOrigin = installed.timeOrigin;
    },

    async drainSamples(): Promise<PageRead> {
      const drained = await current().player.evaluate<Drained | null>('drain the sampler', DRAIN_EXPRESSION);
      if (drained === null)
        throw new Error('the sampler is not running in the page: it was reloaded or replaced');
      return {
        samples: drained.samples.map((raw) => toSoakSample(raw, timeOrigin)),
        lost: drained.lost,
        problems: drained.problems,
      };
    },

    async snapshot(): Promise<PlayerSnapshot> {
      const metrics = await current().player.metrics();
      return {
        episodes: episodesOf(metrics, timeOrigin),
        errors: errorsOf(metrics, timeOrigin),
        frames: { decoded: metrics.frames.decoded, dropped: metrics.frames.dropped },
        state: metrics.state,
      };
    },

    async drainLog(): Promise<void> {
      const { session } = current();
      if (!digester) throw new Error('the soak has not started');
      digester.absorb(await session.service.log(session.id, digester.cursor));
    },

    requestDigest(): { requests: RequestDigest; manifestArrivalsMs: number[] } {
      if (!digester) throw new Error('the soak has not started');
      return { requests: digester.digest(), manifestArrivalsMs: digester.manifestArrivalsMs() };
    },

    async readHeap(): Promise<HeapSample> {
      if (!cdp) throw new Error('the heap can only be read in Chromium');
      return readChromiumHeap(cdp, () => clock.now());
    },

    readHarness(): Promise<HarnessSample> {
      return readHarnessMemory({ nowMs: () => clock.now(), servicePid: options.servicePid, gc });
    },

    consoleProblems: () => run?.consoleProblems() ?? [],
    crashed: () => run?.crashed() ?? null,

    async stop(): Promise<void> {
      if (!run) return;
      await run.player.evaluate('stop the sampler', STOP_EXPRESSION).catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
      await run.close();
    },
  };
}
