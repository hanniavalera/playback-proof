import { parseArgs } from 'node:util';

// The command line of `npm run ab` (ab/run.ts), parsed here so that it is unit-tested without a browser.

/** The A/B range of docs/CONTRACTS.md section 8 is 4700 to 4729 shared with the performance harness; this lab's A/B work has 4720 to 4729. */
export const DEFAULT_AB_PORT = 4720;

export type AbMode = 'run' | 'report' | 'calibrate' | 'power';

export interface AbOptions {
  mode: AbMode;
  /** run: the pre-registration file. report, calibrate, power: the raw results file. */
  file: string;
  port: number;
  outDir: string | null;
  /** run: only this condition of the pre-registration. calibrate, power: the condition whose sessions are the pool. */
  condition: string | null;
  allowUncommittedPrereg: boolean;
  /** run: skip the A/A calibration that an A/A run appends to its report. */
  noCalibration: boolean;
  /** calibrate, power: use only the sessions of configuration A of a file (an experiment's file has configuration B in it too). */
  onlyA: boolean;
  splits: number | null;
  simulations: number | null;
  /** power: the metrics to compute the minimum detectable effect of (default: the primary metrics of the plan). */
  metrics: string[] | null;
  /** power: sessions per arm of the design (default: the plan's). */
  sessionsPerArm: number | null;
  seed: number | null;
  help: boolean;
}

export class AbUsageError extends Error {
  override name = 'AbUsageError';
}

export const AB_USAGE = `npm run ab -- --prereg ab/prereg/<name>.json   run the experiment of a pre-registration (refuses without a valid one)
npm run ab -- --report <raw results>           write the report of a raw results file again (no browser)
npm run ab -- --calibrate <raw results>        the A/A calibration of the pool of sessions of a results file (no browser)
npm run ab -- --power <raw results>            power and minimum detectable effect from the sessions of configuration A of a results file

The runner starts the test data service as a child process, drives the engine through Playwright, and writes under docs/results/ab/:
<id>.<env>.<stamp>.raw.json (every session), .report.json and .report.md. Run it alone on a quiet machine.
Exit codes: 0 done (whatever the verdict: inconclusive and "no difference" are results); 1 an A/A check that the harness failed;
2 the run could not be trusted or started: an invalid or uncommitted pre-registration, a harness error, a condition that was stopped.

  --prereg FILE               the pre-registration to run (ab/prereg/<name>.json)
  --report FILE               a raw results file to write the report of
  --calibrate FILE            a raw results file whose sessions are the pool of an A/A calibration
  --power FILE                a raw results file whose sessions of configuration A are the pilot of a power analysis
  --condition ID              run: only this condition. calibrate, power: the condition whose sessions are used (default: the first)
  --port N                    port of the service child process (default PB_PORT, else ${DEFAULT_AB_PORT}; the A/B range is 4720 to 4729)
  --out-dir D                 where the results are written (default docs/results/ab)
  --allow-uncommitted-prereg  run although git cannot say the plan was committed unmodified: the report then says it proves nothing
  --no-calibration            run: an A/A run appends the calibration of its own pool to the report unless this is given
  --only-a                    calibrate, power: take only the sessions of configuration A (a file of an experiment holds both)
  --splits N                  calibrate, and run of an A/A plan: random splits of the calibration (default 2000, at least 100)
  --simulations N             power: simulated experiments per estimate (default 1000)
  --metric a,b                power: the metrics (default: the primary metrics of the plan)
  --sessions-per-arm N        power: the design to evaluate (default: the plan's)
  --seed N                    calibrate, power: the seed (default: the plan's)
  --help
`;

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new AbUsageError(`${flag} must be a positive integer, got "${value}"`);
  return Number(value);
}

