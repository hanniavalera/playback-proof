import { classify } from './rules.ts';
import { failureSignature } from './signature.ts';
import type { Cluster, ClusterMember, Failure, FailureClass, FailureOutcome } from './types.ts';

// The deterministic clustering (docs/TRIAGE.md, ADR-160): failures with the same signature are one cluster, the clusters are ordered by what a
// reader needs first, and each cluster is described by one representative failure that a rule table then reads. Nothing here depends on the
// order the failures arrived in, on ids, on timestamps or on a clock: the same failures give the same clusters in the same order
// (`tests/unit/triage/cluster.test.ts` shuffles and renames to prove it). A string comparison is a plain code-unit comparison, never a locale's.

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How much a failure can say: the lab attachments it carries. The richest failure of a cluster describes it. */
const richness = (failure: Failure): number => failure.diagnostics.attached.length;

/** A total order on failures that depends on nothing but what they say: the richest first, then by engine, test and report. */
export function compareFailures(a: Failure, b: Failure): number {
  return (
    richness(b) - richness(a) ||
    compareText(a.project, b.project) ||
    compareText(a.id, b.id) ||
    compareText(a.title, b.title) ||
    compareText(a.source, b.source) ||
    a.attempt - b.attempt ||
    compareText(a.error.message, b.error.message)
  );
}

const FLAKE_ADVICE =
  'Do not rerun the job: it passed on the retry, and a retried pass is not a pass. Read the trace of the first failed attempt, not the green retry. ';

/** Failures that all passed on a retry are a flake whatever they are about, unless the rule already names the environment or a gap. */
function classOf(failures: readonly Failure[], ruleClass: FailureClass): FailureClass {
  const flakyOnly = failures.every((failure) => failure.outcome === 'flaky');
  const keeps: FailureClass[] = ['Environment or infrastructure', 'Known gap', 'Flake'];
  return flakyOnly && !keeps.includes(ruleClass) ? 'Flake' : ruleClass;
}

function memberOf(failure: Failure): ClusterMember {
  return { id: failure.id, project: failure.project, outcome: failure.outcome, source: failure.source };
}

const compareMembers = (a: ClusterMember, b: ClusterMember): number =>
  compareText(a.id, b.id) || compareText(a.project, b.project) || compareText(a.source, b.source);

function build(signature: ReturnType<typeof failureSignature>, failures: Failure[]): Cluster {
  const sorted = [...failures].sort(compareFailures);
  const representative = sorted[0] as Failure;
  const verdict = classify(representative);
  const others = new Set<string>();
  let sameRule = 0;
  for (const failure of sorted) {
    const rule = classify(failure).verdict.rule;
    if (rule === verdict.verdict.rule) sameRule += 1;
    else others.add(rule);
  }
  const outcomes: Record<FailureOutcome, number> = { failed: 0, timedOut: 0, flaky: 0 };
  for (const failure of failures) outcomes[failure.outcome] += 1;
  const failureClass = classOf(failures, verdict.failureClass);
  return {
    rank: 0,
    key: signature.key,
    signature: signature.signature,
    parts: signature.parts,
    size: failures.length,
    tests: [...new Set(failures.map((failure) => failure.id))].sort(compareText),
    projects: [...new Set(failures.map((failure) => failure.project))].sort(compareText),
    outcomes,
    category: verdict.verdict.category,
    rule: verdict.verdict,
    ruleRationale: verdict.rationale,
    failureClass,
    firstCheck:
      failureClass === 'Flake' && verdict.failureClass !== 'Flake'
        ? `${FLAKE_ADVICE}${verdict.firstCheck}`
        : verdict.firstCheck,
    agreement: { sameRule, of: failures.length, otherRules: [...others].sort(compareText) },
    representative,
    members: failures.map(memberOf).sort(compareMembers),
  };
}

/**
 * The clusters of a list of failures, largest first (then the one seen in more engines, then by signature), ranked from 1. The order of
 * `failures` does not matter.
 */
export function cluster(failures: readonly Failure[]): Cluster[] {
  const groups = new Map<string, { signature: ReturnType<typeof failureSignature>; failures: Failure[] }>();
  for (const failure of failures) {
    const signature = failureSignature(failure);
    const group = groups.get(signature.signature);
    if (group) group.failures.push(failure);
    else groups.set(signature.signature, { signature, failures: [failure] });
  }
  const clusters = [...groups.values()].map((group) => build(group.signature, group.failures));
  clusters.sort(
    (a, b) =>
      b.size - a.size || b.projects.length - a.projects.length || compareText(a.signature, b.signature),
  );
  return clusters.map((one, index) => ({ ...one, rank: index + 1 }));
}
