import { describe, expect, it } from 'vitest';
import { analyzeResult } from '../../../ab/analyze.ts';
import { calibrate } from '../../../ab/aa.ts';
import { validatePreregistration } from '../../../ab/prereg.ts';
import type { Preregistration } from '../../../ab/prereg.ts';
import { renderReport } from '../../../ab/report.ts';
import type { RawResult } from '../../../ab/results.ts';
import { profile } from '../../../src/shared/profiles.ts';
import { gaussian, generator } from './helpers.ts';
import { aaPrereg, rebufferPrereg, startupPrereg } from './fixtures.ts';
import type { Json } from './fixtures.ts';
import { aaPool, buildRaw, interleaved, plan, shareMetric, startupMetric, startupOnly } from './synthetic.ts';

// The report, from raw results made up for the purpose: what each kind of experiment prints, in what order, and what it refuses to say.

const normal = (seed: number, n: number, mean: number, sd: number): number[] =>
  gaussian(generator(seed), n, mean, sd).map((x) => Math.round(x));

function build(
  raw: Json,
  sessions = interleaved(startupOnly(normal(1, 30, 1000, 80)), startupOnly(normal(2, 30, 800, 80))),
  over: Parameters<typeof buildRaw>[2] = {},
): { raw: RawResult; prereg: Preregistration } {
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const validated = validatePreregistration(JSON.parse(text));
  if (!validated.ok) throw new Error(validated.problems.join('; '));
  const condition = validated.prereg.conditions[0] as Preregistration['conditions'][number];
  return {
    raw: buildRaw({ text, conditionId: condition.id, rules: condition.rules }, sessions, over),
    prereg: validated.prereg,
  };
}

function report(raw: RawResult, options = {}) {
  return renderReport(raw, analyzeResult(raw), { rawFile: 'docs/results/ab/PB-AB-002.raw.json', ...options });
}