export function parseAbArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): AbOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        prereg: { type: 'string' },
        report: { type: 'string' },
        calibrate: { type: 'string' },
        power: { type: 'string' },
        condition: { type: 'string' },
        port: { type: 'string' },
        'out-dir': { type: 'string' },
        'allow-uncommitted-prereg': { type: 'boolean' },
        'no-calibration': { type: 'boolean' },
        'only-a': { type: 'boolean' },
        splits: { type: 'string' },
        simulations: { type: 'string' },
        metric: { type: 'string' },
        'sessions-per-arm': { type: 'string' },
        seed: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new AbUsageError(error instanceof Error ? error.message : String(error));
  }

  const modes: Array<[AbMode, string | undefined]> = [
    ['run', values.prereg],
    ['report', values.report],
    ['calibrate', values.calibrate],
    ['power', values.power],
  ];
  const chosen = modes.filter(([, file]) => file !== undefined);
  if (values.help) {
    return blank('run', '', values.help);
  }
  if (chosen.length === 0)
    throw new AbUsageError('say what to do: --prereg, --report, --calibrate or --power');
  if (chosen.length > 1)
    throw new AbUsageError(
      `one thing at a time: ${chosen.map(([mode]) => `--${mode === 'run' ? 'prereg' : mode}`).join(' and ')} were both given`,
    );
  const [mode, file] = chosen[0] as [AbMode, string];
  if (file.trim() === '') throw new AbUsageError(`--${mode === 'run' ? 'prereg' : mode} needs a file`);

  const portText = values.port ?? env.PB_PORT ?? String(DEFAULT_AB_PORT);
  if (!/^[1-9][0-9]*$/.test(portText) || Number(portText) > 65_535)
    throw new AbUsageError(`the port must be an integer from 1 to 65535, got "${portText}"`);
  const seed = values.seed === undefined ? null : Number(values.seed);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32))
    throw new AbUsageError(
      `--seed must be an integer from 0 to ${2 ** 32 - 1}, got "${String(values.seed)}"`,
    );

  const options: AbOptions = {
    ...blank(mode, file, false),
    port: Number(portText),
    outDir: values['out-dir'] ?? null,
    condition: values.condition ?? null,
    allowUncommittedPrereg: values['allow-uncommitted-prereg'] ?? false,
    noCalibration: values['no-calibration'] ?? false,
    onlyA: values['only-a'] ?? false,
    splits: values.splits === undefined ? null : positiveInteger(values.splits, '--splits'),
    simulations:
      values.simulations === undefined ? null : positiveInteger(values.simulations, '--simulations'),
    metrics:
      values.metric === undefined
        ? null
        : values.metric
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== ''),
    sessionsPerArm:
      values['sessions-per-arm'] === undefined
        ? null
        : positiveInteger(values['sessions-per-arm'], '--sessions-per-arm'),
    seed,
  };
  const misplaced: Array<[boolean, string, AbMode[]]> = [
    [options.allowUncommittedPrereg, '--allow-uncommitted-prereg', ['run']],
    [options.noCalibration, '--no-calibration', ['run']],
    [options.onlyA, '--only-a', ['calibrate', 'power']],
    [options.splits !== null, '--splits', ['run', 'calibrate']],
    [options.simulations !== null, '--simulations', ['power']],
    [options.metrics !== null, '--metric', ['power']],
    [options.sessionsPerArm !== null, '--sessions-per-arm', ['power']],
    [options.seed !== null, '--seed', ['calibrate', 'power']],
    [options.condition !== null, '--condition', ['run', 'calibrate', 'power']],
  ];
  for (const [given, flag, modesAllowed] of misplaced) {
    if (given && !modesAllowed.includes(mode))
      throw new AbUsageError(
        `${flag} belongs to ${modesAllowed.map((m) => `--${m === 'run' ? 'prereg' : m}`).join(' and ')}, not to --${mode === 'run' ? 'prereg' : mode}`,
      );
  }
  return options;
}

function blank(mode: AbMode, file: string, help: boolean): AbOptions {
  return {
    mode,
    file,
    port: DEFAULT_AB_PORT,
    outDir: null,
    condition: null,
    allowUncommittedPrereg: false,
    noCalibration: false,
    onlyA: false,
    splits: null,
    simulations: null,
    metrics: null,
    sessionsPerArm: null,
    seed: null,
    help,
  };
}
