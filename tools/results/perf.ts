// RESULTS_PERF: the performance baselines per environment and profile, what the thresholds derived from them are worth, the A/A checks
// (the gate run against its own baseline: every alarm is a false positive) and the sensitivity checks (regressions injected on purpose).
// Everything is read from committed files: the baselines (perf/baselines), the derivation and the A/A summaries (docs/results/perf).
// The gating decision is the harness's own (`gatingStatus`), not a copy of its rule.
import { PERF_LIMITS } from '../../src/shared/criteria.ts';
import { BaselineError, parseBaseline } from '../../src/lab/measure/baseline.ts';
import type { Baseline } from '../../src/lab/measure/baseline.ts';
import { gatingStatus } from '../../src/lab/measure/decide.ts';
import { SCENARIOS } from '../../src/lab/measure/scenarios.ts';
import { splitCells } from '../catalog.ts';
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Node, Rendered } from './files.ts';
import { code, day, fixed, link, listOf, mdTable, ms, percent, plural, shorten } from './format.ts';

export const BASELINES_DIR = 'perf/baselines';
export const PERF_RESULTS_DIR = 'docs/results/perf';
export const DERIVATION_FILE = `${PERF_RESULTS_DIR}/threshold-derivation.json`;
export const SENSITIVITY_FILE = `${PERF_RESULTS_DIR}/sensitivity/summary.md`;
export const CROSS_VM_FILE = `${PERF_RESULTS_DIR}/gha-cross-vm.md`;
export const PAIRED_AA_README = `${PERF_RESULTS_DIR}/paired-aa/README.md`;
export const PAIRED_SENSITIVITY_FILE = `${PERF_RESULTS_DIR}/paired-sensitivity.md`;
const PAIRED_SENSITIVITY_DIR = `${PERF_RESULTS_DIR}/paired-sensitivity`;

// ---------------------------------------------------------------------------------------------------------------------
// Baselines

interface LoadedBaseline {
  path: string;
  baseline: Baseline;
}

function readBaselines(files: FileSet): LoadedBaseline[] {
  return files.list(BASELINES_DIR, /^[^/]+\/[^/]+\.json$/).map((path) => {
    let baseline: Baseline;
    try {
      baseline = parseBaseline(files.text(path), path);
    } catch (error) {
      if (error instanceof BaselineError) throw new ResultsError(error.message);
      throw error;
    }
    const expected = `${BASELINES_DIR}/${baseline.envId}/${baseline.profile}.json`;
    if (path !== expected) {
      throw new ResultsError(
        `${path}: records ${baseline.profile} of ${baseline.envId}, so it must be ${expected} (was the file copied?)`,
      );
    }
    return { path, baseline };
  });
}

function baselineRows(loaded: readonly LoadedBaseline[]): string[][] {
  return loaded.map(({ baseline }) => {
    const specs = SCENARIOS.filter((scenario) => scenario.id in baseline.scenarios);
    const statuses = gatingStatus(specs, baseline);
    const gated = statuses.filter((s) => s.gates).length;
    const startupSpec = specs.find((spec) => spec.metrics.some((metric) => metric.id === 'startupMs'));
    const summary = startupSpec ? baseline.scenarios[startupSpec.id]?.metrics.startupMs?.summary : null;
    const status = statuses.find((s) => s.metric === 'startupMs');
    let startup = 'not measured';
    let cv = 'n/a';
    let gate = 'n/a';
    if (summary && startupSpec) {
      startup = `${fixed(summary.median)} / ${ms(summary.p90)} (${startupSpec.id})`;
      cv = percent(summary.cv);
      gate =
        status?.gates === true
          ? 'gated'
          : summary.cv !== null && summary.cv > PERF_LIMITS.maxBaselineCv
            ? `tracked: CV above the ${percent(PERF_LIMITS.maxBaselineCv, 0)} limit`
            : `tracked: ${status?.reason ?? 'no rule'}`;
    }
    return [
      code(baseline.envId),
      code(baseline.profile),
      `${baseline.browser.name} ${baseline.browser.version}`,
      `${day(baseline.generatedAt)}, ${code(baseline.host.git.commit ?? 'unknown commit')}`,
      startup,
      cv,
      gate,
      `${gated} / ${statuses.length - gated}`,
    ];
  });
}

