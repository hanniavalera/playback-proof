import type { AaEvaluation, CalibrationResult } from './aa.ts';
import { evaluateAa, renderCalibration } from './aa.ts';
import type { ConditionAnalysis, MetricComparison, ResultAnalysis } from './analyze.ts';
import { describeProvenance } from './provenance.ts';
import { describeUnmeasured, unmeasuredWindows } from './conditions.ts';
import { METRICS, formatDifference, formatThreshold, formatValue } from './metrics.ts';
import type { Preregistration } from './prereg.ts';
import type { RawResult } from './results.ts';
import type { SessionRecord } from './types.ts';
import { BUSY_LOAD_SHARE } from '../src/lab/measure/report.ts';

// THE REPORT of an experiment: Markdown for people, JSON for tools, both made from the raw results and nothing else. The Markdown answers,
// in this order, the questions a reader asks: what is the verdict and why (the decision rule applied literally), under what design and
// plan (with the hash that proves the plan came first), what did each primary metric do, what else was different about the arms (the
// start rung), what failed, what was explored without a plan, and what this experiment cannot say.

const fmtP = (p: number | null): string => (p === null ? 'n/a' : p < 0.001 ? '< 0.001' : p.toFixed(3));
const fmtPercent = (share: number): string => `${(share * 100).toFixed(1)} %`;

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function armSummary(metric: MetricComparison, arm: 'A' | 'B'): string {
  if (metric.kind === 'binary') {
    const counts = arm === 'A' ? metric.countsA : metric.countsB;
    return counts === null ? 'n/a' : `${counts.events} of ${counts.total} (${fmtPercent(counts.share)})`;
  }
  const summary = arm === 'A' ? metric.summaryA : metric.summaryB;
  return summary === null
    ? 'n/a'
    : `${formatValue(metric.unit, summary.median)} (p90 ${formatValue(metric.unit, summary.p90)})`;
}

function effectCell(metric: MetricComparison): string {
  const effect = metric.effect;
  if (effect === null) return 'n/a (fewer than 2 sessions in an arm)';
  return `${formatDifference(metric.unit, effect.estimate)} (${Math.round(effect.level * 100)} % CI ${formatDifference(metric.unit, effect.low)} to ${formatDifference(metric.unit, effect.high)})`;
}

function cliffsCell(metric: MetricComparison): string {
  return metric.cliffs === null ? 'n/a' : `${metric.cliffs.delta.toFixed(2)} (${metric.cliffs.label})`;
}

function bannerOf(prereg: Preregistration): string {
  switch (prereg.kind) {
    case 'experiment':
      return 'Pre-registered A/B experiment: the verdict below is the decision rule applied to the pre-registered metrics.';
    case 'aa':
      return 'A/A run (PB-AB-001): both arms ran configuration A. This is the harness checking itself: the verdict should read "no difference".';
    case 'exploratory':
      return 'EXPLORATORY comparison: pre-registered, but it estimates and decides nothing. No ship decision follows from it.';
    case 'pipeline-check':
      return 'PIPELINE CHECK: a few sessions that show the harness runs end to end. Its numbers decide nothing and mean nothing.';
  }
}

function describeConfig(sessions: readonly SessionRecord[], arm: 'A' | 'B'): string {
  const seen = sessions.find((session) => session.arm === arm && session.info !== null);
  if (!seen?.info) return 'not recorded';
  const overrides =
    Object.keys(seen.info.configOverrides).length === 0
      ? "no overrides (Shaka's own defaults)"
      : `overrides \`${JSON.stringify(seen.info.configOverrides)}\` (Shaka's defaults at those keys: \`${JSON.stringify(seen.info.configDefaults)}\`)`;
  return `configuration ${seen.info.config}: ${overrides}`;
}