describe('PB-AB report: a pre-registered experiment that ships B', () => {
  const { raw } = build(startupPrereg());
  const { markdown, json } = report(raw);

  it('opens with the catalog row, the verdict and what kind of document this is', () => {
    expect(markdown.split('\n').slice(0, 6)).toStrictEqual([
      '# PB-AB-002: Startup time of configuration B against configuration A under high latency',
      '',
      '**Ship B**',
      '',
      '> Pre-registered A/B experiment: the verdict below is the decision rule applied to the pre-registered metrics.',
      '',
    ]);
  });

  it('gives the verdict with its reason, and the decision rule applied step by step', () => {
    expect(markdown).toContain('**Verdict: Ship B.** Startup time is -');
    expect(markdown).toContain('### The decision rule, applied literally');
    expect(markdown).toContain(
      '1. Harm (worse than the threshold with an interval that excludes zero): none.',
    );
    expect(markdown).toContain('2. Benefit (adjusted p < 0.05');
    expect(markdown).toContain('What each primary metric read:');
    expect(markdown).toContain('- Startup time: B minus A is -');
  });

  it("has the table of the primary metric: sessions, medians and p90, the shift with its interval, Cliff's delta, both p-values, the threshold", () => {
    expect(markdown).toContain('### Primary metrics (Holm-adjusted over a family of 1)');
    expect(markdown).toContain(
      "| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |",
    );
    expect(markdown).toMatch(
      /\| Startup time \| 30 \/ 30 \| \d+ ms \(p90 \d+ ms\) \| \d+ ms \(p90 \d+ ms\) \| -\d+ ms \(95 % CI -\d+ ms to -\d+ ms\) \| -?\d\.\d\d \((medium|large)\) \| Mann-Whitney, < 0.001 \| < 0.001 \| 100 ms \|/,
    );
    expect(markdown).toContain('Hodges-Lehmann shift, seeded percentile bootstrap interval (5000 resamples)');
  });

  it('prints the quantile table of each arm, from p10 to p90', () => {
    expect(markdown).toContain('| Arm | p10 | p20 | p30 | p40 | p50 | p60 | p70 | p80 | p90 |');
    expect(markdown).toMatch(/\| A \| (\d+ ms \| ){8}\d+ ms \|/);
  });

  it('says what the arms started on and that the first rung cannot be separated from the rest', () => {
    expect(markdown).toContain('### The rung each session started on');
    expect(markdown).toContain('| A | 720p: 30 |');
    expect(markdown).toContain('| B | 240p: 30 |');
    expect(markdown).toContain('The arms never started on the same rung');
    expect(markdown).toContain('**The first rung is part of the difference.**');
  });

  it('records the design, the hash of the plan and what the commit proves, the environment, the date and the load', () => {
    expect(markdown).toContain(`sha256 \`${raw.preregistration.sha256}\``);
    expect(markdown).toContain(
      'committed unmodified in abc1234 on 2026-11-05T08:00:00Z, before the run started',
    );
    expect(markdown).toContain(
      'local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2',
    );
    expect(markdown).toContain(
      'started 2026-11-05T09:00:00.000Z, finished 2026-11-05T09:31:00.000Z; code at commit def5678',
    );
    expect(markdown).toContain('high-latency: 1.1 before, 1.4 after');
    expect(markdown).toContain('chromium 156.0.8078.4');
    expect(markdown).toContain('configuration A: no overrides');
  });

  it('prints the plan as it was pre-registered: the hypothesis, the threshold with its reason, the minimum detectable effect, the rules', () => {
    expect(markdown).toContain('- Hypothesis (startupMs): Under 300 ms of latency B starts no faster than A');
    expect(markdown).toContain(
      '| startupMs | primary | lower-is-better | 100 ms | A tenth of a second is the smallest startup change a viewer notices on a page load. | 80 ms at 30 per arm, power 0.8 (`docs/results/ab/pilot-high-latency.json`) |',
    );
    expect(markdown).toContain('Decision rule `pb-ab-v1`:');
    expect(markdown).toContain('Exclusion rule: A session that errors or times out is a failed session');
  });

  it('closes with what the experiment cannot say', () => {
    const section = markdown.slice(markdown.indexOf('## What this experiment cannot say'));
    expect(section).toContain('**One engine.** Only chromium 156.0.8078.4 was measured');
    expect(section).toContain('**Localhost, synthetic content.**');
    expect(section).toContain('quiet by its load average');
    expect(section).toContain('**The condition tested.** Only `high-latency`');
    expect(section).toContain('**B is a bundle.**');
    expect(section).toContain(
      '"No difference that matters" says the whole interval lies inside the pre-registered threshold, not that the true effect is zero',
    );
    expect(section).not.toContain('When a stall starts in Chromium');
  });

  it('names the raw file, and how to reproduce the report from it', () => {
    expect(markdown).toContain('- Raw results: `docs/results/ab/PB-AB-002.raw.json`');
    expect(markdown).toContain('npm run ab -- --report docs/results/ab/PB-AB-002.raw.json');
  });

  it('writes the same facts as JSON for tools', () => {
    expect(json).toMatchObject({
      kind: 'ab-report',
      experiment: { id: 'PB-AB-002', kind: 'experiment', catalogId: 'PB-AB-002' },
      preregistration: { sha256: raw.preregistration.sha256, proves: true },
      design: {
        engine: 'chromium',
        sessionsPerArm: 30,
        alpha: 0.05,
        bootstrapResamples: 5000,
        seed: 20261104,
      },
      calibration: null,
    });
    expect(json.conditions[0]?.analysis.decision?.outcome).toBe('ship-b');
    expect(json.conditions[0]?.analysis.metrics[0]?.effect?.kind).toBe('hodges-lehmann');
  });

  it('is reproducible: the same raw results give the same report to the character', () => {
    expect(report(raw).markdown).toBe(markdown);
    expect(JSON.stringify(report(raw).json)).toBe(JSON.stringify(json));
  });
});

