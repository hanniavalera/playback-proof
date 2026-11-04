import { appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cluster } from './cluster.ts';
import { collect } from './collect.ts';
import { redactValue } from './redact.ts';
import {
  buildReport,
  NOT_A_GATE,
  renderJson,
  renderMarkdown,
  renderStepSummary,
  renderText,
  writeReport,
} from './report.ts';
import { CACHE_DIR, NO_KEY_NOTE, optionsFromEnv, summarize } from './summarize.ts';
import type { SummarizeOptions, SummaryResult } from './summarize.ts';
import type { TriageReport } from './types.ts';

// `npm run triage -- [--from <dir>] [--from-ci] [--summarize] [--out <dir>] [--json]`: reads the Playwright output of a run, clusters its
// failures by root cause, prints and writes the report. `--from-ci` is the `gate:triage` stage of the pipelines: it reads the artifacts of the
// run it is in and NEVER fails the build, whatever it finds or whatever goes wrong (docs/TRIAGE.md).

export const USAGE = `usage: npm run triage -- [options]
  --from <dir>      the Playwright output to read: a reports directory, or a directory of downloaded CI artifacts
                    (reports-chromium/, reports-firefox/ ...), or one playwright.json (default: reports)
  --from-ci         the CI stage: read the artifacts of this run (--from, else $PB_TRIAGE_FROM, else ./artifacts, else ./reports),
                    always exit 0, and say so. Triage explains a red build; it never decides one
  --summarize       ask a language model for a draft of the likely root cause of each cluster, from the redacted evidence.
                    Needs ANTHROPIC_API_KEY (ANTHROPIC_MODEL, default claude-haiku-5-5; ANTHROPIC_BASE_URL). Without a key: one line, no summary
  --refresh         with --summarize: ask again even where a draft is cached (.cache/triage)
  --max-clusters N  with --summarize: summarize at most N clusters, the largest first (default 10)
  --out <dir>       where triage-report.md and triage-report.json are written (default reports/triage)
  --json            print the JSON report instead of the text
  --redact          redact the report (keys, hosts, home directories...) before it is printed or written: for a report that is published
  --help`;

export interface CliOptions {
  from: string | null;
  fromCi: boolean;
  summarize: boolean;
  refresh: boolean;
  maxClusters: number;
  out: string;
  json: boolean;
  redact: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = {
    from: null,
    fromCi: false,
    summarize: false,
    refresh: false,
    maxClusters: 10,
    out: 'reports/triage',
    json: false,
    redact: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    switch (arg) {
      case '--from-ci':
        options.fromCi = true;
        break;
      case '--summarize':
        options.summarize = true;
        break;
      case '--refresh':
        options.refresh = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--redact':
        options.redact = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--from':
      case '--out': {
        const given = value();
        if (given === null) return { error: `${arg} needs a directory` };
        if (arg === '--from') options.from = given;
        else options.out = given;
        break;
      }
      case '--max-clusters': {
        const given = value();
        const count = Number(given);
        if (given === null || !Number.isInteger(count) || count < 1)
          return { error: '--max-clusters needs a whole number of at least 1' };
        options.maxClusters = count;
        break;
      }
      default:
        return { error: `unknown option ${arg}` };
    }
  }
  return { options };
}

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => Date;
  /** The summarizer's `fetch` and `sleep`, for a test that must not touch the network or wait. */
  summarizer?: Partial<SummarizeOptions>;
}

/** The directory a run reads: the one it was given; in CI, the one the pipeline names, or the first of the usual places that exists. */
export function resolveFrom(
  options: CliOptions,
  io: Pick<Io, 'cwd' | 'env'>,
): { path: string; shown: string } {
  const pick = (shown: string) => ({ path: resolve(io.cwd, shown), shown });
  if (options.from !== null) return pick(options.from);
  if (!options.fromCi) return pick('reports');
  const named = io.env.PB_TRIAGE_FROM?.trim();
  const candidates = [...(named ? [named] : []), 'artifacts', 'reports'];
  return pick(candidates.find((candidate) => existsSync(resolve(io.cwd, candidate))) ?? 'reports');
}

/**
 * Runs triage and returns the exit code: 0 whenever it ran (what it found does not matter: it is not a gate), 2 when it could not run
 * (a bad option, nothing to read). With `--from-ci` it is 0 whatever happens.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  const fromCi = 'options' in parsed ? parsed.options.fromCi : argv.includes('--from-ci');
  try {
    if ('error' in parsed) {
      io.stderr(`triage: ${parsed.error}\n${USAGE}\n`);
      return fromCi ? 0 : 2;
    }
    const { options } = parsed;
    if (options.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const from = resolveFrom(options, io);
    const collection = collect(from.path, { roots: [resolve(io.cwd, 'test-results')], label: from.shown });
    const clusters = cluster(collection.failures);

    let summaries: SummaryResult | null = null;
    let summaryNote: string | null = null;
    if (options.summarize && clusters.length > 0) {
      const env = optionsFromEnv(io.env);
      if (env.apiKey === undefined) {
        // One line, said once, in the report: no key is not an error, and nothing was sent.
        summaryNote = NO_KEY_NOTE;
      } else {
        summaries = await summarize(clusters, {
          ...env,
          maxClusters: options.maxClusters,
          cacheDir: join(io.cwd, CACHE_DIR),
          refresh: options.refresh,
          log: (line) => io.stderr(`${line}\n`),
          ...io.summarizer,
        });
      }
    }

    let report: TriageReport = buildReport(collection, clusters, {
      from: from.shown,
      now: io.now?.() ?? new Date(),
      summaries,
      summaryNote,
    });
    if (options.redact) report = redactValue(report);

    const wrote: string[] = [];
    try {
      const paths = writeReport(resolve(io.cwd, options.out), {
        markdown: renderMarkdown(report),
        json: renderJson(report),
      });
      wrote.push(...paths.map((path) => path.replace(`${io.cwd}/`, '')));
    } catch (error) {
      io.stderr(`triage: could not write the report to ${options.out}: ${(error as Error).message}\n`);
    }
    io.stdout(options.json ? renderJson(report) : renderText(report, { fromCi, wrote }));

    const summaryFile = io.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      try {
        appendFileSync(summaryFile, `${renderStepSummary(report)}\n`);
      } catch (error) {
        io.stderr(`triage: could not append to the job summary: ${(error as Error).message}\n`);
      }
    }
    if (fromCi) return 0;
    return collection.sources.length === 0 ? 2 : 0;
  } catch (error) {
    io.stderr(
      `triage could not run: ${(error as Error).message}${fromCi ? ` (${NOT_A_GATE}: the build is not failed by it)` : ''}\n`,
    );
    return fromCi ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  void run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((code) => {
    // Not process.exit(): it can cut a pipe that has not been drained, and the report is what the stage is for.
    process.exitCode = code;
  });
}
