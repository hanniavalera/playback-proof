import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestLogEntry } from '../shared/api.ts';
import type { RequestKind } from '../shared/faults.ts';
import type { RepInfo } from '../shared/streams.ts';
import { initPath, segmentPath } from '../shared/urls.ts';
import type { ParsedPath } from '../shared/urls.ts';
import { bucketFor } from './buckets.ts';
import type { Clock } from './clock.ts';
import { LIVE_DEFAULTS } from './constants.ts';
import { deliver } from './deliver.ts';
import type { DeliverHooks, DeliverOutcome, DeliverPlan } from './deliver.ts';
import type { FaultPlan, RequestFacts } from './faults.ts';
import { COMMON_HEADERS } from './http.ts';
import { availability } from './liveclock.ts';
import type { LiveParams, LiveView } from './liveclock.ts';
import type { DashLiveParams, HlsLiveParams, MediaStore } from './media/types.ts';
import type { Session } from './sessions.ts';

// The media request pipeline: everything under /s/<session>/ (docs/CONTRACTS.md sections 3 and 5). The order of the steps is the
// design (ADR-060): the request is LISTED first, so the log shows it while it is in flight; the fault plan is decided next, from
// the request alone; then what exists NOW is decided (the live window), then the bytes are built, and only then written, with the
// plan applied to the write. Nothing here touches a socket except through deliver().

export interface MediaContext {
  media: MediaStore;
  clock: Clock;
  report(what: string, err: unknown): void;
}

/** What the caller needs to know about a finished request (the access log line). */
export interface RequestSummary {
  status: number;
  bytes: number;
  faults: readonly string[];
  aborted: boolean;
}

interface Answer {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | string;
}

type Resolution =
  | { ok: true; facts: RequestFacts; rep: RepInfo | undefined }
  | { ok: false; status: 404 | 405; message: string; headers?: Record<string, string> };

const DASH_TYPE = 'application/dash+xml';
const HLS_TYPE = 'application/vnd.apple.mpegurl';
const JSON_TYPE = 'application/json; charset=utf-8';

const round = (ms: number): number => Math.round(ms * 100) / 100;

const refusal = (status: 404 | 405, message: string, headers?: Record<string, string>): Resolution => ({
  ok: false,
  status,
  message,
  ...(headers ? { headers } : {}),
});

function emptyPlan(): FaultPlan {
  return { fired: [], latencyMs: 0, throttle: [], staleManifest: false };
}

function errorAnswer(status: number, message: string, headers: Record<string, string> = {}): Answer {
  return {
    status,
    headers: { 'Content-Type': JSON_TYPE, ...headers },
    body: JSON.stringify({ error: message }),
  };
}

/** Step 1: is this a resource of this session? Nothing is decided here about what exists at this moment. */
function resolve(session: Session, parsed: ParsedPath, method: string): Resolution {
  if (method !== 'GET' && method !== 'HEAD')
    return refusal(405, `${method} is not allowed here`, { Allow: 'GET, HEAD, OPTIONS' });
  if (parsed.kind === 'other') return refusal(404, 'not a resource of this service');
  const stream = session.stream;
  if (parsed.stream !== stream.id)
    return refusal(404, `session ${session.id} serves ${stream.id}, not ${parsed.stream}`);
  if (parsed.protocol !== undefined && !stream.protocols.includes(parsed.protocol))
    return refusal(404, `${stream.id} is not served over ${parsed.protocol}`);
  const rep =
    parsed.rep === undefined ? undefined : stream.reps.find((candidate) => candidate.id === parsed.rep);
  const kind: RequestKind = parsed.kind === 'media-playlist' ? 'manifest' : parsed.kind;
  return {
    ok: true,
    rep,
    facts: {
      kind,
      ...(rep ? { track: rep.track } : {}),
      ...(parsed.rep === undefined ? {} : { rep: parsed.rep }),
      ...(parsed.number === undefined ? {} : { number: parsed.number }),
    },
  };
}

function liveOf(
  session: Session,
  nowMs: number,
): { view: LiveView; params: LiveParams; availabilityStart: Date } {
  const view = session.liveView(nowMs);
  const params = session.liveParams;
  if (!view || !params) throw new Error(`live session ${session.id} has no live clock`);
  return { view, params, availabilityStart: new Date(params.availabilityStartMs) };
}

