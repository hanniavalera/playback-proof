import { BUSY_LOAD_SHARE } from '../src/lab/measure/report.ts';
import { configFor } from '../src/player/configs.ts';
import type { ResultAnalysis } from './analyze.ts';
import { canonicalJson } from './prereg.ts';
import type { Preregistration } from './prereg.ts';
import { describeProvenance } from './provenance.ts';
import type { RawResult } from './results.ts';
import { blockSchedule } from './schedule.ts';

// VALIDITY: was the experiment run as it was pre-registered, on data that can be trusted? The lab passes an experiment when it was VALID, not
// by the direction of its result: whether B turned out better, worse, equivalent or undecided is the verdict, and the verdict drives the
// decision the test catalog names for the row (ship B, do not ship B, keep A). A run that was not valid has no verdict worth acting on,
// whichever way it points. Seven gates, each computed from the raw results (and, for the last, from the committed report of the A/A run):
//
//   preregistration  the plan was committed, unmodified, before the run started
//   design           the sessions are the ones the plan schedules, in its order, in every condition, none stopped early
//   configuration    every finished session proved, through `qa.info()`, that it ran the configuration of its arm
//   condition        every finished session proved, through the service, that it met the registered condition, and that it fired
//   failures         the failed sessions are few and fell evenly on the arms (the failure guard of the decision rule)
//   machine          the machine was not busy when the run started
//   aa-check         the harness had passed its own check (PB-AB-001) in this environment, for this engine and this condition
//
// A pipeline check computes the same gates (they show the plumbing works) and is never evidence.

export type GateId =
  'preregistration' | 'design' | 'configuration' | 'condition' | 'failures' | 'machine' | 'aa-check';

export interface Gate {
  id: GateId;
  title: string;
  passed: boolean;
  /** false: the gate is reported but does not decide validity (the machine gate of a pipeline check, which runs on whatever machine there is). */
  enforced?: boolean;
  /** What was checked, with the numbers; when the gate failed, what is wrong. */
  detail: string;
}

export interface Validity {
  /** Every gate passed. */
  valid: boolean;
  /** `valid`, and the run is an experiment: a pipeline check is never evidence, whatever its gates say. */
  evidence: boolean;
  gates: Gate[];
  /** One sentence, for the top of the report. */
  summary: string;
}

export interface ValidityContext {
  /** Reads a committed file by its path relative to the repository: the A/A report an experiment relies on. null when it is not there. */
  readReference?: (path: string) => string | null;
}

const first = (items: readonly string[], count = 3): string =>
  `${items.slice(0, count).join('; ')}${items.length > count ? `; and ${items.length - count} more` : ''}`;

function preregistrationGate(raw: RawResult): Gate {
  const proof = describeProvenance(raw.preregistration.committed, raw.run.startedAt);
  return {
    id: 'preregistration',
    title: 'Pre-registration fixed first',
    passed: proof.proves,
    detail: `The plan embedded in the results hashes to ${raw.preregistration.sha256}. ${proof.sentence}`,
  };
}

function designGate(raw: RawResult, plan: Preregistration): Gate {
  const schedule = blockSchedule(plan.sessionsPerArm, plan.warmupSessionsPerArm, plan.arms);
  const problems: string[] = [];
  for (const registered of plan.conditions) {
    if (!raw.conditions.some((condition) => condition.id === registered.id))
      problems.push(
        `${registered.id}: not run (the plan has ${plan.conditions.length} conditions, the results ${raw.conditions.length})`,
      );
  }
  for (const condition of raw.conditions) {
    const registered = plan.conditions.find((candidate) => candidate.id === condition.id);
    if (registered === undefined) {
      problems.push(`${condition.id}: not a condition of the plan`);
      continue;
    }
    if (canonicalJson(condition.rules) !== canonicalJson(registered.rules))
      problems.push(`${condition.id}: the rules that ran are not the registered ones`);
    if (condition.stream !== plan.stream)
      problems.push(`${condition.id}: ran on stream ${condition.stream}, the plan says ${plan.stream}`);
    if (condition.aborted !== null) problems.push(`${condition.id}: stopped early (${condition.aborted})`);
    if (condition.sessions.length !== schedule.length) {
      problems.push(
        `${condition.id}: ${condition.sessions.length} sessions recorded, the plan schedules ${schedule.length}`,
      );
      continue;
    }
    const wrong = schedule.filter((planned, i) => {
      const session = condition.sessions[i];
      return (
        session === undefined ||
        session.index !== planned.index ||
        session.block !== planned.block ||
        session.arm !== planned.arm ||
        session.config !== planned.config ||
        session.warmup !== planned.warmup ||
        session.condition !== condition.id
      );
    });
    if (wrong.length > 0)
      problems.push(
        `${condition.id}: ${wrong.length} sessions are not where the plan puts them (the first: position ${(wrong[0] as { index: number }).index + 1})`,
      );
  }
  const total = schedule.length * raw.conditions.length;
  return {
    id: 'design',
    title: 'Design followed',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${total} sessions in ${raw.conditions.length} condition${raw.conditions.length === 1 ? '' : 's'}: blocks of two, the arm that goes first alternating, ${plan.warmupSessionsPerArm} warm-up block${plan.warmupSessionsPerArm === 1 ? '' : 's'} first, ${plan.sessionsPerArm} measured per arm, exactly the plan's schedule, rules and stream.`
        : first(problems),
  };
}

