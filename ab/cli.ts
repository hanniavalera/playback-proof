import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { HarnessError } from '../src/lab/measure/runner.ts';
import { calibrate, evaluateAa, poolFromResult, renderCalibration } from './aa.ts';
import { analyzeResult } from './analyze.ts';
import type { ResultAnalysis } from './analyze.ts';
import { AB_USAGE, AbUsageError, parseAbArgs } from './args.ts';
import type { AbOptions } from './args.ts';
import { executeExperiment } from './execute.ts';
import type { Machine } from './execute.ts';
import {
  readCalibrations,
  readRawResult,
  resultStem,
  stemOfRawFile,
  writeCalibration,
  writeRawResult,
  writeReport,
} from './files.ts';
import type { CalibrationEntry } from './files.ts';
import { analyzePilot, renderPilot } from './pilot.ts';
import { gitRunnerFor, preregistrationCommit } from './provenance.ts';
import { PreregistrationError, loadPreregistration } from './prereg.ts';
import type { Engine } from './prereg.ts';
import { renderReport } from './report.ts';
import { ResultFileError } from './results.ts';
import type { RawResult } from './results.ts';
import { assessValidity, checkAaReport } from './validity.ts';
import type { Validity } from './validity.ts';

// `npm run ab -- ...`: the command line of the A/B harness. Everything but the machine is here and is unit-tested: the modes that need no
// browser (--report, --calibrate, --power) and the checks that come before a run (the plan is valid, the plan is committed, the A/A check it
// relies on has passed). What starts a service and a browser is ab/harness.ts, loaded only when a run really happens (and replaced by a
// fake in the tests).
//
// EXIT CODES. 0: the run is valid (whatever the verdict: A better, B better, equivalent and inconclusive are all results; the lab passes an
// experiment when it is valid, and the direction drives the decision, not the exit code). 1: an A/A check that the harness failed. 2: the
// run could not be trusted or started (an invalid, uncommitted or unsupported plan, a harness defect, a gate of validity that failed).

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

/** A committed file by its path from the repository (the A/A report an experiment relies on), or null. */
const readReference =
  (io: Io) =>
  (path: string): string | null => {
    const file = resolve(io.root, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };

/** One line per condition with its verdict, and one for validity: what a person or a pipeline reads from the output. */
function summaryLines(analysis: ResultAnalysis, validity: Validity): string[] {
  const lines = analysis.conditions.map(({ result, analysis: condition }) => {
    if (condition.decision)
      return `${analysis.prereg.id} ${result.id}: ${condition.decision.headline}. ${condition.decision.reason}`;
    return `${analysis.prereg.id} ${result.id}: no verdict${analysis.prereg.kind === 'pipeline-check' ? ' (pipeline check, plumbing only, not evidence)' : ''}.`;
  });
  lines.push(`${analysis.prereg.id} validity: ${validity.summary}`);
  return lines;
}

/** The exit code of a run or of a report (see the top of the file), and the problem to print when it is not 0. */
function exitFor(
  analysis: ResultAnalysis,
  validity: Validity,
  calibrations: readonly CalibrationEntry[],
): { code: number; problem: string | null } {
  if (!validity.valid) return { code: 2, problem: validity.summary };
  if (analysis.prereg.kind === 'aa') {
    const failedAa = analysis.conditions.some((entry) => !evaluateAa(entry.analysis).acceptable);
    const failedCalibration = calibrations.some((entry) => !entry.result.pass);
    if (failedAa || failedCalibration)
      return {
        code: 1,
        problem:
          'the A/A check failed: the harness declared a difference between identical configurations (see the report). No A/B verdict is published until it is understood.',
      };
  }
  return { code: 0, problem: null };
}

/** `--report`: the report of a raw results file, again, next to it (with the A/A calibrations that were written next to the raw results). */
function modeReport(options: AbOptions, io: Io): number {
  const rawPath = resolve(io.root, options.file);
  const raw = readRawResult(rawPath);
  const dir = options.outDir === null ? dirname(rawPath) : resultsDir(options, io);
  const stem = stemOfRawFile(rawPath);
  const calibrations = readCalibrations(dirname(rawPath), stem);
  const analysis = analyzeResult(raw);
  const validity = assessValidity(raw, analysis, { readReference: readReference(io) });
  const report = renderReport(raw, analysis, { rawFile: repoRelative(rawPath, io), calibrations, validity });
  const written = writeReport(dir, stem, report);
  io.err(`wrote ${repoRelative(written.markdown, io)} and ${repoRelative(written.json, io)}`);
  for (const line of summaryLines(analysis, validity)) io.out(line);
  const outcome = exitFor(analysis, validity, calibrations);
  if (outcome.problem !== null) io.err(`PROBLEM: ${outcome.problem}`);
  return outcome.code;
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
  const written = writeCalibration(
    dir,
    stemOfRawFile(rawPath),
    { condition: conditionId, result },
    renderCalibration(result),
  );
  io.out(renderCalibration(result));
  io.err(`wrote ${repoRelative(written.markdown, io)} and ${repoRelative(written.json, io)}`);
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

  // An experiment relies on the harness having passed its own check here: refuse before a single session, not after an hour of them.
  if (prereg.aaCheck !== null) {
    const check = checkAaReport(
      readReference(io)(prereg.aaCheck.source),
      prereg.aaCheck.source,
      prereg,
      machine.envId,
    );
    if (!check.passed) {
      await machine.stop();
      io.err(
        `PROBLEM: ${check.detail}\n\nNo A/B verdict is published until the harness has passed its own check in this environment (TEST_STRATEGY.md section 12).`,
      );
      return 2;
    }
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
  const validity = assessValidity(raw, analysis, { readReference: readReference(io) });
  const calibrations: CalibrationEntry[] = [];
  let calibrationProblem = false;
  if (prereg.kind === 'aa' && !options.noCalibration) {
    for (const condition of raw.conditions.filter((candidate) => candidate.aborted === null)) {
      const { plan: analysisPlan, sessions } = poolFromResult(raw, condition.id);
      io.err(
        `A/A calibration of ${condition.id}: ${sessions.length} sessions, ${options.splits ?? 2000} splits`,
      );
      try {
        const result = calibrate(analysisPlan, sessions, {
          seed: prereg.seed,
          ...(options.splits === null ? {} : { splits: options.splits }),
        });
        const entry = { condition: condition.id, result };
        calibrations.push(entry);
        const saved = writeCalibration(dir, stem, entry, renderCalibration(result));
        io.err(`wrote ${repoRelative(saved.markdown, io)} and ${repoRelative(saved.json, io)}`);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        calibrationProblem = true;
        io.err(`PROBLEM: the A/A calibration of ${condition.id} could not be made: ${error.message}`);
      }
    }
  }
  const report = renderReport(raw, analysis, {
    rawFile: repoRelative(rawFile, io),
    calibrations,
    validity,
  });
  const written = writeReport(dir, stem, report);
  io.err(`wrote ${repoRelative(written.markdown, io)} and ${repoRelative(written.json, io)}`);
  for (const line of summaryLines(analysis, validity)) io.out(line);

  const stopped = raw.conditions.filter((condition) => condition.aborted !== null);
  if (stopped.length > 0)
    io.err(
      `PROBLEM: ${stopped.map((condition) => `${condition.id} stopped early: ${condition.aborted}`).join('; ')}`,
    );
  if (calibrationProblem) return 2;
  const outcome = exitFor(analysis, validity, calibrations);
  if (outcome.problem !== null) io.err(`PROBLEM: ${outcome.problem}`);
  return outcome.code;
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