function dashLiveParams(session: Session, nowMs: number): DashLiveParams {
  const { view, params, availabilityStart } = liveOf(session, nowMs);
  return {
    firstNumber: view.firstNumber,
    lastNumber: view.lastNumber,
    availabilityStartTime: availabilityStart,
    publishTime: new Date(view.publishTimeMs),
    timeShiftBufferDepthSec: (params.windowSegments * params.segmentDurationMs) / 1000,
    presentationDelaySec: params.presentationDelaySec,
    minimumUpdatePeriodSec: LIVE_DEFAULTS.minimumUpdatePeriodSec,
  };
}

function hlsLiveParams(session: Session, nowMs: number): HlsLiveParams {
  const { view, availabilityStart } = liveOf(session, nowMs);
  return {
    firstNumber: view.firstNumber,
    lastNumber: view.lastNumber,
    availabilityStartTime: availabilityStart,
  };
}

function manifestAnswer(
  session: Session,
  url: string,
  plan: FaultPlan,
  type: string,
  build: () => string,
): Answer {
  return { status: 200, headers: { 'Content-Type': type }, body: session.manifestBody(url, plan, build) };
}

/**
 * Step 3 and 4: the bytes of an existing, available resource, or the 404 that says why there are none. The live window is read
 * ONCE, at arrival (`nowMs`): a latency fault delays the delivery of a decision that was already made, like a slow link.
 */
function respond(
  ctx: MediaContext,
  session: Session,
  parsed: ParsedPath,
  pathname: string,
  rep: RepInfo | undefined,
  plan: FaultPlan,
  nowMs: number,
): Answer {
  const { media } = ctx;
  const stream = session.stream;
  const live = stream.kind === 'live';

  if (parsed.kind === 'manifest') {
    if (parsed.protocol === 'dash') {
      const build = live
        ? () => media.dashLive(stream.id, dashLiveParams(session, nowMs))
        : () => media.dashVod(stream.id);
      return manifestAnswer(session, pathname, plan, DASH_TYPE, build);
    }
    return manifestAnswer(session, pathname, plan, HLS_TYPE, () => media.hlsMaster(stream.id));
  }

  if (!rep) return errorAnswer(404, `${stream.id} has no representation ${parsed.rep}`);

  if (parsed.kind === 'media-playlist') {
    const build = live
      ? () => media.hlsMediaLive(stream.id, rep.id, hlsLiveParams(session, nowMs))
      : () => media.hlsMediaVod(stream.id, rep.id);
    return manifestAnswer(session, pathname, plan, HLS_TYPE, build);
  }

  // One URL per resource: a wrong extension, a leading zero or a plus sign is a different URL, and it does not exist.
  const canonical =
    parsed.kind === 'init'
      ? initPath(session.id, stream.id, rep.id, rep.initExt)
      : segmentPath(session.id, stream.id, rep.id, parsed.number ?? 0, rep.segmentExt);
  if (pathname !== canonical)
    return errorAnswer(404, `not a resource of this service: ${canonical} is the URL`);

  const base = { status: 200, headers: { 'Content-Type': rep.mimeType } };
  if (parsed.kind === 'init') return { ...base, body: media.init(stream.id, rep.id) };

  const number = parsed.number ?? 0;
  if (live) {
    const { view } = liveOf(session, nowMs);
    const state = availability(view, number);
    if (state === 'not-yet')
      return errorAnswer(404, `segment ${number} is not published yet: the live edge is ${view.lastNumber}`);
    if (state === 'gone')
      return errorAnswer(404, `segment ${number} is gone: the window starts at ${view.firstNumber}`);
    return { ...base, body: media.liveSegment(stream.id, rep.id, number) };
  }
  const data = media.segment(stream.id, rep.id, number);
  if (!data)
    return errorAnswer(
      404,
      `segment ${number} does not exist: ${stream.id} has ${stream.segmentCount} segments`,
    );
  return { ...base, body: data };
}