function limitations(
  prereg: Preregistration,
  raw: RawResult,
  analysis: ConditionAnalysis,
  condition: { id: string; rules: RawResult['conditions'][number]['rules'] },
): string[] {
  const { rules } = condition;
  const busy = Math.max(0, ...raw.conditions.flatMap((c) => [c.loadAverage.before, c.loadAverage.after]));
  const isBusy = busy > raw.environment.host.cpus * BUSY_LOAD_SHARE;
  const engine = `${raw.environment.browser.name} ${raw.environment.browser.version}`;
  const items = [
    `**One engine.** Only ${engine} was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.`,
    `**Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (${raw.environment.envId}, ${raw.environment.host.os.name}, ${raw.environment.host.cpus} CPUs), and a machine that was ${isBusy ? `NOT quiet: the load average reached ${busy.toFixed(1)} on ${raw.environment.host.cpus} CPUs, more than ${BUSY_LOAD_SHARE * 100} % of them` : 'quiet by its load average'}. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.`,
    `**The condition tested.** Only \`${condition.id}\`: ${rules.length === 0 ? 'no faults' : rules.map((rule) => JSON.stringify(rule)).join(', ')}. A configuration can win under one network and lose under another; nothing here speaks for the others.`,
    `**B is a bundle.** Configuration B changes three things at once (a fixed initial estimate that starts on the lowest rung, a 4 s switch interval, a 20 s buffering goal). An effect cannot be credited to one of them: that would take arms of A plus one knob, which were not run.`,
    '**What the intervals mean.** They describe the sampling noise of these sessions on this machine. "No difference that matters" says the whole interval lies inside the pre-registered threshold, not that the true effect is zero; "inconclusive" says the data cannot rule out a difference that matters and do not show one.',
  ];
  if (
    raw.environment.browser.name === 'chromium' &&
    prereg.metrics.some((metric) => metric.id.startsWith('rebuffer'))
  ) {
    items.push(
      "**When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.",
    );
  }
  if (analysis.startRungs.disjoint) {
    items.push(`**The first rung is part of the difference.** ${analysis.startRungs.note}`);
  }
  for (const sentence of describeUnmeasured(unmeasuredWindows(rules))) {
    items.push(`**A stretch the player cannot hear.** ${sentence}.`);
  }
  if (prereg.kind === 'aa') {
    items.push(
      '**One A/A run.** It checks the whole procedure once. With a perfect harness one run in twenty is significant by chance: a failure is a reason to repeat it as a new pre-registered run and to read the calibration, not a verdict on its own.',
    );
  }
  return items;
}

export interface ReportOptions {
  /** Where the raw results file lives (a path relative to the repository), for the "files" line. */
  rawFile?: string;
  /** The A/A calibration of the pool of each condition of this run, if it was computed. */
  calibrations?: ReadonlyArray<{ condition: string; result: CalibrationResult }>;
}

export interface ConditionReport {
  id: string;
  analysis: ConditionAnalysis;
  aa: AaEvaluation | null;
}

export interface ReportJson {
  schemaVersion: 1;
  kind: 'ab-report';
  experiment: { id: string; kind: Preregistration['kind']; catalogId: string | null; title: string };
  preregistration: { path: string; sha256: string; proves: boolean; provenance: string };
  environment: RawResult['environment'];
  run: RawResult['run'];
  design: {
    engine: string;
    sessionsPerArm: number;
    warmupSessionsPerArm: number;
    alpha: number;
    bootstrapResamples: number;
    seed: number;
    interleaving: string;
  };
  warnings: string[];
  conditions: ConditionReport[];
  calibrations: Array<{ condition: string; result: CalibrationResult }>;
}