function configurationGate(raw: RawResult): Gate {
  const problems: string[] = [];
  let proved = 0;
  for (const condition of raw.conditions) {
    for (const session of condition.sessions) {
      if (session.status !== 'ok') continue;
      const where = `${condition.id} session ${session.index + 1} (arm ${session.arm})`;
      if (session.info === null) problems.push(`${where}: the page did not say which configuration it ran`);
      else if (session.info.config !== session.config)
        problems.push(
          `${where}: the page ran configuration ${session.info.config}, the arm needs ${session.config}`,
        );
      else if (canonicalJson(session.info.configOverrides) !== canonicalJson(configFor(session.config)))
        problems.push(
          `${where}: the overrides the page applied are not those of configuration ${session.config}`,
        );
      else if (session.info.loadMode !== 'media-source')
        problems.push(
          `${where}: the player did not play through Media Source Extensions (${String(session.info.loadMode)})`,
        );
      else proved += 1;
    }
  }
  return {
    id: 'configuration',
    title: 'Configuration proved',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${proved} finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions.`
        : first(problems),
  };
}

function conditionGate(raw: RawResult): Gate {
  const problems: string[] = [];
  let proved = 0;
  let requests: number[] = [];
  let firedMin = Number.POSITIVE_INFINITY;
  for (const condition of raw.conditions) {
    if (condition.rules.length === 0) {
      proved += condition.sessions.filter((session) => session.status === 'ok').length;
      continue;
    }
    for (const session of condition.sessions) {
      if (session.status !== 'ok') continue;
      const where = `${condition.id} session ${session.index + 1} (arm ${session.arm})`;
      const applied = session.applied;
      if (applied === undefined)
        problems.push(`${where}: the service was not asked what it held for the session`);
      else if (!applied.rulesMatch)
        problems.push(`${where}: the service held other rules than the registered ones`);
      else if (applied.fired.length !== condition.rules.length)
        problems.push(
          `${where}: the service reported ${applied.fired.length} rules, the condition has ${condition.rules.length}`,
        );
      else if (applied.fired.some((count) => count < 1))
        problems.push(
          `${where}: rule ${applied.fired.findIndex((count) => count < 1) + 1} of ${condition.rules.length} never fired on any of ${applied.requests} requests, so the condition was not applied`,
        );
      else {
        proved += 1;
        requests.push(applied.requests);
        firedMin = Math.min(firedMin, ...applied.fired);
      }
    }
  }
  requests = requests.length === 0 ? [0] : requests;
  return {
    id: 'condition',
    title: 'Condition applied, the same in both arms',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${proved} finished sessions: the service held exactly the registered rules, and every rule fired on at least ${Number.isFinite(firedMin) ? firedMin : 0} requests of the session (${Math.min(...requests)} to ${Math.max(...requests)} requests per session); both arms were created with the same rules.`
        : first(problems),
  };
}

