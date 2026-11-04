import type { StreamId } from '../../shared/streams.ts';
import type { QAError, QAInfo, QAMetrics } from '../../shared/qa.ts';
import type { SmokeSession } from './args.ts';

// What a smoke session is judged on, and how a run is reported. Pure: the tool collects an observation from a real
// browser, these functions decide and print, and the unit tests feed them synthetic observations.

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Where a failed session failed, in the order the stages happen. */
export const SMOKE_STAGES = [
  'launch',
  'navigate',
  'boot',
  'load',
  'firstframe',
  'playback',
  'checks',
  'actions',
  'recovery',
  'evaluate',
] as const;
export type SmokeStage = (typeof SMOKE_STAGES)[number];

export interface BasicObservation {
  kind: 'vod' | 'live';
  /** Media seconds the session had to play after its first frame. */
  mediaSeconds: number;
  firstFrameSeen: boolean;
  /** Media time when the first frame was seen. */
  startMediaTime: number | null;
  /** The media time `qa.waitForMediaTime` returned. */
  reachedMediaTime: number | null;
  info: QAInfo | null;
  metrics: QAMetrics | null;
}

const describeErrors = (errors: readonly QAError[]): string =>
  errors
    .map(
      (error) =>
        `${error.codeName ?? error.code}${error.source ? ` (${error.source})` : ''}: ${error.message}`,
    )
    .join('; ');

/**
 * The media time a session has to reach: `seconds` of media after the whole second the first frame was in. The tool waits for
 * this value and the judge checks it, so they cannot disagree (the first real run did: the tool waited for 3 s, the judge wanted
 * 3.02 s because the first frame was at 0.02 s). A VOD session starts near 0, so it needs `seconds`; a live one starts near the
 * edge (24 s with the lab's defaults), so it needs that plus `seconds`.
 */
export function mediaTargetSec(startMediaTime: number | null, seconds: number): number {
  return Math.floor(startMediaTime ?? 0) + seconds;
}

/**
 * The pass criteria of a playing session: the browser is supported, the page played through Shaka's MSE path, a first frame
 * was presented, media time advanced by the requested seconds, and not one error event was recorded.
 */
export function judgeBasic(o: BasicObservation): Check[] {
  const { info, metrics } = o;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };

  add(
    'browser supported by Shaka',
    info?.supported === true,
    info ? `supported=${info.supported}` : 'no info',
  );
  add(
    'page parameters usable',
    info !== null && info.paramProblems.length === 0,
    info?.paramProblems.join('; ') || undefined,
  );
  add(
    'plays through MSE (loadMode media-source)',
    info?.loadMode === 'media-source',
    `loadMode=${String(info?.loadMode)}`,
  );
  add(
    'first frame presented (startupMs known)',
    o.firstFrameSeen && metrics?.startupMs !== null && metrics?.startupMs !== undefined,
    `startupMs=${String(metrics?.startupMs)}`,
  );
  const target = mediaTargetSec(o.startMediaTime, o.mediaSeconds);
  add(
    `media time advanced ${o.mediaSeconds} s`,
    o.reachedMediaTime !== null && o.reachedMediaTime >= target,
    `reached ${o.reachedMediaTime === null ? 'nothing' : `${o.reachedMediaTime.toFixed(2)} s`}, needed ${target.toFixed(2)} s`,
  );
  const errors = metrics?.errors ?? [];
  add(
    'no error events',
    metrics !== null && errors.length === 0,
    errors.length > 0 ? describeErrors(errors) : undefined,
  );
  if (o.kind === 'live') {
    add(
      'live latency measured',
      metrics?.live.isLive === true &&
        metrics.live.latencyMs !== null &&
        metrics.live.presentationDelayMs !== null,
      `latencyMs=${String(metrics?.live.latencyMs)} presentationDelayMs=${String(metrics?.live.presentationDelayMs)}`,
    );
  }
  return checks;
}

export const failedChecks = (checks: readonly Check[]): Check[] => checks.filter((check) => !check.ok);

export interface SessionResult {
  repeat: number;
  engine: string;
  session: SmokeSession;
  status: 'pass' | 'fail' | 'skip';
  /** The stream played; null when the session was skipped before one was chosen. */
  stream: StreamId | null;
  /** Where a failed session failed. */
  stage?: SmokeStage;
  /** The first line of the failure, in the engine's own words. */
  error?: string;
  skipReason?: string;
  durationMs: number;
  startupMs: number | null;
  mediaTime: number | null;
  rebuffers: number | null;
  decoded: number | null;
  dropped: number | null;
  presented: number | null;
  /** The height of the rung when the metrics were read. */
  rungHeight: number | null;
  /** The height of the first rung Shaka picked for the load (the `start` variant-changed): what the configuration's defaults decide. */
  startRungHeight: number | null;
  switches: number | null;
  latencyMs: number | null;
  info: QAInfo | null;
  /** The last metrics snapshot of the session: the rebuffer events, the rung history, the errors, the live numbers. */
  metrics: QAMetrics | null;
  errors: QAError[];
  checks: Check[];
  /** Console errors and uncaught page errors seen by the browser. */
  consoleErrors: string[];
  /** The part of the timeline a scenario wants to show, as text. */
  excerpt?: string[];
}

