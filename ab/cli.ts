import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { HarnessError } from '../src/lab/measure/runner.ts';
import { calibrate, evaluateAa, poolFromResult, renderCalibration } from './aa.ts';
import type { CalibrationResult } from './aa.ts';
import { analyzeResult } from './analyze.ts';
import { AB_USAGE, AbUsageError, parseAbArgs } from './args.ts';
import type { AbOptions } from './args.ts';
import { executeExperiment } from './execute.ts';
import type { Machine } from './execute.ts';
import { readRawResult, resultStem, stemOfRawFile, writeRawResult, writeReport } from './files.ts';
import { analyzePilot, renderPilot } from './pilot.ts';
import { gitRunnerFor, preregistrationCommit } from './provenance.ts';
import { PreregistrationError, loadPreregistration } from './prereg.ts';
import type { Engine } from './prereg.ts';
import { renderReport } from './report.ts';
import { ResultFileError } from './results.ts';
import type { RawResult } from './results.ts';

// `npm run ab -- ...`: the command line of the A/B harness. Everything but the machine is here and is unit-tested: the modes that need no
// browser (--report, --calibrate, --power) and the checks that come before a run (the plan is valid, the plan is committed). What starts a
// service and a browser is ab/harness.ts, loaded only when a run really happens (and replaced by a fake in the tests).

export interface Io {
  /** The checkout: where relative paths, the results directory and git are looked up. */
  root: string;
  out(text: string): void;
  err(text: string): void;
}

/** Starts the machine of a run (the service and the engine). Rejects when it cannot. */
export type StartMachine = (options: { port: number; engine: Engine }) => Promise<Machine>;

const defaultStartMachine: StartMachine = async (options) =>
  (await import('./harness.ts')).startAbHarness(options);

const MARKDOWN_SECTION = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

function resultsDir(options: AbOptions, io: Io): string {
  return options.outDir === null ? join(io.root, 'docs', 'results', 'ab') : resolve(io.root, options.outDir);
}

const repoRelative = (path: string, io: Io): string => relative(io.root, resolve(io.root, path));

function summaryLines(raw: RawResult): string[] {
  const analysis = analyzeResult(raw, { exploratory: false });
  return analysis.conditions.map(({ result, analysis: condition }) => {
    const verdict = condition.decision ? condition.decision.headline : 'no verdict';
    const reason = condition.decision ? ` ${condition.decision.reason}` : '';
    return `${analysis.prereg.id} ${result.id}: ${verdict}.${reason}`;
  });
}

/** `--report`: the report of a raw results file, again, next to it. */
function modeReport(options: AbOptions, io: Io): number {
  const rawPath = resolve(io.root, options.file);
  const raw = readRawResult(rawPath);
  const dir = options.outDir === null ? dirname(rawPath) : resultsDir(options, io);
  const stem = stemOfRawFile(rawPath);
  const report = renderReport(raw, analyzeResult(raw), { rawFile: repoRelative(rawPath, io) });
  const written = writeReport(dir, stem, report);
  io.err(`wrote ${repoRelative(written.markdown, io)} and ${repoRelative(written.json, io)}`);
  for (const line of summaryLines(raw)) io.out(line);
  return 0;
}