function failuresGate(analysis: ResultAnalysis): Gate {
  const problems = analysis.conditions
    .filter((entry) => entry.analysis.failures.guardTripped)
    .map((entry) => `${entry.result.id}: ${entry.analysis.failures.guardWhy ?? 'the failure guard tripped'}`);
  const failed = analysis.conditions.reduce(
    (sum, entry) => sum + entry.analysis.failures.failedA + entry.analysis.failures.failedB,
    0,
  );
  const attempted = analysis.conditions.reduce(
    (sum, entry) => sum + entry.analysis.failures.attemptedA + entry.analysis.failures.attemptedB,
    0,
  );
  return {
    id: 'failures',
    title: 'Failures few and even',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${failed} of ${attempted} measured sessions failed (reported, never dropped): under the pre-registered maximum of ${Math.round(analysis.prereg.exclusionRule.maxFailedShare * 100)} % of an arm, and the arms failed alike.`
        : first(problems),
  };
}

function machineGate(raw: RawResult, plan: Preregistration): Gate {
  const cpus = raw.environment.host.cpus;
  const limit = cpus * BUSY_LOAD_SHARE;
  const before = raw.conditions[0]?.loadAverage.before ?? 0;
  const passed = before <= limit;
  const enforced = plan.kind !== 'pipeline-check';
  return {
    id: 'machine',
    title: 'Machine quiet at the start',
    passed,
    ...(enforced ? {} : { enforced }),
    detail: passed
      ? `The 1-minute load average was ${before.toFixed(1)} before the first session, on ${cpus} CPUs (the limit is ${BUSY_LOAD_SHARE * 100} % of them, ${limit.toFixed(1)}).`
      : `The 1-minute load average was ${before.toFixed(1)} before the first session, on ${cpus} CPUs, above ${BUSY_LOAD_SHARE * 100} % of them (${limit.toFixed(1)}): another job was running, and the sessions of both arms shared the machine with it${enforced ? '' : '. Not enforced for a pipeline check, which runs on whatever machine there is'}.`,
  };
}

interface AaReportShape {
  kind?: unknown;
  experiment?: { kind?: unknown };
  environment?: { envId?: unknown };
  design?: { engine?: unknown };
  validity?: { valid?: unknown };
  conditions?: Array<{ id?: unknown; aa?: { acceptable?: unknown } | null }>;
  calibrations?: Array<{ condition?: unknown; result?: { pass?: unknown } }>;
}

/** Whether the committed report of an A/A run says the harness passed its own check for this engine, environment and condition. */
export function checkAaReport(
  text: string | null,
  source: string,
  plan: Pick<Preregistration, 'engine' | 'conditions'>,
  envId: string,
): { passed: boolean; detail: string } {
  if (text === null)
    return {
      passed: false,
      detail: `The A/A report ${source} is not there: an experiment relies on the harness having passed its own check (PB-AB-001) in this environment, so run the A/A first and commit its report.`,
    };
  let report: AaReportShape;
  try {
    report = JSON.parse(text) as AaReportShape;
  } catch {
    return { passed: false, detail: `The A/A report ${source} is not valid JSON.` };
  }
  const problems: string[] = [];
  if (report.kind !== 'ab-report' || report.experiment?.kind !== 'aa')
    problems.push('it is not the report of an A/A run');
  if (report.environment?.envId !== envId)
    problems.push(
      `it was measured in ${String(report.environment?.envId)}, this run is in ${envId}: the check is per environment`,
    );
  if (report.design?.engine !== plan.engine)
    problems.push(`it checked the harness on ${String(report.design?.engine)}, this run uses ${plan.engine}`);
  if (report.validity?.valid !== true) problems.push('the A/A run itself was not valid');
  for (const condition of plan.conditions) {
    const reading = report.conditions?.find((candidate) => candidate.id === condition.id);
    const calibration = report.calibrations?.find((candidate) => candidate.condition === condition.id);
    if (reading === undefined) problems.push(`it has no A/A run of the condition ${condition.id}`);
    else if (reading.aa?.acceptable !== true)
      problems.push(`its real interleaved A/A of ${condition.id} did not pass`);
    if (calibration === undefined) problems.push(`it has no A/A calibration of ${condition.id}`);
    else if (calibration.result?.pass !== true)
      problems.push(`its A/A calibration of ${condition.id} did not pass`);
  }
  return {
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${source}: the real interleaved A/A and its calibration passed for ${plan.conditions.map((c) => c.id).join(', ')} on ${plan.engine} in ${envId}.`
        : `${source}: ${problems.join('; ')}.`,
  };
}

function aaGate(raw: RawResult, plan: Preregistration, context: ValidityContext): Gate | null {
  if (plan.aaCheck === null) return null;
  const outcome = checkAaReport(
    context.readReference?.(plan.aaCheck.source) ?? null,
    plan.aaCheck.source,
    plan,
    raw.environment.envId,
  );
  return { id: 'aa-check', title: 'A/A check passed (PB-AB-001)', ...outcome };
}

/** Applies the gates to a run. */
export function assessValidity(
  raw: RawResult,
  analysis: ResultAnalysis,
  context: ValidityContext = {},
): Validity {
  const plan = analysis.prereg;
  const gates = [
    preregistrationGate(raw),
    designGate(raw, plan),
    configurationGate(raw),
    conditionGate(raw),
    failuresGate(analysis),
    machineGate(raw, plan),
    aaGate(raw, plan, context),
  ].filter((gate): gate is Gate => gate !== null);
  const failed = gates.filter((gate) => gate.enforced !== false && !gate.passed);
  const valid = failed.length === 0;
  const evidence = valid && plan.kind !== 'pipeline-check';
  const notEnforced = gates.filter((gate) => gate.enforced === false && !gate.passed);
  let summary: string;
  if (plan.kind === 'pipeline-check')
    summary = valid
      ? `Plumbing checks passed (${gates.length - notEnforced.length} of ${gates.length}${notEnforced.length > 0 ? `; not enforced for a pipeline check: ${notEnforced.map((gate) => gate.title).join(', ')}` : ''}). This is a pipeline check, plumbing only, not evidence.`
      : `Plumbing checks FAILED: ${failed.map((gate) => gate.title).join(', ')}. This is a pipeline check, plumbing only, not evidence.`;
  else
    summary = valid
      ? `VALID: the experiment was run as pre-registered, on data that pass all ${gates.length} gates. The direction of the result does not enter: it drives the decision named for the row.`
      : `NOT VALID: ${failed.map((gate) => gate.title).join(', ')}. The verdict below must not be acted on, whichever way it points.`;
  return { valid, evidence, gates, summary };
}