describe('PB-AB report: rebuffering', () => {
  const sessions = interleaved(
    Array.from({ length: 30 }, (_, i) => ({
      startupMs: 1000,
      rebufferCount: i < 18 ? 1 : 0,
      rebufferMs: i < 18 ? 2000 : 0,
      rebufferRatio: i < 18 ? 0.06 : 0,
    })),
    Array.from({ length: 30 }, (_, i) => ({
      startupMs: 900,
      rebufferCount: i < 4 ? 1 : 0,
      rebufferMs: i < 4 ? 1500 : 0,
      rebufferRatio: i < 4 ? 0.04 : 0,
    })),
  );
  const { raw } = build(rebufferPrereg(), sessions);
  const { markdown } = report(raw);

  it('reports the share of sessions with a rebuffer with Fisher and the difference of shares, in percentage points', () => {
    expect(markdown).toContain(
      '| Share of sessions with a rebuffer | 30 / 30 | 18 of 30 (60.0 %) | 4 of 30 (13.3 %) | -46.7 pp (95 % CI ',
    );
    expect(markdown).toContain("| n/a | Fisher's exact, < 0.001 | < 0.001 | 20 pp |");
    expect(markdown).toContain("difference of the shares, Newcombe's hybrid score interval");
  });

  it('puts the secondary metric in its own table with the raw p, outside the decision', () => {
    expect(markdown).toContain('### Secondary metrics (pre-registered, not part of the decision)');
    expect(markdown).toContain('Raw p-values, no adjustment: they describe, they decide nothing.');
    expect(markdown).toMatch(/\| Rebuffer ratio \| 30 \/ 30 \|/);
  });

  it('warns about the stretch of bandwidth-drop that the player cannot hear, and the Chromium stall that starts late', () => {
    const section = markdown.slice(markdown.indexOf('## What this experiment cannot say'));
    expect(section).toContain('**A stretch the player cannot hear.**');
    expect(section).toContain('between 0 ms and 8000 ms');
    expect(section).toContain('**When a stall starts in Chromium.**');
    expect(section).toContain('a video-only underflow is not in the number');
    expect(markdown).toContain('Warnings of the plan:');
  });
});

describe('PB-AB report: an inconclusive result says what it would take', () => {
  it('prints the verdict "cannot tell" with the number of sessions a decision would need', () => {
    const a = normal(3, 30, 1000, 150);
    const b = normal(4, 30, 930, 150);
    const { raw } = build(startupPrereg(), interleaved(startupOnly(a), startupOnly(b)));
    const { markdown, json } = report(raw);
    expect(json.conditions[0]?.analysis.decision?.outcome).toBe('inconclusive');
    expect(markdown).toContain('**Verdict: Inconclusive: cannot tell (keep A).**');
    expect(markdown).toMatch(
      /A decision would need about \d+ sessions per arm instead of 30, if the true effect is the one estimated/,
    );
  });
});

describe('PB-AB report: the other kinds of run', () => {
  it('an exploratory comparison prints its numbers and no verdict, and says so at the top', () => {
    const { raw } = build({
      ...startupPrereg(),
      kind: 'exploratory',
      catalogId: null,
      id: 'PB-AB-startup-exploratory',
      title: 'Exploratory startup comparison under a constrained link',
    });
    const { markdown, json } = report(raw);
    expect(markdown).toContain('**exploratory, no verdict**');
    expect(markdown).toContain(
      '> EXPLORATORY comparison: pre-registered, but it estimates and decides nothing.',
    );
    expect(markdown).toContain('**No verdict.** This is an exploratory comparison');
    expect(markdown).not.toContain('### The decision rule, applied literally');
    expect(json.conditions[0]?.analysis.decision).toBeNull();
  });

  it('a pipeline check says it decides nothing', () => {
    const { raw } = build(
      {
        ...startupPrereg(),
        kind: 'pipeline-check',
        catalogId: null,
        id: 'PB-AB-pipeline-check',
        sessionsPerArm: 2,
        bootstrapResamples: 100,
        alpha: 0.05,
      },
      interleaved(startupOnly([900, 910]), startupOnly([800, 805])),
    );
    const { markdown } = report(raw);
    expect(markdown).toContain('**pipeline check, no verdict**');
    expect(markdown).toContain('> PIPELINE CHECK: a few sessions that show the harness runs end to end.');
  });

  it('an A/A run is read as the harness checking itself, with its calibration appended', () => {
    const a = normal(5, 30, 1000, 40);
    const b = normal(6, 30, 1000, 40);
    const prereg = {
      ...aaPrereg(),
      metrics: [{ ...(startupPrereg().metrics as Json[])[0], practicalThreshold: 150 }],
    };
    const { raw } = build(
      prereg,
      interleaved(startupOnly(a), startupOnly(b), () => ({ config: 'A' as const })),
    );
    const calibration = calibrate(
      plan([startupMetric({ practicalThreshold: 150 }), shareMetric()], { bootstrapResamples: 100 }),
      aaPool(generator(9), 60),
      { splits: 200, seed: 1 },
    );
    const { markdown, json } = report(raw, { calibration });
    expect(markdown).toContain('> A/A run (PB-AB-001): both arms ran configuration A.');
    expect(markdown).toContain('**A/A reading.**');
    expect(markdown).toContain('reads "no difference"');
    expect(markdown).toContain('## A/A calibration (PB-AB-001): the false-positive rate of the harness');
    expect(markdown).toContain('**One A/A run.**');
    expect(json.calibration?.splits).toBe(200);
    expect(json.conditions[0]?.aa).toMatchObject({ ideal: true, acceptable: true });
  });
});