function baselineNote(loaded: readonly LoadedBaseline[]): string {
  const shapes = [
    ...new Set(
      loaded.map(
        (l) =>
          `${l.baseline.runsPerScenario} measured runs per scenario after ${plural(l.baseline.warmupRuns, 'warm-up run')} that is recorded and left out`,
      ),
    ),
  ];
  const shape =
    shapes.length === 1
      ? `Every baseline is ${shapes[0]}.`
      : `Runs per baseline differ: ${shapes.join('; ')}.`;
  return `${shape} Startup is the time from load requested to first frame presented, median / p90. A tracked metric is reported on every build and can neither fail it nor start a re-measure; the last column counts the metrics of the profile that gate and that are tracked (a metric with no rule is tracked too).`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The derivation

interface Derivation {
  needs: Node[];
  budgets: Node[];
  coverage: Node[];
  pairs: Node[];
  baselines: Node[];
}

function readDerivation(files: FileSet, loaded: readonly LoadedBaseline[]): Derivation {
  const root = files.json(DERIVATION_FILE);
  if (root.at('kind').str() !== 'perf-threshold-derivation')
    root.at('kind').fail('expected "perf-threshold-derivation"');
  if (root.at('schemaVersion').int() !== 1)
    root.at('schemaVersion').fail('this renderer reads schema version 1');
  const derivation: Derivation = {
    needs: root.at('needs').list(),
    budgets: root.at('budgets').list(),
    coverage: root.at('coverage').list(),
    pairs: root.at('pairs').list(),
    baselines: root.at('baselines').list(),
  };
  // The tables below describe the baselines of the table above: a derivation of other ones would put numbers beside the wrong data.
  const derived = new Map(
    derivation.baselines.map((b) => [
      `${BASELINES_DIR}/${b.at('envId').str()}/${b.at('profile').str()}.json`,
      b,
    ]),
  );
  for (const { path, baseline } of loaded) {
    const entry = derived.get(path);
    if (!entry) {
      throw new ResultsError(`${DERIVATION_FILE}: does not cover ${path}: run \`npx tsx perf/derive.ts\``);
    }
    const commit = baseline.host.git.commit;
    if (
      entry.at('generatedAt').str() !== baseline.generatedAt ||
      (entry.opt('commit')?.str() ?? null) !== commit
    ) {
      throw new ResultsError(
        `${DERIVATION_FILE}: was derived from ${path} as recorded ${entry.at('generatedAt').str()} at ${entry.opt('commit')?.str() ?? 'no commit'}, but the file now says ${baseline.generatedAt} at ${commit ?? 'no commit'}: run \`npx tsx perf/derive.ts\``,
      );
    }
    derived.delete(path);
  }
  if (derived.size > 0) {
    throw new ResultsError(
      `${DERIVATION_FILE}: covers ${listOf([...derived.keys()])}, which is not committed`,
    );
  }
  return derivation;
}

function firstPairOf(derivation: Derivation, rule: string): Node | undefined {
  return derivation.pairs.find((p) => p.opt('rule')?.str() === rule);
}

function ruleLabel(derivation: Derivation, rule: string): string {
  const pair = firstPairOf(derivation, rule);
  return pair ? `${code(rule)} (${pair.at('scenario').str()} ${pair.at('metric').str()})` : code(rule);
}

function unitOfRule(derivation: Derivation, rule: string): string {
  return firstPairOf(derivation, rule)?.at('unit').str() ?? '';
}

/** The policy's allowance over the noise: when the noise is next to nothing the ratio is astronomical and says nothing more. */
export const margin = (ratio: number): string => (ratio > 1000 ? 'over 1,000x' : `${fixed(ratio, 1)}x`);

function needsTable(derivation: Derivation): string {
  const rows = derivation.needs.map((need) => {
    const rule = need.at('rule').str();
    const margins = derivation.coverage.filter((c) => c.opt('rule')?.str() === rule && c.at('gated').bool());
    const smallest = (which: 'median' | 'tail'): string => {
      const values = margins.flatMap((c) => {
        const margin = c.at('margin').opt(which);
        return margin === undefined ? [] : [margin.num()];
      });
      return values.length === 0 ? 'no noise to cover' : margin(Math.min(...values));
    };
    const suggested = need.at('suggested');
    const unit = unitOfRule(derivation, rule);
    return [
      ruleLabel(derivation, rule),
      String(need.at('gatedPairs').int()),
      String(need.at('trackedPairs').int()),
      `${percent(need.at('share').at('median').num())} / ${percent(need.at('share').at('tail').num())}`,
      `${percent(suggested.at('medianShare').num(), 0)} / ${percent(suggested.at('tailShare').num(), 0)}, floor ${fixed(suggested.at('floor').num())} ${unit}`,
      `${smallest('median')} / ${smallest('tail')}`,
    ];
  });
  return mdTable(
    [
      'Rule',
      'Gated pairs',
      'Tracked pairs',
      'Largest noise, median / tail (share of the baseline)',
      'Derived allowance, median / tail, and floor',
      'Smallest margin of the committed policy, median / tail',
    ],
    rows,
  );
}

function budgetsTable(derivation: Derivation): string {
  return mdTable(
    ['Rule', 'Metric', 'Baseline runs', 'Runs above zero', 'Largest value'],
    derivation.budgets.map((budget) => {
      const unit = budget.at('unit').str();
      return [
        code(budget.at('rule').str()),
        code(budget.at('metric').str()),
        String(budget.at('runs').int()),
        String(budget.at('nonZero').int()),
        `${fixed(budget.at('max').num(), 4)}${unit === 'count' || unit === 'ratio' ? '' : ` ${unit}`}`,
      ];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// A/A

/** Where a set of A/A summaries comes from: a directory of `docs/results/perf`, with a name of its own when it is not an environment's. */
type AaKind = 'committed' | 'paired';

interface AaRun {
  exitCode: number;
  /** The CPU model of the pass: the report's own, else the machine record of the job that made it. */
  cpu: string | null;
  /** The job of GitHub that made the pass (a directory of `raw/`), when the summary names one. */
  job: string | null;
}

interface AaFile {
  path: string;
  set: string;
  kind: AaKind;
  /** The GitHub VMs of the set (a job is a machine); the workstation sets are one machine and say nothing here. */
  onGithub: boolean;
  envId: string;
  profile: string;
  passes: number;
  exit0: number;
  exit1: number;
  exit2: number;
  falsePositives: number;
  alarms: number;
  notReproduced: number;
  firstProblem: string | null;
  problemPasses: number;
  runs: AaRun[];
}

const AA_PATH = /^(after-fix\/)?([^/]+)\/[^/]+-aa\.json$/;
const GITHUB_SETS: Record<string, { set: string; kind: AaKind }> = {
  'gha-cross-vm': { set: 'committed baseline, GitHub VMs', kind: 'committed' },
  'paired-aa': { set: 'paired control, GitHub VMs', kind: 'paired' },
};
const rawJobOf = (file: string): string | null =>
  /(?:^|\/)raw\/([^/]+)\/pass-\d+\.json$/.exec(file)?.[1] ?? null;

/** The same CPU model, written the way the runner's `/proc/cpuinfo` happened to write it: Intel(R) Xeon(R) ... and INTEL(R) XEON(R) ... */
function cpuName(model: string): string {
  const words = model
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/\s+CPU\b.*$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .trim()
    .split(/\s+/);
  const known: Record<string, string> = {
    AMD: 'AMD',
    EPYC: 'EPYC',
    INTEL: 'Intel',
    XEON: 'Xeon',
    PLATINUM: 'Platinum',
  };
  return words.map((word) => known[word.toUpperCase()] ?? word).join(' ');
}

function machineCpu(files: FileSet, dir: string, job: string | null): string | null {
  if (job === null) return null;
  const path = `${dir}/raw/${job}/machine.txt`;
  if (!files.has(path)) return null;
  return /^cpu: (.+)$/m.exec(files.text(path))?.[1]?.trim() ?? null;
}

function readAa(files: FileSet): AaFile[] {
  return files.list(PERF_RESULTS_DIR, /^(?:after-fix\/)?[^/]+\/[^/]+-aa\.json$/).map((path) => {
    const root = files.json(path);
    if (root.at('kind').str() !== 'perf-aa') root.at('kind').fail('expected "perf-aa"');
    const exitCodes = root.at('exitCodes');
    const runs = root.at('runs').list();
    const passes = root.at('passes').int();
    if (runs.length !== passes) root.at('runs').fail(`has ${runs.length} passes but "passes" says ${passes}`);
    const withProblems = runs.filter((run) => run.at('problems').list().length > 0);
    const firstLine = withProblems[0]?.at('problems').list()[0]?.str().split('\n')[0] ?? null;
    const within = path.slice(PERF_RESULTS_DIR.length + 1);
    const [, afterFix, dirName] = AA_PATH.exec(within) ?? [];
    const github = GITHUB_SETS[dirName ?? ''];
    const dir = `${PERF_RESULTS_DIR}/${dirName ?? ''}`;
    const paired = root.opt('paired') !== undefined;
    if (github !== undefined && (github.kind === 'paired') !== paired)
      root
        .at('paired')
        .fail(`${github.set}: a ${github.kind} set whose summary ${paired ? 'is' : 'is not'} paired`);
    return {
      path,
      set:
        github?.set ??
        (afterFix ? 'committed baseline, after a harness fix' : 'committed baseline, first run'),
      kind: paired ? 'paired' : 'committed',
      onGithub: github !== undefined,
      envId: root.at('envId').str(),
      profile: root.at('profile').str(),
      passes,
      exit0: exitCodes.at('0').int(),
      exit1: exitCodes.at('1').int(),
      exit2: exitCodes.at('2').int(),
      falsePositives: root.at('falsePositives').int(),
      alarms: root.at('firstBatchAlarms').int(),
      notReproduced: root.at('notReproduced').int(),
      firstProblem: firstLine,
      problemPasses: withProblems.length,
      runs: runs.map((run) => {
        const job = rawJobOf(run.at('file').str());
        const own = run.opt('cpuModel')?.str() ?? null;
        return {
          exitCode: run.at('exitCode').int(),
          cpu: own ?? (github === undefined ? null : machineCpu(files, dir, job)),
          job,
        };
      }),
    };
  });
}

const SET_ORDER = [
  'committed baseline, first run',
  'committed baseline, after a harness fix',
  'committed baseline, GitHub VMs',
  'paired control, GitHub VMs',
];

/** The CPU model of every VM (job) of a GitHub set, from the machine record each job uploaded next to its passes. */
function vmCpus(files: FileSet, dirName: string): string[] {
  const dir = `${PERF_RESULTS_DIR}/${dirName}`;
  return files.list(`${dir}/raw`, /^[^/]+\/machine\.txt$/).map((path) => {
    const cpu = /^cpu: (.+)$/m.exec(files.text(path))?.[1]?.trim();
    if (cpu === undefined) throw new ResultsError(`${path}: the machine record has no "cpu:" line`);
    return cpuName(cpu);
  });
}

function aaSection(aa: readonly AaFile[], vms: ReadonlyMap<string, readonly string[]>): string[] {
  if (aa.length === 0)
    return ['_No A/A summaries are committed (`docs/results/perf/<env>/<profile>-aa.json`)._'];
  const orderOf = (set: string): number => {
    const at = SET_ORDER.indexOf(set);
    return at === -1 ? SET_ORDER.length : at;
  };
  const ordered = [...aa].sort(
    (a, b) =>
      orderOf(a.set) - orderOf(b.set) || a.envId.localeCompare(b.envId) || a.profile.localeCompare(b.profile),
  );
  const table = mdTable(
    [
      'Set',
      'Environment',
      'Profile',
      'Passes',
      'Exit 0 / 1 / 2',
      'False positives',
      'First-batch alarms (not reproduced)',
    ],
    ordered.map((a) => [
      a.set,
      code(a.envId),
      code(a.profile),
      String(a.passes),
      `${a.exit0} / ${a.exit1} / ${a.exit2}`,
      String(a.falsePositives),
      `${a.alarms} (${a.notReproduced})`,
    ]),
  );

  const sets = [...new Set(ordered.map((a) => a.set))];
  const sum = (set: string, pick: (a: AaFile) => number): number =>
    ordered.filter((a) => a.set === set).reduce((n, a) => n + pick(a), 0);
  const machinesOf = (set: string): string => {
    const cpus = vms.get(set);
    if (cpus === undefined) return 'one machine';
    return `${plural(cpus.length, 'VM')} on ${plural(new Set(cpus).size, 'CPU model')}`;
  };
  const perSet = mdTable(
    ['Set', 'A/A passes', 'False positives (a pass that exited 1 with nothing changed)', 'Machines'],
    sets.map((set) => [
      set,
      String(sum(set, (a) => a.passes)),
      String(sum(set, (a) => a.falsePositives)),
      machinesOf(set),
    ]),
  );

  const github = SET_ORDER.filter((set) => vms.has(set) && sets.includes(set));
  const models = [...new Set(github.flatMap((set) => vms.get(set) ?? []))].sort();
  const perModel =
    github.length === 0
      ? []
      : [
          '',
          'On GitHub-hosted VMs, by the CPU model the job landed on (a runner label is a pool of machines):',
          '',
          mdTable(
            ['CPU model', ...github],
            models.map((model) => [
              model,
              ...github.map((set) => {
                const jobs = (vms.get(set) ?? []).filter((cpu) => cpu === model).length;
                const runs = ordered
                  .filter((a) => a.set === set)
                  .flatMap((a) => a.runs)
                  .filter((run) => run.cpu !== null && cpuName(run.cpu) === model);
                return jobs === 0 && runs.length === 0
                  ? '-'
                  : `${plural(jobs, 'VM')}, ${plural(runs.length, 'pass', 'passes')}, ${plural(runs.filter((run) => run.exitCode === 1).length, 'reproduced regression')}`;
              }),
            ]),
          ),
        ];

  const problems = ordered
    .filter((a) => a.problemPasses > 0 && a.firstProblem !== null)
    .map(
      (a) =>
        `${code(a.envId)} ${code(a.profile)} (${a.set}): ${a.problemPasses} of ${a.passes} passes ended with exit code 2, a measurement problem and never a regression; the first line of the first one: ${code(shorten(a.firstProblem ?? '', 150))}`,
    );
  return [
    table,
    '',
    perSet,
    ...perModel,
    ...(problems.length > 0 ? ['', ...problems.map((p) => `- ${p}`)] : []),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Sensitivity

export interface SensitivityRow {
  run: string;
  injected: string;
  metric: string;
  final: string;
}

const FINALS = ['regression', 'not-reproduced', 'pass', 'problem'] as const;

/** The table of runs of docs/results/perf/sensitivity/summary.md: one row per injected run and metric. */
export function parseSensitivity(markdown: string, file: string): SensitivityRow[] {
  const lines = markdown.split('\n');
  const head = lines.findIndex((line) => line.startsWith('| run | injected | metric |'));
  if (head < 0)
    throw new ResultsError(
      `${file}: the table of runs (a header starting "| run | injected | metric |") is not there`,
    );
  const header = splitCells(lines[head] ?? '');
  const column = (name: string): number => {
    const at = header.indexOf(name);
    if (at < 0) throw new ResultsError(`${file}: the table of runs has no "${name}" column`);
    return at;
  };
  const [run, injected, metric, final] = [
    column('run'),
    column('injected'),
    column('metric'),
    column('final'),
  ];
  const rows: SensitivityRow[] = [];
  let previous = '';
  for (let i = head + 2; i < lines.length && (lines[i] ?? '').startsWith('|'); i++) {
    const cells = splitCells(lines[i] ?? '');
    if (cells.length !== header.length) {
      throw new ResultsError(`${file}: line ${i + 1}: ${cells.length} cells under ${header.length} headings`);
    }
    const outcome = cells[final] ?? '';
    if (!(FINALS as readonly string[]).includes(outcome)) {
      throw new ResultsError(
        `${file}: line ${i + 1}: the final verdict "${outcome}" is not one of ${FINALS.join(', ')}`,
      );
    }
    // A run that was judged on several metrics has one row each, and the later rows say "(same)" for what was injected.
    const what = cells[injected] === '(same)' ? previous : (cells[injected] ?? '');
    previous = what;
    rows.push({ run: cells[run] ?? '', injected: what, metric: cells[metric] ?? '', final: outcome });
  }
  if (rows.length === 0) throw new ResultsError(`${file}: the table of runs has no rows`);
  return rows;
}

function sensitivitySection(files: FileSet): string[] {
  if (!files.has(SENSITIVITY_FILE))
    return ['_No sensitivity summary is committed (`docs/results/perf/sensitivity/summary.md`)._'];
  const rows = parseSensitivity(files.text(SENSITIVITY_FILE), SENSITIVITY_FILE);
  const groups = new Map<
    string,
    { injected: string; metric: string; counts: Map<string, number>; runs: number }
  >();
  for (const row of rows) {
    const key = `${row.injected}\u0000${row.metric}`;
    const group = groups.get(key) ?? {
      injected: row.injected,
      metric: row.metric,
      counts: new Map(),
      runs: 0,
    };
    group.runs += 1;
    group.counts.set(row.final, (group.counts.get(row.final) ?? 0) + 1);
    groups.set(key, group);
  }
  const outcomes = (counts: Map<string, number>): string =>
    FINALS.filter((f) => counts.has(f))
      .map((f) => `${counts.get(f)} ${f}`)
      .join(', ');
  return [
    mdTable(
      ['Injected on purpose', 'Measured', 'Runs', 'Final verdicts'],
      [...groups.values()].map((g) => [g.injected, g.metric, String(g.runs), outcomes(g.counts)]),
    ),
    '',
    `${plural(rows.length, 'row')} in ${link(SENSITIVITY_FILE, SENSITIVITY_FILE)}. \`regression\`: the metric failed in the first batch and again in a fresh browser, so the merge fails; \`not-reproduced\`: it failed once only, the first measurement is discarded and the merge passes; \`pass\`: it never failed; \`problem\`: the measurement could not be trusted.`,
  ];
}

// ---------------------------------------------------------------------------------------------------------------------

/** Four significant digits, as the gate writes its own sentences: 58.95, 200.6, 266.7. */
const sig4 = (value: number): string => String(Number(value.toPrecision(4)));
const signed = (share: number): string => `${share < 0 ? '-' : '+'}${Math.abs(share * 100).toFixed(1)} %`;

/** A real regression on a real pull request, as the paired gate reported it: the gate reports of its performance legs. */
function pairedSensitivitySection(files: FileSet): string[] {
  const paths = files
    .list(PAIRED_SENSITIVITY_DIR, /^[^/]+\.json$/)
    .sort((a, b) => a.replace(/\.json$/, '').localeCompare(b.replace(/\.json$/, '')));
  if (paths.length === 0) return [];
  const rows: string[][] = [];
  let passed = 0;
  for (const path of paths) {
    const root = files.json(path);
    if (root.at('kind').str() !== 'perf-gate-report') root.at('kind').fail('expected "perf-gate-report"');
    const paired = root.at('paired');
    if (paired.at('aa').bool())
      paired.at('aa').fail('a paired sensitivity report that is an A/A by construction');
    const cpus = paired.at('cpuModels');
    const same = cpus.at('same').bool();
    for (const scenario of root.at('scenarios').list()) {
      for (const metric of scenario.at('metrics').list()) {
        const verdict = metric.at('verdict').str();
        const first = metric.at('first');
        if (verdict === 'pass') passed += 1;
        if (verdict === 'pass' || verdict === 'tracked') continue;
        const fresh = metric.opt('remeasure');
        const median = first.at('median');
        const tail = first.at('tail');
        const rule = first.at('rule');
        const allowed = median.at('allowed').num();
        const freshMedian = fresh?.at('median');
        rows.push([
          code(root.at('profile').str()),
          `${scenario.at('id').str()} ${code(metric.at('metric').str())}`,
          `${sig4(median.at('baseline').num())} ms`,
          `${sig4(median.at('current').num())} ms (${signed(median.at('changeShare').num())}; p90 ${signed(tail.at('changeShare').num())})`,
          freshMedian === undefined
            ? 'not needed'
            : `${sig4(freshMedian.at('current').num())} ms (${signed(freshMedian.at('changeShare').num())}), worse by ${sig4(freshMedian.at('worseBy').num())} ms`,
          `${sig4(allowed)} ms (${fixed(rule.at('medianShare').num() * 100, 0)} % of the control, floor ${fixed(rule.at('floor').num(), 0)} ms)`,
          verdict,
          same
            ? `${cpuName(cpus.at('head').str())} for both`
            : `control ${cpuName(cpus.at('control').str())}, head ${cpuName(cpus.at('head').str())}`,
        ]);
      }
    }
  }
  return [
    mdTable(
      [
        'Profile',
        'Scenario and metric',
        'Control (median)',
        'Head, first batch',
        'Fresh batch',
        'Allowed on the median',
        'Verdict',
        'CPU model',
      ],
      rows,
    ),
    '',
    `${plural(passed, 'other gated metric')} passed in these reports. They are the gate reports of the two performance legs of a pull request that made startup slower by a known amount (${link('paired-sensitivity.md', PAIRED_SENSITIVITY_FILE)}): the control is the base commit, measured on the same machine as the head.`,
  ];
}

export function renderPerf(files: FileSet): Rendered {
  const loaded = readBaselines(files);
  if (loaded.length === 0) return emptyState('performance baselines', BASELINES_DIR);
  const derivation = readDerivation(files, loaded);
  const aa = readAa(files);
  const vms = new Map<string, string[]>();
  for (const [dirName, github] of Object.entries(GITHUB_SETS)) {
    if (aa.some((a) => a.set === github.set)) vms.set(github.set, vmCpus(files, dirName));
  }

  const lines: string[] = [
    '**Baselines** (one file per environment and profile)',
    '',
    mdTable(
      [
        'Environment',
        'Profile',
        'Browser',
        'Recorded',
        'Startup median / p90 (scenario)',
        'Startup CV',
        'Startup gate',
        'Metrics gated / tracked',
      ],
      baselineRows(loaded),
    ),
    '',
    baselineNote(loaded),
    '',
    '**What the baselines say about the thresholds** (relative rules: how much two batches of the same code differ, against what the committed policy allows)',
    '',
    needsTable(derivation),
    '',
    '**Rules judged by an absolute budget: what the baselines contain**',
    '',
    budgetsTable(derivation),
    '',
    `${link('threshold-derivation.md', 'docs/results/perf/threshold-derivation.md')} has the arithmetic; ${link('docs/PERF.md', 'docs/PERF.md')} says how to read and re-record a baseline.`,
    '',
    '**A/A checks** (the gate against its own baseline, or against a control measured on the same machine, with nothing changed)',
    '',
    ...aaSection(aa, vms),
    '',
    '**Sensitivity** (a regression injected on purpose, and what the gate did)',
    '',
    ...sensitivitySection(files),
  ];
  const paired = pairedSensitivitySection(files);
  if (paired.length > 0) {
    lines.push('', '**A regression on a pull request** (what the paired gate did with it)', '', ...paired);
  }
  const pages = [
    [
      CROSS_VM_FILE,
      'the committed baselines of `gha-linux-x64` against GitHub-hosted VMs',
      'gha-cross-vm.md',
    ],
    [PAIRED_AA_README, 'the paired gate against itself on GitHub-hosted VMs', 'paired-aa/README.md'],
  ] as const;
  const present = pages.filter(([path]) => files.has(path));
  if (present.length > 0) {
    lines.push(
      '',
      `Written up next to the data: ${listOf(present.map(([path, what, label]) => `${what} (${link(label, path)})`))}.`,
    );
  }
  return data(lines.join('\n'));
}
