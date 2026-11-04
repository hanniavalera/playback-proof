import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// What the tests of the CI files share (tests/unit/ci). The workflows are read as text: the repository has no YAML parser, and the
// formats here are the ones Prettier writes, so a regular expression over a job or a step is exact enough, and a file that stops
// being in that shape fails the tests that look for it instead of passing them.

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

export const WORKFLOW_DIR = '.github/workflows';
export const workflowFiles = readdirSync(join(ROOT, WORKFLOW_DIR))
  .filter((name) => name.endsWith('.yml'))
  .sort();
export const actionFiles = readdirSync(join(ROOT, '.github/actions'))
  .map((name) => `.github/actions/${name}/action.yml`)
  .filter((path) => existsSync(join(ROOT, path)));
export const allFiles = [...workflowFiles.map((name) => `${WORKFLOW_DIR}/${name}`), ...actionFiles];

/** The file without its comment lines: a rule must not trip over the sentence that explains it. */
export const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

/** The text of each job under `jobs:`, by job id (a job id is a key indented by two spaces). */
export function jobsOf(workflow: string): Map<string, string> {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  if (start < 0) return new Map();
  const body = workflow.slice(start + marker.length);
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  const jobs = new Map<string, string>();
  heads.forEach((head, i) => {
    jobs.set(head[1] ?? '', body.slice(head.index, heads[i + 1]?.index ?? body.length));
  });
  return jobs;
}

export interface Leg {
  leg: string;
  project: string;
  browser: string;
  runner: string;
  experimental: boolean;
  /** Minutes the runner lets the job run. */
  timeout: number;
  /** Milliseconds Playwright lets the test run take (`--global-timeout`). */
  limit: number;
}

/** The `matrix.include` entries of a job: each starts with `- leg:` and its other keys are indented by twelve spaces. */
export function legsOf(job: string): Leg[] {
  const include = job.slice(Math.max(job.indexOf('include:'), 0));
  return include
    .split(/^ {10}- leg: /m)
    .slice(1)
    .map((entry) => {
      const lines = entry.split('\n');
      const fields = new Map<string, string>([['leg', (lines[0] ?? '').trim()]]);
      for (const line of lines.slice(1)) {
        const field = /^ {12}([a-z]+): (.+)$/.exec(line);
        if (!field) break;
        fields.set(field[1] ?? '', (field[2] ?? '').trim());
      }
      return {
        leg: fields.get('leg') ?? '',
        project: fields.get('project') ?? '',
        browser: fields.get('browser') ?? '',
        runner: fields.get('runner') ?? '',
        experimental: fields.get('experimental') === 'true',
        timeout: Number(fields.get('timeout')),
        limit: Number(fields.get('limit')),
      };
    });
}

export interface Step {
  /** The `name:` of the step, or the `uses:` / `id:` it has none. */
  name: string;
  /** The text of the step with every key of the step indented by eight spaces, as the keys after the first one are in the file. */
  text: string;
}

/** The steps of a job: its list items (a step of a job is a list item indented by six spaces). */
export function stepsOf(job: string): Step[] {
  return job
    .split(/^ {6}- /m)
    .slice(1)
    .map((raw) => {
      const text = ' '.repeat(8) + raw;
      return {
        text,
        name:
          /^ {8}name: (.+)$/m.exec(text)?.[1]?.trim() ??
          /^ {8}uses: (.+)$/m.exec(text)?.[1]?.trim() ??
          /^ {8}id: (.+)$/m.exec(text)?.[1]?.trim() ??
          '',
      };
    });
}

/**
 * The shell command of a step as the shell receives it: a one-line `run:`, a literal block (`|`) with its line breaks, or a folded
 * block (`>-`) with its lines joined by a space. Null when the step has no `run:`.
 */
export function commandOf(step: Step): string | null {
  const head = /^ {8}run: (.*)$/m.exec(step.text);
  if (!head) return null;
  const indicator = /^([>|])[-+]?$/.exec((head[1] ?? '').trim());
  if (!indicator) return (head[1] ?? '').trim();
  const after = step.text.slice((head.index ?? 0) + head[0].length + 1).split('\n');
  const body: string[] = [];
  for (const line of after) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith(' '.repeat(10))) break;
    body.push(line.trim());
  }
  const text = indicator[1] === '>' ? body.join(' ') : body.join('\n');
  return text.replace(/\s+$/, '');
}

/** The step of a job whose name starts with `prefix`. */
export function stepNamed(job: string, prefix: string): Step | undefined {
  return stepsOf(job).find((step) => step.name.startsWith(prefix));
}

/**
 * The words of a command line as a shell reads them, for the little these files use: whitespace separates, double and single quotes
 * group, and `$NAME` or `${NAME}` is replaced from `vars` (not inside single quotes; an unknown name stays as it is).
 */
export function words(command: string, vars: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  const expand = (text: string): string =>
    text.replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      return name in vars ? (vars[name] as string) : whole;
    });
  let chunk = '';
  const flushChunk = (literal: boolean): void => {
    current += literal ? chunk : expand(chunk);
    chunk = '';
  };
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") {
        flushChunk(true);
        quote = null;
      } else chunk += ch;
    } else if (quote === '"') {
      if (ch === '"') {
        flushChunk(false);
        quote = null;
      } else chunk += ch;
    } else if (ch === '"' || ch === "'") {
      flushChunk(false);
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      flushChunk(false);
      if (started || current !== '') out.push(current);
      current = '';
      started = false;
    } else {
      chunk += ch;
      started = true;
    }
  }
  flushChunk(quote === "'");
  if (started || current !== '') out.push(current);
  return out;
}

/** The arguments `npm run <script> -- ...` is given in a command line, up to the first `||`, `&&` or `;`. Null when it is not called. */
export function scriptArgs(
  command: string,
  script: string,
  vars: Readonly<Record<string, string>> = {},
): string[] | null {
  const tokens = words(command, vars);
  const at = tokens.findIndex((t, i) => t === 'npm' && tokens[i + 1] === 'run' && tokens[i + 2] === script);
  if (at < 0) return null;
  const rest = tokens.slice(at + 3);
  const cut = rest.findIndex((t) => t === '||' || t === '&&' || t === ';');
  const args = cut < 0 ? rest : rest.slice(0, cut);
  return args[0] === '--' ? args.slice(1) : args;
}
