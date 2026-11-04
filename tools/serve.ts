// `npm run serve`: the test data service (see src/server/cli.ts for the environment variables).
//
//   PB_PORT=4600 PB_LOG=1 npm run serve
//
// SIGINT and SIGTERM close the service and exit 0. A start that is refused (a stream that was not generated, a port in use) exits 1
// with the reason on stderr.

import { CliError, serveFromEnv } from '../src/server/cli.ts';
import type { RunningServer } from '../src/server/index.ts';

const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

let server: RunningServer;
try {
  server = await serveFromEnv(process.env, io);
} catch (err) {
  console.error(err instanceof CliError ? err.message : err);
  process.exit(1);
}

let stopping = false;
function stop(): void {
  // A second signal means "now": do not wait for a shutdown that is stuck.
  if (stopping) process.exit(1);
  stopping = true;
  // The process ends when the event loop is empty, which is the proof that nothing was left behind; if it does not, say so.
  setTimeout(() => {
    console.error('the service did not shut down within 10 s: something is holding the process open');
    process.exit(1);
  }, 10_000).unref();
  void server.close().then(() => {
    process.exitCode = 0;
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
