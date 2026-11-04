// `npm run ab -- --prereg ab/prereg/<name>.json`: see `npm run ab -- --help` and ab/cli.ts. The command is in cli.ts so that it can be tested.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './cli.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

main(process.argv.slice(2), {
  root,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 2;
  },
);