function conditionSection(
  prereg: Preregistration,
  raw: RawResult,
  entry: ResultAnalysis['conditions'][number],
  aa: AaEvaluation | null,
): string {
  const { analysis, result } = entry;
  const out: string[] = [];
  const headline = analysis.decision
    ? `**Verdict: ${analysis.decision.headline}.** ${analysis.decision.reason.replace(/^(Ship B|Do not ship B|No difference that matters|Inconclusive): /, '')}`
    : `**No verdict.** ${analysis.decisionNote ?? ''}`;
  const suffix = prereg.conditions.length > 1 ? `: condition ${result.id}` : '';
  out.push(`## Verdict${suffix}`, '', headline, '');
  if (analysis.decision?.moreSessions) {
    const more = analysis.decision.moreSessions;
    out.push(
      more.perArm === null
        ? `More sessions would not settle it at the estimated effect (an estimate on the edge of a threshold, or a failure problem more sessions do not remove): ${more.basis}.`
        : `A decision would need about ${more.perArm} sessions per arm instead of ${prereg.sessionsPerArm}, ${more.basis}.`,
      '',
    );
  }
  if (result.aborted) out.push(`**The condition was stopped early:** ${result.aborted}.`, '');
  if (aa) out.push(`**A/A reading.** ${aa.reason}`, '');

  if (analysis.decision) {
    out.push(
      '### The decision rule, applied literally',
      '',
      ...analysis.decision.steps.map((step) => step),
      '',
      'What each primary metric read:',
      '',
    );
    out.push(...analysis.decision.readings.map((reading) => `- ${reading.sentence}`), '');
  }

  const primary = analysis.metrics.filter((metric) => metric.role === 'primary');
  out.push(`### Primary metrics (Holm-adjusted over a family of ${primary.length})`, '');
  out.push(
    table(
      [
        'Metric',
        'n A / n B',
        'A median (p90) or share',
        'B median (p90) or share',
        'B minus A',
        "Cliff's delta",
        'Test, p',
        'Holm-adjusted p',
        'Practical threshold',
      ],
      primary.map((metric) => [
        metric.label,
        `${metric.nA} / ${metric.nB}`,
        armSummary(metric, 'A'),
        armSummary(metric, 'B'),
        effectCell(metric),
        cliffsCell(metric),
        metric.test === null
          ? 'n/a'
          : `${metric.test.name === 'fisher' ? "Fisher's exact" : 'Mann-Whitney'}, ${fmtP(metric.test.p)}`,
        fmtP(metric.pAdjusted),
        metric.threshold === null ? 'n/a' : formatThreshold(metric.unit, metric.threshold),
      ]),
    ),
    '',
    ...primary.flatMap((metric) => [
      `- ${metric.label}: ${metric.test?.method ?? 'no test'}; ${metric.effect?.method ?? 'no effect estimate'}.`,
      ...metric.warnings.map((warning) => `- WARNING, ${metric.label}: ${warning}.`),
    ]),
    '',
  );

  out.push('### Distribution of each arm (quantiles, from p10 to p90)', '');
  for (const metric of primary.filter((candidate) => candidate.ecdf !== null)) {
    const ecdf = metric.ecdf as NonNullable<MetricComparison['ecdf']>;
    out.push(
      `${metric.label}:`,
      '',
      table(
        ['Arm', ...ecdf.probabilities.map((q) => `p${Math.round(q * 100)}`)],
        [
          ['A', ...ecdf.a.map((value) => formatValue(metric.unit, value))],
          ['B', ...ecdf.b.map((value) => formatValue(metric.unit, value))],
        ],
      ),
      '',
    );
  }

  out.push('### The rung each session started on', '');
  out.push(
    table(
      ['Arm', 'Sessions by start rung'],
      (['A', 'B'] as const).map((arm) => [
        arm,
        Object.entries(analysis.startRungs[arm])
          .sort(([x], [y]) => Number(x) - Number(y))
          .map(([height, n]) => `${height}p: ${n}`)
          .join(', ') || 'none',
      ]),
    ),
    '',
    analysis.startRungs.note,
    '',
  );

  const f = analysis.failures;
  out.push('### Sessions, failures and errors', '');
  out.push(
    table(
      ['', 'Arm A', 'Arm B'],
      [
        ['Warm-up sessions (recorded, left out)', String(analysis.warmup.A), String(analysis.warmup.B)],
        ['Measured sessions attempted', String(f.attemptedA), String(f.attemptedB)],
        ['Failed (reported, never silently dropped)', String(f.failedA), String(f.failedB)],
        ['Analysed', String(analysis.analysed.A), String(analysis.analysed.B)],
        [
          'Analysed sessions with a recoverable Shaka error',
          String(analysis.recoverableErrors.A),
          String(analysis.recoverableErrors.B),
        ],
      ],
    ),
    '',
    f.failedA + f.failedB === 0
      ? 'No session failed.'
      : `Failure counts differ between the arms with Fisher p = ${fmtP(f.fisherP)}. ${f.guardWhy ? `The failure guard tripped: ${f.guardWhy}.` : 'The failure guard did not trip.'}`,
    '',
    ...f.sessions.map(
      (session) =>
        `- session ${session.index + 1} (block ${session.block + 1}, arm ${session.arm}): ${session.kind}: ${session.message.split('\n')[0]}`,
    ),
    '',
  );

  const secondary = analysis.metrics.filter((metric) => metric.role === 'secondary');
  if (secondary.length > 0) {
    out.push(
      '### Secondary metrics (pre-registered, not part of the decision)',
      '',
      'Raw p-values, no adjustment: they describe, they decide nothing.',
      '',
    );
    out.push(
      table(
        ['Metric', 'n A / n B', 'A', 'B', 'B minus A', "Cliff's delta", 'Test, raw p'],
        secondary.map((metric) => [
          metric.label,
          `${metric.nA} / ${metric.nB}`,
          armSummary(metric, 'A'),
          armSummary(metric, 'B'),
          effectCell(metric),
          cliffsCell(metric),
          metric.test === null
            ? 'n/a'
            : `${metric.test.name === 'fisher' ? "Fisher's exact" : 'Mann-Whitney'}, ${fmtP(metric.test.p)}`,
        ]),
      ),
      '',
      ...secondary.flatMap((metric) =>
        metric.warnings.map((warning) => `- WARNING, ${metric.label}: ${warning}.`),
      ),
      '',
    );
  }

  out.push(`## Exploratory (not pre-registered, outside the Holm family)${suffix}`, '');
  out.push(
    'Nothing in this section was in the plan. It is here so that the data are not hidden, not so that it can be quoted: every p-value is raw, and one comparison in twenty is significant by chance.',
    '',
  );
  if (analysis.exploratory.length === 0) out.push('(none computed)', '');
  for (const block of analysis.exploratory) {
    out.push(`### ${block.title}`, '', block.note, '');
    if (block.rows.length > 0) {
      out.push(
        table(
          ['Comparison', 'n A / n B', 'B minus A', 'Raw p'],
          block.rows.map((row) => [
            row.label,
            `${row.nA} / ${row.nB}`,
            row.effect === null
              ? 'n/a'
              : `${formatDifference(row.unit, row.effect)} (CI ${formatDifference(row.unit, row.low as number)} to ${formatDifference(row.unit, row.high as number)})`,
            fmtP(row.p),
          ]),
        ),
        '',
      );
    }
  }

  out.push(
    `## What this experiment cannot say${suffix}`,
    '',
    ...limitations(prereg, raw, analysis, result).map((item) => `- ${item}`),
    '',
  );
  return out.join('\n');
}

