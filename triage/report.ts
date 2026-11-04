import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootCauses } from './cluster.ts';
import { readableFirstLine } from './signature.ts';
import { DEFAULT_BASE_URL } from './summarize.ts';
import type { SummaryResult } from './summarize.ts';
import { oneLine, plural, truncate } from './text.ts';
import { CATEGORY_MEANING } from './rules.ts';
import { REPORT_SCHEMA_VERSION } from './types.ts';
import type { Cluster, Collection, RootCause, SkippedTest, SummaryRecord, TriageReport } from './types.ts';

// The writers of a triage report: the console text, `triage-report.md`, `triage-report.json` and the summary of a CI job. They only
// format what the clustering and the summarizer produced; nothing here decides anything.

export const NOT_A_GATE = 'triage is not a gate: it explains a red build and never decides one';
export const NO_FAILURES = 'no failures to triage';
export const REPORT_FILES = { markdown: 'triage-report.md', json: 'triage-report.json' } as const;

const MAX_MEMBERS_LISTED = 30;
const MAX_MESSAGE_LINES = 15;
const SUMMARY_CLUSTERS = 12;

export interface BuildOptions {
  /** The directory as the person gave it. */
  from: string;
  now?: Date;
  /** What `summarize` returned, when it was asked for. */
  summaries?: SummaryResult | null;
  /** Why there are no summaries although they were asked for (no key). */
  summaryNote?: string | null;
}

export function buildReport(
  collection: Collection,
  clusters: readonly Cluster[],
  options: BuildOptions,
): TriageReport {
  const failed = collection.failures.filter((failure) => failure.outcome !== 'flaky').length;
  const result = options.summaries ?? null;
  const causes = rootCauses(clusters);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    from: options.from,
    sources: collection.sources,
    totals: {
      failures: failed,
      flaky: collection.failures.length - failed,
      clusters: clusters.length,
      rootCauses: causes.length,
      skipped: collection.skipped.length,
      notRun: collection.sources.reduce((sum, source) => sum + source.notRun, 0),
      interrupted: collection.sources.reduce((sum, source) => sum + source.interrupted, 0),
    },
    clusters: [...clusters],
    rootCauses: causes,
    skipped: collection.skipped,
    problems: collection.problems,
    summaries: result?.records ?? [],
    summaryNote: options.summaryNote ?? result?.note ?? null,
    summaryRun: result
      ? {
          model: result.model,
          endpoint: result.endpoint,
          requests: result.requests,
          cacheHits: result.cacheHits,
          usage: usageOf(result.records),
        }
      : null,
  };
}

