import { classify } from './rules.ts';
import { failureSignature, signatureKey } from './signature.ts';
import type {
  Cluster,
  ClusterMember,
  Failure,
  FailureClass,
  FailureOutcome,
  RootCause,
  RuleVerdict,
} from './types.ts';

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
    rootCause: rootCauseKey(verdict.verdict, signature.signature),
  };
}

/** A root cause is the category, the rule and the cause; a rule that only describes a symptom has none, so its cluster stands alone. */
const rootCauseKey = (verdict: RuleVerdict, signature: string): string =>
  signatureKey(`${verdict.category}\n${verdict.rule}\n${verdict.cause ?? `symptom ${signature}`}`);

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

/**
 * The root causes of a list of clusters, largest first (then the one seen in more engines, then by key), ranked from 1. Clusters that fired
 * the same rule for the same cause are one root cause; a cluster whose rule only describes a symptom is its own. Pure: it depends on the
 * clusters and their ranks, not on the order they are given in.
 */
export function rootCauses(clusters: readonly Cluster[]): RootCause[] {
  const groups = new Map<string, Cluster[]>();
  for (const one of [...clusters].sort((a, b) => a.rank - b.rank)) {
    groups.set(one.rootCause, [...(groups.get(one.rootCause) ?? []), one]);
  }
  const causes = [...groups.entries()].map(([key, members]): RootCause => {
    const first = members[0] as Cluster;
    return {
      rank: 0,
      key,
      category: first.category,
      rule: first.rule.rule,
      cause: first.rule.cause,
      size: members.reduce((sum, one) => sum + one.size, 0),
      clusters: members.map((one) => one.key),
      clusterRanks: members.map((one) => one.rank),
      tests: [...new Set(members.flatMap((one) => one.tests))].sort(compareText),
      projects: [...new Set(members.flatMap((one) => one.projects))].sort(compareText),
      failureClass: first.failureClass,
    };
  });
  causes.sort(
    (a, b) => b.size - a.size || b.projects.length - a.projects.length || compareText(a.key, b.key),
  );
  return causes.map((one, index) => ({ ...one, rank: index + 1 }));
}