/** Renders the report of a raw result, with the analysis already done (the A/A calibration, if any, is appended). */
export function renderReport(
  raw: RawResult,
  analysis: ResultAnalysis,
  options: ReportOptions = {},
): { markdown: string; json: ReportJson } {
  const { prereg } = analysis;
  const provenance = describeProvenance(raw.preregistration.committed, raw.run.startedAt);
  const aaEvaluations = analysis.conditions.map((entry) =>
    prereg.kind === 'aa' ? evaluateAa(entry.analysis) : null,
  );
  const verdictLine = (() => {
    const first = analysis.conditions[0]?.analysis;
    if (first?.decision) return first.decision.headline;
    return prereg.kind === 'exploratory' ? 'exploratory, no verdict' : 'pipeline check, no verdict';
  })();

  const md: string[] = [];
  md.push(
    `# ${prereg.catalogId ?? prereg.id}: ${prereg.title}`,
    '',
    `**${verdictLine}**`,
    '',
    `> ${bannerOf(prereg)}`,
    '',
  );
  analysis.conditions.forEach((entry, index) =>
    md.push(conditionSection(prereg, raw, entry, aaEvaluations[index] ?? null)),
  );

  md.push('## Design and plan', '');
  md.push(
    table(
      ['', ''],
      [
        [
          'Experiment',
          `${prereg.id} (${prereg.kind}${prereg.catalogId ? `, catalog row ${prereg.catalogId}` : ''})`,
        ],
        [
          'Engine, browser',
          `${raw.environment.browser.name} ${raw.environment.browser.version}${raw.environment.browser.userAgent ? ` (\`${raw.environment.browser.userAgent}\`)` : ''}`,
        ],
        [
          'Stream',
          `${prereg.stream} over ${prereg.protocol} (content hash ${Object.values(raw.environment.streams).join(', ') || 'not recorded'})`,
        ],
        [
          'Arm A',
          describeConfig(
            raw.conditions.flatMap((c) => c.sessions),
            'A',
          ),
        ],
        [
          'Arm B',
          describeConfig(
            raw.conditions.flatMap((c) => c.sessions),
            'B',
          ),
        ],
        [
          'Conditions',
          analysis.conditions
            .map(
              ({ result }) =>
                `\`${result.id}\`: ${result.rules.length === 0 ? 'no faults' : result.rules.map((rule) => `\`${JSON.stringify(rule)}\``).join(', ')}`,
            )
            .join('; '),
        ],
        [
          'Sessions',
          `${prereg.sessionsPerArm} per arm planned, ${prereg.warmupSessionsPerArm} warm-up per arm recorded and left out; observation: first frame${prereg.observation.mediaSecondsAfterFirstFrame > 0 ? ` and ${prereg.observation.mediaSecondsAfterFirstFrame} s of media after it` : ' only'}, timeout ${prereg.observation.sessionTimeoutMs} ms`,
        ],
        [
          'Interleaving',
          'blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition',
        ],
        [
          'Statistics',
          `alpha ${prereg.alpha}; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (${prereg.bootstrapResamples} resamples, seed ${prereg.seed}); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family`,
        ],
        [
          'Pre-registration',
          `\`${raw.preregistration.path}\`, sha256 \`${raw.preregistration.sha256}\`. ${provenance.sentence}`,
        ],
        [
          'Environment',
          `${raw.environment.envId}: ${raw.environment.host.os.name} ${raw.environment.host.os.arch}, ${raw.environment.host.cpus} CPUs, ${raw.environment.host.memoryGiB} GiB, Node ${raw.environment.host.node}, Playwright ${raw.environment.host.playwright}, ffmpeg ${raw.environment.ffmpeg}`,
        ],
        [
          'Date and commit',
          `started ${raw.run.startedAt}, finished ${raw.run.finishedAt}; code at commit ${raw.environment.host.git.commit ?? 'unknown'}${raw.environment.host.git.dirty ? ' (with uncommitted changes)' : ''}`,
        ],
        [
          'Load average (1 min)',
          analysis.conditions
            .map(
              ({ result }) =>
                `${result.id}: ${result.loadAverage.before.toFixed(1)} before, ${result.loadAverage.after.toFixed(1)} after`,
            )
            .join('; '),
        ],
        ['Command', `\`${raw.run.command}\``],
      ],
    ),
    '',
  );
  md.push('### The plan, as pre-registered', '');
  md.push(...prereg.hypotheses.map((h) => `- Hypothesis (${h.metric}): ${h.text}`), '');
  md.push(
    table(
      [
        'Metric',
        'Role',
        'Direction',
        'Practical threshold',
        'Why that number',
        'Minimum detectable effect (pilot)',
      ],
      prereg.metrics.map((metric) => {
        const { unit } = METRICS[metric.id];
        return [
          metric.id,
          metric.role,
          metric.direction,
          metric.practicalThreshold === undefined ? 'n/a' : formatThreshold(unit, metric.practicalThreshold),
          metric.thresholdBasis ?? 'n/a',
          metric.minimumDetectableEffect
            ? `${formatThreshold(unit, metric.minimumDetectableEffect.value)} at ${metric.minimumDetectableEffect.sessionsPerArm} per arm, power ${metric.minimumDetectableEffect.power} (\`${metric.minimumDetectableEffect.source}\`)`
            : 'n/a',
        ];
      }),
    ),
    '',
    `Decision rule \`${prereg.decisionRule.id}\`: ${prereg.decisionRule.text}`,
    '',
    `Exclusion rule: ${prereg.exclusionRule.text} (largest share of failed sessions per arm ${fmtPercent(prereg.exclusionRule.maxFailedShare)}; the condition stops after ${prereg.exclusionRule.abortAfterConsecutiveFailures} failures in a row).`,
    '',
  );
  if (analysis.warnings.length > 0)
    md.push('Warnings of the plan:', '', ...analysis.warnings.map((warning) => `- ${warning}`), '');
  for (const { condition, result } of options.calibrations ?? []) {
    md.push(
      prereg.conditions.length > 1
        ? `### Condition ${condition}\n\n${renderCalibration(result)}`
        : renderCalibration(result),
    );
  }
  md.push(
    '## Files',
    '',
    `- Raw results: \`${options.rawFile ?? 'not written'}\` (every session, with its rung history and the configuration \`qa.info()\` reported).`,
    `- Reproduce this report from the raw results: \`npm run ab -- --report ${options.rawFile ?? '<raw results file>'}\`.`,
    '',
  );

  const json: ReportJson = {
    schemaVersion: 1,
    kind: 'ab-report',
    experiment: { id: prereg.id, kind: prereg.kind, catalogId: prereg.catalogId, title: prereg.title },
    preregistration: {
      path: raw.preregistration.path,
      sha256: raw.preregistration.sha256,
      proves: provenance.proves,
      provenance: provenance.sentence,
    },
    environment: raw.environment,
    run: raw.run,
    design: {
      engine: prereg.engine,
      sessionsPerArm: prereg.sessionsPerArm,
      warmupSessionsPerArm: prereg.warmupSessionsPerArm,
      alpha: prereg.alpha,
      bootstrapResamples: prereg.bootstrapResamples,
      seed: prereg.seed,
      interleaving: 'blocks of two, the arm that goes first alternates',
    },
    warnings: analysis.warnings,
    conditions: analysis.conditions.map((entry, index) => ({
      id: entry.result.id,
      analysis: entry.analysis,
      aa: aaEvaluations[index] ?? null,
    })),
    calibrations: [...(options.calibrations ?? [])],
  };
  return { markdown: `${md.join('\n')}\n`, json };
}