/** The tokens the service reported for the drafts written in this run: what a person reads to learn what the run cost. */
function usageOf(records: readonly SummaryRecord[]): { inputTokens: number; outputTokens: number } | null {
  const written = records.filter((record) => record.status === 'summarized' && record.usage !== undefined);
  if (written.length === 0) return null;
  return {
    inputTokens: written.reduce((sum, record) => sum + (record.usage?.inputTokens ?? 0), 0),
    outputTokens: written.reduce((sum, record) => sum + (record.usage?.outputTokens ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pieces

const cell = (text: string, max = 160): string =>
  oneLine(text, max).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A code fence that no line of the text can close. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

const summaryOf = (report: TriageReport, cluster: Cluster): SummaryRecord | undefined =>
  report.summaries.find((summary) => summary.clusterKey === cluster.key);

function listTests(tests: readonly string[], max = 6): string {
  return tests.length <= max ? tests.join(', ') : `${tests.slice(0, max).join(', ')} +${tests.length - max}`;
}

export function messageHead(cluster: Cluster): string {
  const lines = cluster.representative.error.message
    .split(/\r?\n/)
    .map((line) => truncate(line.trimEnd(), 300));
  const kept = lines.slice(0, MAX_MESSAGE_LINES);
  return lines.length > kept.length
    ? `${kept.join('\n')}\n... (${lines.length - kept.length} more lines)`
    : kept.join('\n');
}

/** What the draft is and where it came from, so that a mock is never read as the service. */
function draftLabel(report: TriageReport, record: SummaryRecord): string {
  const run = report.summaryRun;
  const model = record.model ?? run?.model ?? 'a model';
  const live = run === null || run.endpoint === DEFAULT_BASE_URL;
  const where =
    record.status === 'cached'
      ? 'from the cache'
      : live
        ? 'live service'
        : `endpoint ${run.endpoint}, NOT the live service`;
  return `model draft (${model}, ${where}): a suggestion for a person, never a verdict`;
}

function skippedByReason(
  skipped: readonly SkippedTest[],
): Array<{ reason: string | null; tests: string[]; projects: string[]; count: number }> {
  const groups = new Map<
    string,
    { reason: string | null; tests: Set<string>; projects: Set<string>; count: number }
  >();
  for (const skip of skipped) {
    const key = skip.reason ?? '\u0000';
    const group = groups.get(key) ?? {
      reason: skip.reason,
      tests: new Set<string>(),
      projects: new Set<string>(),
      count: 0,
    };
    group.tests.add(skip.id);
    group.projects.add(skip.project);
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.reason ?? '').localeCompare(b.reason ?? ''))
    .map((group) => ({
      reason: group.reason,
      tests: [...group.tests].sort(),
      projects: [...group.projects].sort(),
      count: group.count,
    }));
}

function headline(report: TriageReport): string {
  const { failures, flaky, clusters, rootCauses: causes } = report.totals;
  const reports = plural(report.sources.length, 'report');
  return `${failures} failed${flaky > 0 ? `, ${flaky} flaky` : ''} in ${reports} became ${plural(clusters, 'cluster')}${causes < clusters ? ` of ${plural(causes, 'root cause')}` : ''}`;
}

/** The root causes that more than one cluster shares: the others say nothing a cluster does not. */
const sharedCauses = (report: TriageReport): RootCause[] =>
  report.rootCauses.filter((cause) => cause.clusters.length > 1);

const ranks = (cause: RootCause): string => cause.clusterRanks.map((rank) => `#${rank}`).join(', ');

/** The root cause of a cluster when other clusters share it, else null. */
const sharedWith = (report: TriageReport, cluster: Cluster): RootCause | null =>
  sharedCauses(report).find((cause) => cause.key === cluster.rootCause) ?? null;

// ---------------------------------------------------------------------------------------------------------------------
// The console

export function renderText(
  report: TriageReport,
  options: { fromCi?: boolean; wrote?: string[] } = {},
): string {
  const lines: string[] = [];
  if (options.fromCi) lines.push(`gate:triage: ${NOT_A_GATE} (exit 0 whatever it finds)`);
  if (report.clusters.length === 0) {
    lines.push(NO_FAILURES);
    const read = report.sources.reduce((sum, source) => sum + source.tests, 0);
    if (report.sources.length > 0) {
      const skipped = report.skipped.length;
      lines.push(
        `read ${plural(report.sources.length, 'report')}: ${plural(read, 'test')}${skipped > 0 ? `, ${skipped} skipped` : ''}`,
      );
    }
  } else {
    lines.push(
      `failure triage: ${headline(report)} (clustering is deterministic: no model is involved in it)`,
      '',
    );
    for (const cause of sharedCauses(report)) {
      lines.push(
        `root cause: ${cause.cause ?? cause.rule} (${plural(cause.size, 'failure')} in the clusters ${ranks(cause)}: one cause, worded differently by each test)`,
      );
    }
    if (sharedCauses(report).length > 0) lines.push('');
    for (const cluster of report.clusters) {
      const rep = cluster.representative;
      const shared = sharedWith(report, cluster);
      lines.push(
        `#${cluster.rank}  ${plural(cluster.size, 'failure')} in ${cluster.projects.join(', ')}  ·  ${listTests(cluster.tests)}`,
        `    category  ${cluster.category}  (rule ${cluster.rule.rule})  ·  class ${cluster.failureClass}`,
        ...(shared
          ? [
              `    root cause shared with ${shared.clusterRanks
                .filter((rank) => rank !== cluster.rank)
                .map((rank) => `#${rank}`)
                .join(', ')}`,
            ]
          : []),
        `    signature ${cluster.signature}`,
        `    error     ${oneLine(readableFirstLine(rep.error.message), 200)}`,
        ...cluster.rule.evidence.slice(0, 4).map((line) => `    evidence  ${oneLine(line, 200)}`),
        `    first     ${oneLine(cluster.firstCheck, 260)}`,
      );
      const summary = summaryOf(report, cluster);
      if (summary?.text)
        lines.push(
          `    draft     [${draftLabel(report, summary)}]`,
          ...summary.text.split('\n').map((line) => `              ${line}`),
        );
      else if (summary?.note) lines.push(`    draft     (none: ${oneLine(summary.note, 200)})`);
      lines.push('');
    }
  }
  if (report.totals.skipped > 0 && report.clusters.length > 0) {
    lines.push(
      `skipped: ${plural(report.totals.skipped, 'test')} with a reason (documented gaps), listed in ${REPORT_FILES.markdown}`,
    );
  }
  if (report.totals.interrupted > 0)
    lines.push(
      `interrupted: ${plural(report.totals.interrupted, 'test')}, which the run stopped on, not clustered`,
    );
  if (report.totals.notRun > 0)
    lines.push(
      `not run: ${plural(report.totals.notRun, 'test')} with no attempt (a listing, or a run stopped before them): neither failures nor skips`,
    );
  for (const problem of report.problems) lines.push(`problem: ${problem}`);
  if (report.summaryNote) lines.push(report.summaryNote);
  if (options.wrote && options.wrote.length > 0) lines.push(`wrote ${options.wrote.join(' and ')}`);
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown

function clusterSection(report: TriageReport, cluster: Cluster): string[] {
  const rep = cluster.representative;
  const shared = sharedWith(report, cluster);
  const others = shared?.clusterRanks.filter((rank) => rank !== cluster.rank).map((rank) => `#${rank}`);
  const out: string[] = [
    `## #${cluster.rank} · ${plural(cluster.size, 'failure')} · ${cluster.category}`,
    '',
    `- **Signature** \`${cluster.signature.replace(/`/g, "'")}\` (key \`${cluster.key}\`)`,
    `- **Engines** ${cluster.projects.join(', ')} · **tests** ${listTests(cluster.tests, 12)} · **outcomes** failed ${cluster.outcomes.failed}, timed out ${cluster.outcomes.timedOut}, flaky ${cluster.outcomes.flaky}`,
    `- **Category** \`${cluster.category}\`: ${CATEGORY_MEANING[cluster.category]}`,
    `- **Rule** \`${cluster.rule.rule}\`: ${cluster.ruleRationale}`,
    ...(others
      ? [`- **Root cause** shared with the clusters ${others.join(', ')}: ${cluster.rule.cause}`]
      : []),
    `- **Class** ${cluster.failureClass} (TEST_STRATEGY.md section 10)`,
    '- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):',
    ...cluster.rule.evidence.map((line) => `  - ${oneLine(line, 400)}`),
    `- **First thing to check** ${cluster.firstCheck}`,
  ];
  if (cluster.agreement.sameRule < cluster.agreement.of) {
    out.push(
      `- **Rule agreement** the rule fired for ${cluster.agreement.sameRule} of ${cluster.agreement.of} failures of the cluster; the others fired ${cluster.agreement.otherRules.map((name) => `\`${name}\``).join(', ')} (the representative has the most attachments)`,
    );
  }
  out.push(
    `- **Representative failure** ${rep.id} on ${rep.project}: ${rep.outcome}, ${plural(rep.attempts, 'attempt')} of ${rep.retries + 1}${rep.tier ? `, ${rep.tier} tier` : ''}${rep.envId ? `, ${rep.envId}` : ''}, from \`${rep.source}\``,
    '',
    fenced(messageHead(cluster)),
    '',
  );
  if (rep.error.frames.length > 0) {
    out.push(
      `Frames of the lab's own code: ${rep.error.frames.map((f) => `\`${f.file}${f.line ? `:${f.line}` : ''}${f.fn ? ` ${f.fn}` : ''}\``).join(' ← ')}`,
      '',
    );
  }
  if (rep.missing.length > 0)
    out.push(`Could not be read: ${rep.missing.map((m) => oneLine(m, 200)).join('; ')}`, '');
  if (cluster.members.length > 1) {
    out.push('| Test | Engine | Outcome | Report |', '| --- | --- | --- | --- |');
    for (const member of cluster.members.slice(0, MAX_MEMBERS_LISTED)) {
      out.push(
        `| ${cell(member.id)} | ${cell(member.project)} | ${member.outcome} | ${cell(member.source)} |`,
      );
    }
    if (cluster.members.length > MAX_MEMBERS_LISTED)
      out.push(`| … | | | ${cluster.members.length - MAX_MEMBERS_LISTED} more |`);
    out.push('');
  }
  const summary = summaryOf(report, cluster);
  if (summary?.text) {
    out.push(
      `**${draftLabel(report, summary)}**`,
      '',
      ...summary.text.split('\n').map((line) => `> ${line}`),
      '',
    );
    if (summary.note) out.push(`_${summary.note}_`, '');
  } else if (summary?.note) {
    out.push(`_No model draft for this cluster: ${oneLine(summary.note, 300)}_`, '');
  }
  return out;
}

export function renderMarkdown(report: TriageReport): string {
  const out: string[] = ['# Failure triage', ''];
  if (report.clusters.length === 0) {
    out.push(
      `**${NO_FAILURES}.** ${report.sources.length > 0 ? `${plural(report.sources.length, 'report')} read.` : 'No report was read.'}`,
      '',
    );
  } else {
    out.push(
      `**${headline(report)}.** The clusters are deterministic (one signature, one cluster: the same cause whatever its ids, ports and timestamps); the category is the first rule of a table that fits, with the evidence it found. ${NOT_A_GATE}.`,
      '',
      '| # | Failures | Engines | Tests | Category · rule | Class | Error |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...report.clusters.map(
        (c) =>
          `| ${c.rank} | ${c.size} | ${cell(c.projects.join(', '))} | ${cell(listTests(c.tests, 4))} | \`${c.category}\` · \`${c.rule.rule}\` | ${c.failureClass} | ${cell(readableFirstLine(c.representative.error.message), 120)} |`,
      ),
      '',
    );
    if (sharedCauses(report).length > 0) {
      out.push(
        '## Root causes shared by several clusters',
        '',
        'A cluster is one signature, which is the words of one failure. When the same rule found the same cause behind several clusters, the tests worded one cause in several ways; they are listed here as one.',
        '',
        '| Root cause | Failures | Clusters | Engines | Tests | Category · rule | What is broken |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...sharedCauses(report).map(
          (c) =>
            `| ${c.rank} | ${c.size} | ${ranks(c)} | ${cell(c.projects.join(', '))} | ${cell(listTests(c.tests, 6))} | \`${c.category}\` · \`${c.rule}\` | ${cell(c.cause ?? '', 200)} |`,
        ),
        '',
      );
    }
    for (const cluster of report.clusters) out.push(...clusterSection(report, cluster));
  }
  if (report.skipped.length > 0) {
    out.push(
      '## Skipped tests (not failures)',
      '',
      '| Tests skipped | Engines | Tests | Reason |',
      '| --- | --- | --- | --- |',
    );
    for (const group of skippedByReason(report.skipped)) {
      out.push(
        `| ${group.count} | ${cell(group.projects.join(', '))} | ${cell(listTests(group.tests, 4))} | ${group.reason === null ? '**no reason: a silent skip is a bug**' : cell(group.reason, 300)} |`,
      );
    }
    out.push('');
  }
  if (report.totals.interrupted > 0) {
    out.push(
      `${plural(report.totals.interrupted, 'test')} were interrupted (the run was stopped before they finished) and are not clustered.`,
      '',
    );
  }
  if (report.totals.notRun > 0) {
    out.push(
      `${plural(report.totals.notRun, 'test')} did not run: they have no attempt at all (the report is of a listing, or the run was stopped before they started). They are neither failures nor skips.`,
      '',
    );
  }
  if (report.problems.length > 0)
    out.push('## What could not be read', '', ...report.problems.map((p) => `- ${oneLine(p, 400)}`), '');
  out.push('## Reports read', '');
  if (report.sources.length === 0) out.push('None.', '');
  else {
    out.push(
      '| Report | Tests | Passed | Failed | Flaky | Skipped | Not run | Interrupted | Run errors |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const s of report.sources) {
      out.push(
        `| ${cell(s.path)} | ${s.tests} | ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} | ${s.notRun} | ${s.interrupted} | ${s.runErrors} |`,
      );
    }
    out.push('');
  }
  out.push('---', '');
  if (report.summaryRun) {
    const { model, endpoint, requests, cacheHits, usage } = report.summaryRun;
    const live = endpoint === DEFAULT_BASE_URL;
    out.push(
      `Model summaries: ${model} through ${endpoint}${live ? '' : ' (**not the live service**: a local test double)'}; ${plural(requests, 'request')} sent, ${plural(cacheHits, 'draft')} from the cache.${usage ? ` The service reported ${usage.inputTokens} input and ${usage.outputTokens} output tokens for the drafts of this run.` : ''}`,
    );
  } else {
    out.push(
      'No model summaries: they are opt-in (`npm run triage -- --summarize`, with `ANTHROPIC_API_KEY`).',
    );
  }
  if (report.summaryNote) out.push('', `_${report.summaryNote}_`);
  out.push(
    '',
    `Generated ${report.generatedAt} from \`${report.from}\` by \`triage/\` (docs/TRIAGE.md).`,
    '',
  );
  return out.join('\n');
}

