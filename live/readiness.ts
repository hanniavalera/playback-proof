// `npm run readiness -- [options]`
//
// Runs the live-event readiness checks of TEST_STRATEGY.md section 8 (PB-RDY-001 to PB-RDY-004) for the chosen engines, in the build as it
// ships (A, Shaka's defaults) and in the candidate configurations asked for, prints the go/no-go sheet with a measured value, a limit and a
// verdict on every line, then the checklist, and writes docs/results/readiness/<env>-<engine>[-<protocol>].json (A and the candidates of the
// run in one file).
//
// It needs the machine to itself: a check is a measurement. `npm run readiness -- --help` lists the options. What it does is in
// src/lab/readiness/commands.ts, where a unit test runs it over fakes; this file hands it the real service and the real browsers.

import { runReadinessCommand } from '../src/lab/readiness/commands.ts';
import { realDeps } from './common.ts';

runReadinessCommand(process.argv.slice(2), realDeps()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 2;
  },
);
