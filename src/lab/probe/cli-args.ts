import { parseArgs } from 'node:util';
import { findCase } from './formats.ts';

// Command line of tools/codec-matrix.ts, parsed here so it can be unit-tested without starting a browser.

export const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export type CliMode = 'run' | 'render' | 'check' | 'media-only' | 'help';

export interface CliOptions {
  mode: CliMode;
  browsers: EngineName[];
  attempts: number;
  /** Result file to write. Default (decided by the tool): docs/results/codec-matrix/<envId>.json. */
  out?: string;
  /** Only these case ids; undefined: every case. */
  cases?: string[];
  controls: boolean;
  sensitivity: boolean;
  freshProcess: boolean;
  timeoutMs: number;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE = `npm run codec-matrix -- [options]

Probes what the installed browsers can really play through MediaSource and writes the result as JSON.

  --browsers chromium,firefox,webkit  engines to probe (default: all three)
  --attempts N                        attempts per case, default 3; more than one is what reveals an intermittent engine
  --out FILE                          result file (default: docs/results/codec-matrix/<environment id>.json)
  --cases ID,ID                       only these cases (needs --out; skips the controls and the sensitivity runs unless
                                      --controls / --sensitivity is given)
  --controls / --no-controls          plain <video src> playback of the same files (default: on)
  --sensitivity / --no-sensitivity    the primary flavour under differently behaving pages (default: on)
  --no-fresh-process                  share one browser process between attempts (default: a fresh process per attempt)
  --timeout MS                        safety-net deadline of one attempt, default 20000
  --media-only                        generate the probe media into .cache/probe-media and exit

  --render                            regenerate docs/CODEC_MATRIX.md from every JSON file in docs/results/codec-matrix/
  --check                             exit 1 if docs/CODEC_MATRIX.md is not what --render would write (or a JSON file is invalid)
  --help                              this text

Inside the Playwright image (Firefox on a macOS host, the Linux environment):
  npm run docker:pw -- npm run codec-matrix -- --browsers chromium,firefox,webkit
`;

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  return Number(value);
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      allowNegative: true,
      options: {
        browsers: { type: 'string' },
        attempts: { type: 'string' },
        out: { type: 'string' },
        cases: { type: 'string' },
        controls: { type: 'boolean' },
        sensitivity: { type: 'boolean' },
        'fresh-process': { type: 'boolean' },
        timeout: { type: 'string' },
        'media-only': { type: 'boolean' },
        render: { type: 'boolean' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const runFlags = [
    'browsers',
    'attempts',
    'out',
    'cases',
    'controls',
    'sensitivity',
    'fresh-process',
    'timeout',
  ] as const;
  const used = runFlags.filter((flag) => values[flag] !== undefined);
  const modes = (['render', 'check', 'media-only'] as const).filter((flag) => values[flag]);

  let mode: CliMode = 'run';
  if (values.help) mode = 'help';
  else if (modes.length > 1) throw new UsageError(`--${modes.join(' and --')} cannot be combined`);
  else if (modes[0]) {
    if (used.length > 0)
      throw new UsageError(`--${modes[0]} takes no probe options (got --${used.join(', --')})`);
    mode = modes[0];
  }

  const browsers = (values.browsers ?? ENGINE_NAMES.join(',')).split(',').map((name) => name.trim());
  for (const name of browsers) {
    if (!(ENGINE_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(`unknown browser "${name}" (expected ${ENGINE_NAMES.join(', ')})`);
    }
  }

  let cases: string[] | undefined;
  if (values.cases !== undefined) {
    cases = values.cases.split(',').map((id) => id.trim());
    for (const id of cases) if (!findCase(id)) throw new UsageError(`unknown case "${id}"`);
    if (values.out === undefined && mode === 'run') {
      throw new UsageError(
        "--cases makes a partial result: give --out so it cannot overwrite the environment's full result file",
      );
    }
  }

  return {
    mode,
    browsers: [...new Set(browsers)] as EngineName[],
    attempts: values.attempts === undefined ? 3 : positiveInteger(values.attempts, '--attempts'),
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(cases ? { cases } : {}),
    controls: values.controls ?? cases === undefined,
    sensitivity: values.sensitivity ?? cases === undefined,
    freshProcess: values['fresh-process'] ?? true,
    timeoutMs: values.timeout === undefined ? 20_000 : positiveInteger(values.timeout, '--timeout'),
  };
}