/** What deliver() would reject with 'error': a status outside 100-599, a header value that is not a string or a number. */
function assertDeliverable(answer: Answer): void {
  if (!Number.isInteger(answer.status) || answer.status < 100 || answer.status > 599)
    throw new RangeError(`invalid status ${answer.status}`);
  for (const [name, value] of Object.entries(answer.headers)) {
    const ok =
      typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && !/[\r\n]/.test(value);
    if (!ok) throw new TypeError(`invalid value for header ${name}`);
  }
}

/** Answers one request under /s/<session>/ and completes its log entry, whatever the client does meanwhile. */
export async function serveMedia(
  ctx: MediaContext,
  session: Session,
  parsed: ParsedPath,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RequestSummary> {
  const arrived = performance.now();
  const nowMs = ctx.clock.now();
  const method = req.method ?? 'GET';
  // Step 2: listed at once, pending. `seq` is assigned here, so the log is in arrival order.
  const entry: RequestLogEntry = session.log.begin({
    method,
    path: pathname,
    kind: parsed.kind === 'media-playlist' ? 'manifest' : parsed.kind,
    ...(parsed.rep === undefined ? {} : { rep: parsed.rep }),
    ...(parsed.number === undefined ? {} : { number: parsed.number }),
    arrivedAtMs: nowMs,
    sessionStartMs: session.createdAtMs,
  });

  let plan = emptyPlan();
  let answer: Answer;
  try {
    const resolved = resolve(session, parsed, method);
    if (!resolved.ok) {
      answer = errorAnswer(resolved.status, resolved.message, resolved.headers);
    } else {
      plan = session.faults.evaluate(resolved.facts, entry.seq);
      entry.faults = [...plan.fired];
      // A `status` fault wins over everything, including a resource that does not exist: the origin is failing.
      answer =
        plan.status === undefined
          ? respond(ctx, session, parsed, pathname, resolved.rep, plan, nowMs)
          : { status: plan.status, headers: {}, body: '' };
    }
    assertDeliverable(answer);
  } catch (err) {
    ctx.report(`${method} ${pathname}`, err);
    answer = errorAnswer(500, 'internal error');
  }

  // A `status` answer has no body for the other faults to act on (CONTRACTS section 5).
  const delivery: DeliverPlan = { latencyMs: plan.latencyMs };
  if (plan.status === undefined) {
    if (plan.throttle.length > 0)
      delivery.buckets = plan.throttle.map((rule) => bucketFor(session, rule.ruleId, rule.kbps));
    if (plan.stall) delivery.stall = plan.stall;
    if (plan.abort) delivery.abort = plan.abort;
  }

  // The time the service spent before it started to write counts toward what the log reports as time since arrival.
  const beforeDeliverMs = performance.now() - arrived;
  const hooks: DeliverHooks = {
    onHead(ttfbMs) {
      entry.status = answer.status;
      entry.ttfbMs = round(beforeDeliverMs + ttfbMs);
    },
    onBytes(sent) {
      entry.bytes = sent;
      entry.totalMs = round(performance.now() - arrived);
    },
  };

  let outcome: DeliverOutcome | undefined;
  try {
    outcome = await deliver(
      req,
      res,
      {
        status: answer.status,
        headers: { ...COMMON_HEADERS, ...answer.headers },
        body: answer.body,
        head: method === 'HEAD',
        plan: delivery,
      },
      hooks,
    );
  } catch (err) {
    // deliver() never rejects; this is for the day somebody changes that.
    ctx.report(`${method} ${pathname}`, err);
    res.destroy();
  } finally {
    // The entry must never stay pending, whatever the client did.
    entry.pending = false;
    if (outcome) {
      entry.bytes = outcome.bytesSent;
      entry.ttfbMs = round(beforeDeliverMs + outcome.ttfbMs);
      entry.totalMs = round(beforeDeliverMs + outcome.totalMs);
      if (outcome.aborted) entry.aborted = true;
      if (outcome.error) ctx.report(`${method} ${pathname}`, `delivery: ${outcome.error}`);
    } else {
      entry.totalMs = round(performance.now() - arrived);
      entry.aborted = true;
    }
    entry.faults = [...plan.fired];
    session.recordCompletion(entry);
  }
  return { status: entry.status, bytes: entry.bytes, faults: entry.faults, aborted: entry.aborted === true };
}
