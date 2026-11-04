import { execFile } from 'node:child_process';
import { memoryUsage } from 'node:process';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { HarnessSample } from './report.ts';
import type { HeapSample } from './soak-evaluators.ts';

// The two memories a soak reads. The page's JS heap, in Chromium, through the DevTools protocol after a FORCED collection: the heap of a
// running page is a sawtooth between collections, and growth that is read from the teeth is noise; after a collection what is left is
// what the page retains, so a rise in it is a leak. And the harness's own: a soak that leaks in the harness proves nothing, so the
// process that runs it and the service it started are read at the same moments.

/** MB here is 2^20 bytes (the unit DevTools' own memory panel uses). */
export const BYTES_PER_MB = 1_048_576;

/** The part of a DevTools session the probe uses: Playwright's `CDPSession` has it. */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface MetricsResult {
  metrics: Array<{ name: string; value: number }>;
}

/**
 * Turns the Performance domain on: `getMetrics` answers nothing before it (docs/decisions/readiness.md, ADR-157: from the reading of
 * Chromium's source, which the probe's error below would show to be wrong). `HeapProfiler` needs no `enable` for `collectGarbage`: the
 * protocol (js_protocol.pdl) gives it no parameters and no dependency, and Playwright's own `requestGC()` sends it alone.
 */
export async function enableHeapProbe(cdp: CdpLike): Promise<void> {
  await cdp.send('Performance.enable');
}

/**
 * The JS heap in use after a full collection (`HeapProfiler.collectGarbage`, which waits for it), with the number of DOM nodes and event
 * listeners, which say what grew when the heap did. A reading that the page did not give is an error and never a zero: a number that was
 * not measured must not be a number.
 */
export async function readChromiumHeap(cdp: CdpLike, nowMs: () => number): Promise<HeapSample> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = (await cdp.send('Performance.getMetrics')) as MetricsResult;
  const value = (name: string): number | undefined => metrics.find((metric) => metric.name === name)?.value;
  const used = value('JSHeapUsedSize');
  if (used === undefined || !Number.isFinite(used))
    throw new Error(
      `Performance.getMetrics did not report JSHeapUsedSize (it reported: ${metrics.map((m) => m.name).join(', ')})`,
    );
  const nodes = value('Nodes');
  const listeners = value('JSEventListeners');
  return {
    atMs: nowMs(),
    usedMb: used / BYTES_PER_MB,
    ...(nodes === undefined ? {} : { nodes }),
    ...(listeners === undefined ? {} : { listeners }),
  };
}

/**
 * A function that collects this process's garbage, without the `--expose-gc` flag that `npm run soak` cannot pass: V8 can be told at run
 * time, and the function is taken out of a fresh context. null when the runtime refuses: the harness's heap is then read as it is.
 */
export function exposeGc(): (() => void) | null {
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as unknown;
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

/** Resident memory of a process in MB, from `ps` (the same on macOS and Linux); null when it cannot be read. */
export function residentMb(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (error, stdout) => {
      const kilobytes = Number(stdout.trim());
      resolve(error || !Number.isFinite(kilobytes) || kilobytes <= 0 ? null : kilobytes / 1024);
    });
  });
}

/** The harness's own memory: its heap after a collection (when it can force one), its resident size, and the service's resident size. */
export async function readHarnessMemory(options: {
  nowMs: () => number;
  servicePid: number | null;
  gc?: (() => void) | null;
}): Promise<HarnessSample> {
  options.gc?.();
  const usage = memoryUsage();
  return {
    atMs: options.nowMs(),
    heapUsedMb: usage.heapUsed / BYTES_PER_MB,
    rssMb: usage.rss / BYTES_PER_MB,
    serviceRssMb: options.servicePid === null ? null : await residentMb(options.servicePid),
  };
}