describe('PB-AB report: failures, provenance and several conditions', () => {
  it('lists the failed sessions, and says when the failure guard tripped', () => {
    const sessions = interleaved(
      startupOnly(normal(7, 30, 1000, 40)),
      startupOnly(normal(8, 30, 800, 40)),
      (arm, block) =>
        arm === 'B' && block < 6
          ? {
              status: 'failed' as const,
              failure: {
                kind: 'timeout' as const,
                message: "qa.waitFor('firstframe') timed out after 30000 ms\nthe last events",
              },
              values: {},
            }
          : {},
    );
    const { raw } = build(startupPrereg(), sessions);
    const { markdown } = report(raw);
    expect(markdown).toContain('| Failed (reported, never silently dropped) | 0 | 6 |');
    expect(markdown).toContain('| Analysed | 30 | 24 |');
    expect(markdown).toContain('The failure guard tripped:');
    expect(markdown).toMatch(
      /- session \d+ \(block \d, arm B\): timeout: qa\.waitFor\('firstframe'\) timed out after 30000 ms/,
    );
    expect(markdown).toContain('**Verdict: Inconclusive: cannot tell (keep A).**');
  });

  it('does not claim the plan was fixed first when the file was not committed unmodified, or git could not say', () => {
    const dirty = report(
      build(startupPrereg(), undefined, {
        committed: { clean: false, commit: 'abc1234', date: '2026-11-05T08:00:00Z' },
      }).raw,
    );
    expect(dirty.markdown).toContain('was NOT committed, unmodified, when the run started');
    expect(dirty.json.preregistration.proves).toBe(false);
    const unknown = report(build(startupPrereg(), undefined, { committed: null }).raw);
    expect(unknown.markdown).toContain(
      'Git could not say whether the pre-registration was committed before the run',
    );
  });

  it('names the condition in every heading when a pre-registration has several, and notes a run that stopped early', () => {
    const prereg = {
      ...aaPrereg(),
      conditions: [
        (startupPrereg().conditions as Json[])[0],
        {
          id: 'constrained-1500',
          profile: 'constrained-1500',
          rules: profile('constrained-1500'),
          rationale: 'A 1500 kbps link carries 360p but not 720p: the first rung matters.',
        },
      ],
    };
    const { raw } = build(
      prereg,
      interleaved(startupOnly(normal(9, 30, 1000, 40)), startupOnly(normal(10, 30, 1000, 40)), () => ({
        config: 'A' as const,
      })),
    );
    const second = structuredClone(raw.conditions[0]!);
    second.id = 'constrained-1500';
    second.rules = profile('constrained-1500');
    second.aborted = '5 sessions failed in a row (the last: timeout: x)';
    raw.conditions.push(second);
    const { markdown } = report(raw);
    expect(markdown).toContain('## Verdict: condition high-latency');
    expect(markdown).toContain('## Verdict: condition constrained-1500');
    expect(markdown).toContain('## What this experiment cannot say: condition constrained-1500');
    expect(markdown).toContain('**The condition was stopped early:** 5 sessions failed in a row');
  });
});