/** The numbers of a metrics snapshot that the table and the result file carry. */
export function summarizeMetrics(
  metrics: QAMetrics | null,
): Pick<
  SessionResult,
  | 'startupMs'
  | 'rebuffers'
  | 'decoded'
  | 'dropped'
  | 'presented'
  | 'rungHeight'
  | 'startRungHeight'
  | 'switches'
  | 'latencyMs'
> {
  return {
    startupMs: metrics?.startupMs ?? null,
    rebuffers: metrics?.rebuffer.count ?? null,
    decoded: metrics?.frames.decoded ?? null,
    dropped: metrics?.frames.dropped ?? null,
    presented: metrics?.frames.presented ?? null,
    rungHeight: metrics?.bitrate.current?.height ?? null,
    startRungHeight: metrics?.bitrate.history.find((change) => change.reason === 'start')?.height ?? null,
    switches: metrics?.bitrate.switches ?? null,
    latencyMs: metrics?.live.latencyMs ?? null,
  };
}

function formatTable(rows: string[][]): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const cell = (value: number | null, digits = 0, unit = ''): string =>
  value === null ? '-' : `${value.toFixed(digits)}${unit}`;

export function noteOf(result: SessionResult): string {
  if (result.status === 'skip') return `skipped: ${result.skipReason ?? ''}`;
  if (result.status === 'pass') return '';
  const first = (result.error ?? 'failed').split('\n')[0] ?? '';
  return `[${result.stage ?? '?'}] ${first.length > 110 ? `${first.slice(0, 110)}…` : first}`;
}

/** The compact table the tool prints: one row per session run. */
export function renderTable(results: readonly SessionResult[]): string {
  const rows = [
    [
      'run',
      'engine',
      'session',
      'stream',
      'result',
      'startup',
      'media',
      'rebuf',
      'dropped/decoded',
      'presented',
      'rung',
      'latency',
      'note',
    ],
  ];
  for (const r of results) {
    rows.push([
      String(r.repeat),
      r.engine,
      r.session,
      r.stream ?? '-',
      r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL',
      cell(r.startupMs, 0, ' ms'),
      cell(r.mediaTime, 2, ' s'),
      cell(r.rebuffers),
      r.dropped === null || r.decoded === null ? '-' : `${r.dropped}/${r.decoded}`,
      cell(r.presented),
      rungCell(r),
      cell(r.latencyMs, 0, ' ms'),
      noteOf(r),
    ]);
  }
  return formatTable(rows);
}

/** `720p`, or `360>720p` when the first rung and the current one differ. */
function rungCell(r: SessionResult): string {
  if (r.rungHeight === null) return '-';
  if (r.startRungHeight !== null && r.startRungHeight !== r.rungHeight)
    return `${r.startRungHeight}>${r.rungHeight}p`;
  return `${r.rungHeight}p`;
}

export interface SessionSummary {
  engine: string;
  session: SmokeSession;
  runs: number;
  passes: number;
  failures: number;
  skips: number;
}

/** Passes, failures and skips per engine and session, over every repeat. Skips are not runs. */
export function summarize(results: readonly SessionResult[]): SessionSummary[] {
  const byKey = new Map<string, SessionSummary>();
  for (const r of results) {
    const key = `${r.engine}\u0000${r.session}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { engine: r.engine, session: r.session, runs: 0, passes: 0, failures: 0, skips: 0 };
      byKey.set(key, entry);
    }
    if (r.status === 'skip') entry.skips += 1;
    else {
      entry.runs += 1;
      if (r.status === 'pass') entry.passes += 1;
      else entry.failures += 1;
    }
  }
  return [...byKey.values()];
}

/**
 * What a failed run is called when runs are grouped: the stage it failed at and the error events the page recorded (code names,
 * with Shaka's own data: for a media error, the MediaError code and message), or, when the page recorded none, the first line of
 * the failure (a timeout names what it waited for). Two runs with the same signature failed the same way.
 */
export function failureSignature(result: SessionResult): string {
  const recorded = [
    ...new Set(
      result.errors.map((error) => {
        const data = error.data && error.data.length > 0 ? `(${error.data.map(String).join(', ')})` : '';
        return `${error.codeName ?? error.code}${data}${error.source ? ` via ${error.source}` : ''}`;
      }),
    ),
  ].sort();
  const what = recorded.length > 0 ? recorded.join(' + ') : (result.error ?? 'failed').split('\n')[0];
  return `[${result.stage ?? '?'}] ${what}`;
}

export interface FailureGroup {
  engine: string;
  session: SmokeSession;
  signature: string;
  count: number;
}

/** The failed runs grouped by engine, session and signature, most frequent first. */
export function summarizeFailures(results: readonly SessionResult[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const r of results) {
    if (r.status !== 'fail') continue;
    const signature = failureSignature(r);
    const key = `${r.engine}\u0000${r.session}\u0000${signature}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { engine: r.engine, session: r.session, signature, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
