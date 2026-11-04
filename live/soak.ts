// `npm run soak -- --minutes N|ci|release --engine chromium|firefox|webkit [options]`
//
// A long live session, sampled by the page at its own cadence, with one injected origin outage (and, in a release soak, a stale manifest) at
// fixed points, the JS heap after a forced collection in Chromium, the harness's own memory, and the PB-RDY-005 evaluators at the end. It
// prints the summary and writes docs/results/soak/<env>-<engine>-<minutes>m.json (the series decimated, peaks kept).
//
// It needs the machine to itself for its whole length. A soak shorter than the CI length is reported and is not a verdict.
// `npm run soak -- --help` lists the options. What it does is in src/lab/readiness/commands.ts, where a unit test runs it over fakes; this
// file hands it the real service and the real browser.

import { runSoakCommand } from '../src/lab/readiness/commands.ts';
import { realDeps } from './common.ts';

runSoakCommand(process.argv.slice(2), realDeps()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 2;
  },
);