/** `--calibrate`: the A/A calibration of the pool of sessions of a results file. */
function modeCalibrate(options: AbOptions, io: Io): number {
  const rawPath = resolve(io.root, options.file);
  const raw = readRawResult(rawPath);
  const conditionId = options.condition ?? (raw.conditions[0]?.id as string);
  const { plan, sessions } = poolFromResult(raw, conditionId, { onlyA: options.onlyA });
  const result = calibrate(plan, sessions, {
    seed: options.seed ?? plan.seed,
    ...(options.splits === null ? {} : { splits: options.splits }),
    onProgress: (done, total) => {
      if (done % 250 === 0 || done === total) io.err(`calibration: ${done} of ${total} splits`);
    },
  });
  const dir = options.outDir === null ? dirname(rawPath) : resultsDir(options, io);
  const stem = `${stemOfRawFile(rawPath)}.calibration`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${stem}.json`),
    `${JSON.stringify({ condition: conditionId, ...result }, null, 2)}\n`,
  );
  writeFileSync(join(dir, `${stem}.md`), MARKDOWN_SECTION(renderCalibration(result)));
  io.out(renderCalibration(result));
  io.err(
    `wrote ${repoRelative(join(dir, `${stem}.md`), io)} and ${repoRelative(join(dir, `${stem}.json`), io)}`,
  );
  return result.pass ? 0 : 1;
}

/** `--power`: the minimum detectable effect and the operating characteristics of a design, from the sessions of configuration A of a results file. */
function modePower(options: AbOptions, io: Io): number {
  const rawPath = resolve(io.root, options.file);
  const raw = readRawResult(rawPath);
  const analysis = analyzePilot(raw, {
    ...(options.condition === null ? {} : { condition: options.condition }),
    ...(options.metrics === null ? {} : { metrics: options.metrics }),
    ...(options.sessionsPerArm === null ? {} : { sessionsPerArm: options.sessionsPerArm }),
    ...(options.simulations === null ? {} : { simulations: options.simulations }),
    ...(options.seed === null ? {} : { seed: options.seed }),
    onlyA: options.onlyA,
  });
  const dir = options.outDir === null ? dirname(rawPath) : resultsDir(options, io);
  const stem = `${stemOfRawFile(rawPath)}.power-${analysis.sessionsPerArm}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stem}.json`), `${JSON.stringify(analysis, null, 2)}\n`);
  writeFileSync(join(dir, `${stem}.md`), MARKDOWN_SECTION(renderPilot(analysis)));
  io.out(renderPilot(analysis));
  io.err(
    `wrote ${repoRelative(join(dir, `${stem}.md`), io)} and ${repoRelative(join(dir, `${stem}.json`), io)}`,
  );
  return 0;
}

/** `--prereg`: refuses without a valid, committed plan; then starts the machine and runs it. */
async function modeRun(
  options: AbOptions,
  argv: readonly string[],
  io: Io,
  startMachine: StartMachine,
): Promise<number> {
  let loaded;
  try {
    loaded = loadPreregistration(resolve(io.root, options.file));
  } catch (error) {
    if (error instanceof PreregistrationError) {
      io.err(
        `PROBLEM: ${error.message}\n\nThe runner refuses to run without a valid pre-registration (ab/prereg.ts).`,
      );
      return 2;
    }
    throw error;
  }
  const path = repoRelative(loaded.path, io);
  const plan = { ...loaded, path };
  for (const warning of loaded.warnings) io.err(`warning: ${warning}`);

  const committed = preregistrationCommit(path, gitRunnerFor(io.root));
  const fixed = committed !== null && committed.clean && committed.commit !== null;
  if (!fixed && !options.allowUncommittedPrereg) {
    const why =
      committed === null
        ? 'git cannot say'
        : committed.commit === null
          ? 'git does not track it'
          : 'it has changes against HEAD';
    io.err(
      `PROBLEM: ${path} is not committed unmodified (${why}).\n` +
        'Commit the pre-registration before the data run: the report proves the plan was fixed first only if it was. ' +
        '--allow-uncommitted-prereg runs anyway, and the report then says it proves nothing.',
    );
    return 2;
  }

  const prereg = loaded.prereg;
  if (prereg.kind !== 'aa' && (options.noCalibration || options.splits !== null))
    throw new AbUsageError(
      `${options.noCalibration ? '--no-calibration' : '--splits'} belongs to the run of an A/A pre-registration (kind "aa"); ${path} is kind "${prereg.kind}"`,
    );
  let machine: Machine;
  try {
    machine = await startMachine({ port: options.port, engine: prereg.engine });
  } catch (error) {
    io.err(
      `PROBLEM: the service or the browser could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  let raw: RawResult;
  try {
    raw = await executeExperiment(
      {
        loaded: plan,
        committed,
        command: `npm run ab -- ${argv.join(' ')}`,
        condition: options.condition,
        environment: {
          envId: machine.envId,
          host: machine.host,
          ffmpeg: machine.ffmpeg,
          streams: machine.streams,
        },
      },
      {
        ...machine.deps,
        onProgress: (event) => {
          if (event.kind === 'condition')
            io.err(
              `[${prereg.id} ${event.condition}] ${event.sessions} sessions, the first ${event.warmup} are the warm-up`,
            );
          else {
            const record = event.record;
            const shown =
              record.status === 'ok'
                ? `startup ${String(record.values.startupMs ?? 'n/a')} ms, start ${String(record.startRungHeight)}p`
                : `FAILED ${record.failure?.kind}: ${record.failure?.message.split('\n')[0]}`;
            io.err(
              `[${prereg.id} ${event.condition}] ${record.index + 1}/${event.total} ${record.warmup ? 'warm-up ' : ''}${record.arm}: ${shown}, ${(record.durationMs / 1000).toFixed(1)} s`,
            );
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof HarnessError || error instanceof RangeError) {
      io.err(`PROBLEM: ${error.message}`);
      return 2;
    }
    throw error;
  } finally {
    await machine.stop();
  }

  const dir = resultsDir(options, io);
  const stem = resultStem(prereg.id, machine.envId, raw.run.startedAt);
  const rawFile = writeRawResult(dir, stem, raw);
  io.err(`wrote ${repoRelative(rawFile, io)}`);

  const analysis = analyzeResult(raw);
  const calibrations: Array<{ condition: string; result: CalibrationResult }> = [];
  if (prereg.kind === 'aa' && !options.noCalibration) {
    for (const condition of raw.conditions) {
      const { plan: analysisPlan, sessions } = poolFromResult(raw, condition.id);
      io.err(
        `A/A calibration of ${condition.id}: ${sessions.length} sessions, ${options.splits ?? 2000} splits`,
      );
      calibrations.push({
        condition: condition.id,
        result: calibrate(analysisPlan, sessions, {
          seed: prereg.seed,
          ...(options.splits === null ? {} : { splits: options.splits }),
        }),
      });
    }
  }
  const report = renderReport(raw, analysis, { rawFile: repoRelative(rawFile, io), calibrations });
  const written = writeReport(dir, stem, report);
  io.err(`wrote ${repoRelative(written.markdown, io)} and ${repoRelative(written.json, io)}`);
  for (const line of summaryLines(raw)) io.out(line);

  const stopped = raw.conditions.filter((condition) => condition.aborted !== null);
  if (stopped.length > 0) {
    io.err(
      `PROBLEM: ${stopped.map((condition) => `${condition.id} stopped early: ${condition.aborted}`).join('; ')}`,
    );
    return 2;
  }
  if (prereg.kind === 'aa') {
    const failedAa = analysis.conditions.some((entry) => !evaluateAa(entry.analysis).acceptable);
    const failedCalibration = calibrations.some((entry) => !entry.result.pass);
    if (failedAa || failedCalibration) {
      io.err(
        'the A/A check failed: the harness declared a difference between identical configurations (see the report). No A/B verdict is published until it is understood.',
      );
      return 1;
    }
  }
  return 0;
}

/** The command: returns the exit code. */
export async function main(
  argv: readonly string[],
  io: Io,
  startMachine: StartMachine = defaultStartMachine,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: AbOptions;
  try {
    options = parseAbArgs(argv, env);
  } catch (error) {
    if (error instanceof AbUsageError) {
      io.err(`${error.message}\n\n${AB_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    io.out(AB_USAGE);
    return 0;
  }
  try {
    switch (options.mode) {
      case 'run':
        return await modeRun(options, argv, io, startMachine);
      case 'report':
        return modeReport(options, io);
      case 'calibrate':
        return modeCalibrate(options, io);
      case 'power':
        return modePower(options, io);
    }
  } catch (error) {
    if (error instanceof AbUsageError) {
      io.err(`${error.message}\n\n${AB_USAGE}`);
      return 2;
    }
    if (
      error instanceof RangeError ||
      error instanceof ResultFileError ||
      error instanceof PreregistrationError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      io.err(`PROBLEM: ${(error as Error).message}`);
      return 2;
    }
    throw error;
  }
}