/** The part of a report that fits a job summary: the table and the counts, with a pointer to the files. */
export function renderStepSummary(report: TriageReport): string {
  if (report.clusters.length === 0) return `### Failure triage\n\n${NO_FAILURES}.\n`;
  const shown = report.clusters.slice(0, SUMMARY_CLUSTERS);
  const out = [
    '### Failure triage',
    '',
    `**${headline(report)}.** ${NOT_A_GATE}.`,
    '',
    '| # | Failures | Engines | Category · rule | Class | Error |',
    '| --- | --- | --- | --- | --- | --- |',
    ...shown.map(
      (c) =>
        `| ${c.rank} | ${c.size} | ${cell(c.projects.join(', '))} | \`${c.category}\` · \`${c.rule.rule}\` | ${c.failureClass} | ${cell(readableFirstLine(c.representative.error.message), 100)} |`,
    ),
  ];
  if (report.clusters.length > shown.length)
    out.push(
      `| … | | | | | ${report.clusters.length - shown.length} more clusters in \`${REPORT_FILES.markdown}\` |`,
    );
  out.push(
    '',
    `The full report, with the evidence of each rule, is \`${REPORT_FILES.markdown}\` and \`${REPORT_FILES.json}\` in the reports of this build.`,
    '',
  );
  return out.join('\n');
}

export function renderJson(report: TriageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Written to a neighbour and renamed, so that a reader never sees half a file. Returns the paths. */
export function writeReport(outDir: string, render: { markdown: string; json: string }): string[] {
  mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (const [name, text] of [
    [REPORT_FILES.markdown, render.markdown],
    [REPORT_FILES.json, render.json],
  ] as const) {
    const path = join(outDir, name);
    const partial = `${path}.${process.pid}.tmp`;
    writeFileSync(partial, text);
    renameSync(partial, path);
    paths.push(path);
  }
  return paths;
}
