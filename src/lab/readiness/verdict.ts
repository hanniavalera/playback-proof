import type { LIVE_LIMITS } from '../../shared/criteria.ts';

// What every readiness evaluator returns (docs/decisions/readiness.md, ADR-150): the measured value, the limit it was held to, the
// verdict and the sentence a go/no-go sheet prints. Pure data: an evaluation can be written to a result file, read back, rendered on
// a checklist and compared between runs without a browser.

/**
 * `GO` and `NO-GO` are verdicts on the build. `INCONCLUSIVE` is not one: the run could not judge (too few samples, a soak shorter than
 * the policy asks for, an injected fault that never reached the player), and a sheet must never read it as a pass. `N/A` is a criterion
 * that does not apply here (the JS heap outside Chromium).
 */
export type Verdict = 'GO' | 'NO-GO' | 'INCONCLUSIVE' | 'N/A';

export type CheckId = 'PB-RDY-001' | 'PB-RDY-002' | 'PB-RDY-003' | 'PB-RDY-004' | 'PB-RDY-005';

export type ValueUnit = 'ms' | 'ratio' | 'count' | 'MB' | 'min';

/** The key of `LIVE_LIMITS` that an evaluation was judged against, so that a revision of the policy is traceable in a result file. */
export type LimitKey = keyof typeof LIVE_LIMITS;

/** `at-most`: the value must not exceed the limit (a time, a ratio). `at-least`: it must reach it (the shortest median gap, a soak length). */
export type Bound = 'at-most' | 'at-least';

/** The limits an evaluator reads. Production code never passes any: the default is the policy of `src/shared/criteria.ts`. */
export type Limits = typeof LIVE_LIMITS;

export interface Evaluation {
  /** A stable key: `start.worst`, `latency.p95`, `stall.recovery`... */
  id: string;
  check: CheckId;
  /** What the checklist line says it is. */
  label: string;
  /** The measured value; null when nothing could be measured. When `censored` the true value is at least this. */
  value: number | null;
  unit: ValueUnit;
  /** The limit the value was held to. */
  limit: number;
  bound: Bound;
  limitKey: LimitKey;
  verdict: Verdict;
  /** The sentence a go/no-go sheet prints: the number, the limit, and what it means. */
  sentence: string;
  /**
   * `criterion`: counts towards the verdict of its check. `advisory`: reported with a verdict of its own, because it is evidence a reader
   * wants next to the criteria, but it is not one of them (it does not decide).
   */
  scope: 'criterion' | 'advisory';
  /** The value is a lower bound: the player never got back, so what was measured is how long the observation lasted. */
  censored?: true;
  /** What else a reader needs to check the number (counts, the worst run, the fitted line). JSON-serialisable. */
  detail?: Record<string, unknown>;
  /**
   * What a reader should know about this line even when it is a GO, which a sheet prints without a verdict and apart from the sentence of
   * the lines that are not (two estimators of the same number that disagree, a line whose verdict hangs on a choice).
   */
  note?: string;
}

/** The comparison every limit goes through. The limit is inclusive: a value exactly at the limit is within it. */
export function judge(value: number, limit: number, bound: Bound): 'GO' | 'NO-GO' {
  const within = bound === 'at-most' ? value <= limit : value >= limit;
  return within ? 'GO' : 'NO-GO';
}

/**
 * The verdict of a set of evaluations: any criterion that is NO-GO makes it NO-GO (a defect is a defect even if another line could not be
 * judged); otherwise any that is INCONCLUSIVE makes it INCONCLUSIVE; GO needs at least one criterion judged GO. Advisory lines and
 * criteria that do not apply (N/A) never decide.
 */
export function aggregate(evaluations: readonly Evaluation[]): Verdict {
  const deciding = evaluations.filter((evaluation) => evaluation.scope === 'criterion');
  if (deciding.some((evaluation) => evaluation.verdict === 'NO-GO')) return 'NO-GO';
  if (deciding.some((evaluation) => evaluation.verdict === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  if (deciding.some((evaluation) => evaluation.verdict === 'GO')) return 'GO';
  return 'INCONCLUSIVE';
}

/**
 * The verdict of a set of verdicts: NO-GO if any is, otherwise INCONCLUSIVE if any is (or there is none), otherwise GO. For a run's
 * configurations and for a configuration's checks, whose verdicts have been decided already.
 */
export function worstOf(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes('NO-GO')) return 'NO-GO';
  if (verdicts.length === 0 || verdicts.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return verdicts.includes('GO') ? 'GO' : 'INCONCLUSIVE';
}

// ---------------------------------------------------------------------------------------------------------------------
// Words and numbers for sentences

const thousands = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `6.21 s` for a time of a second or more, `850 ms` below. Latencies and limits read the same way in every sentence. */
export function formatMs(ms: number): string {
  return Math.abs(Math.round(ms)) >= 1000
    ? `${(ms / 1000).toFixed(2)} s`
    : `${thousands.format(Math.round(ms))} ms`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)} %`;
}

export function formatValue(value: number, unit: ValueUnit): string {
  switch (unit) {
    case 'ms':
      return formatMs(value);
    case 'ratio':
      return formatPercent(value);
    case 'MB':
      return `${value.toFixed(1)} MB`;
    case 'min':
      return `${Number(value.toFixed(2))} min`;
    case 'count':
      return thousands.format(value);
  }
}

export function formatLimit(limit: number, unit: ValueUnit, bound: Bound): string {
  return `${bound === 'at-most' ? '<=' : '>='} ${formatValue(limit, unit)}`;
}

/** `1 join`, `5 joins`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface EvaluationInput {
  id: string;
  check: CheckId;
  label: string;
  value: number | null;
  unit: ValueUnit;
  limitKey: LimitKey;
  bound: Bound;
  limits: Limits;
  scope?: Evaluation['scope'];
  censored?: true;
  detail?: Record<string, unknown>;
  note?: string;
  /** The sentence, given the verdict and the value in words (`value` is null: the text says why). */
  sentence: (context: { verdict: Verdict; value: string; limit: string }) => string;
  /** Overrides the judgement: a line that cannot be judged says why in its own sentence. */
  verdict?: Verdict;
}

/** Builds an evaluation: judges the value against the limit of its key, unless the caller says it cannot be judged. */
export function evaluation(input: EvaluationInput): Evaluation {
  const limit = input.limits[input.limitKey];
  const verdict: Verdict =
    input.verdict ?? (input.value === null ? 'INCONCLUSIVE' : judge(input.value, limit, input.bound));
  const unit = input.unit;
  const valueText =
    input.value === null
      ? 'not measured'
      : `${input.censored ? 'at least ' : ''}${formatValue(input.value, unit)}`;
  const limitText = formatLimit(limit, unit, input.bound);
  return {
    id: input.id,
    check: input.check,
    label: input.label,
    value: input.value,
    unit,
    limit,
    bound: input.bound,
    limitKey: input.limitKey,
    verdict,
    sentence: input.sentence({ verdict, value: valueText, limit: limitText }),
    scope: input.scope ?? 'criterion',
    ...(input.censored ? { censored: true as const } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}
