// What a README results block reads: the committed files, as text, by repository-relative path. Renderers take a FileSet and return
// strings, so they are unit-tested on the real committed files and on small synthetic ones (a number changed, a file deleted) without
// touching the disk. Every failure a renderer can meet is a ResultsError whose message names the file and the field, because the
// reader of `npm run docs:check` has to be told what to fix and not shown a stack.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class ResultsError extends Error {
  override name = 'ResultsError';
}

/** A block with something to show, or with nothing yet: the empty state says so in words and carries no number. */
export type Rendered = { kind: 'data'; markdown: string } | { kind: 'empty'; markdown: string };

export const data = (markdown: string): Rendered => ({ kind: 'data', markdown });

export function emptyState(what: string, where: string): Rendered {
  return {
    kind: 'empty',
    markdown: `_No ${what} are committed yet (\`${where}\`). \`npm run docs:check -- --write\` fills this block when they are._`,
  };
}

/** A file or a directory to read: a directory is walked, and only the paths that match (relative to the repository root) are kept. */
export interface Read {
  path: string;
  match?: RegExp;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'reports', 'test-results', '.cache', '.tmp']);

export class FileSet {
  readonly #files: ReadonlyMap<string, string>;

  constructor(files: Iterable<readonly [string, string]> | Readonly<Record<string, string>> = []) {
    const entries =
      Symbol.iterator in files
        ? (files as Iterable<readonly [string, string]>)
        : Object.entries(files as Record<string, string>);
    this.#files = new Map(entries);
  }

  get size(): number {
    return this.#files.size;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  /** Every path under `dir/`, sorted; `match` is tested against the part after `dir/`. */
  list(dir: string, match: RegExp = /./): string[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...this.#files.keys()]
      .filter((path) => path.startsWith(prefix) && match.test(path.slice(prefix.length)))
      .sort();
  }

  text(path: string): string {
    const text = this.#files.get(path);
    if (text === undefined) throw new ResultsError(`${path}: the file is missing`);
    return text;
  }

  json(path: string): Node {
    const text = this.text(path);
    try {
      return new Node(JSON.parse(text), path, '$');
    } catch (error) {
      throw new ResultsError(
        `${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /** A copy with one file added or replaced, for the mutation checks. */
  with(path: string, text: string): FileSet {
    return new FileSet([...this.#files, [path, text]]);
  }

  without(path: string): FileSet {
    return new FileSet([...this.#files].filter(([name]) => name !== path));
  }
}

function walk(root: string, relative: string, match: RegExp, out: Map<string, string>): void {
  const full = join(root, relative);
  const stat = statSync(full);
  if (stat.isDirectory()) {
    for (const name of readdirSync(full).sort()) {
      if (!SKIP_DIRS.has(name)) walk(root, relative === '' ? name : `${relative}/${name}`, match, out);
    }
  } else if (match.test(relative)) {
    out.set(relative, readFileSync(full, 'utf8'));
  }
}

/** Reads what the blocks declare they need. A path that does not exist is simply not in the set: the renderer says what is missing. */
export function loadFileSet(root: string, reads: readonly Read[]): FileSet {
  const out = new Map<string, string>();
  for (const read of reads) {
    if (existsSync(join(root, read.path))) walk(root, read.path, read.match ?? /./, out);
  }
  return new FileSet(out);
}

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string')
    return `the string "${value.length > 30 ? `${value.slice(0, 30)}...` : value}"`;
  return `${typeof value} ${String(value)}`;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A position in a parsed JSON file. Reading through it names the file and the path of whatever is wrong. */
export class Node {
  constructor(
    readonly value: unknown,
    readonly file: string,
    readonly path: string,
  ) {}

  fail(message: string): never {
    throw new ResultsError(`${this.file}: ${this.path}: ${message}`);
  }

  private expect(ok: boolean, what: string): void {
    if (!ok) this.fail(`expected ${what} but found ${describe(this.value)}`);
  }

  get isNull(): boolean {
    return this.value === null || this.value === undefined;
  }

  /** A member that must be there. */
  at(key: string): Node {
    this.expect(isObject(this.value), 'an object');
    const found = (this.value as Record<string, unknown>)[key];
    if (found === undefined) this.fail(`the field "${key}" is missing`);
    return new Node(found, this.file, `${this.path}.${key}`);
  }

  /** A member that may be absent or null. */
  opt(key: string): Node | undefined {
    this.expect(isObject(this.value), 'an object');
    const found = (this.value as Record<string, unknown>)[key];
    return found === undefined || found === null
      ? undefined
      : new Node(found, this.file, `${this.path}.${key}`);
  }

  list(): Node[] {
    this.expect(Array.isArray(this.value), 'a list');
    return (this.value as unknown[]).map((item, i) => new Node(item, this.file, `${this.path}[${i}]`));
  }

  entries(): Array<[string, Node]> {
    this.expect(isObject(this.value), 'an object');
    return Object.entries(this.value as Record<string, unknown>).map(([key, item]) => [
      key,
      new Node(item, this.file, `${this.path}.${key}`),
    ]);
  }

  num(): number {
    this.expect(typeof this.value === 'number' && Number.isFinite(this.value), 'a number');
    return this.value as number;
  }

  int(): number {
    this.expect(typeof this.value === 'number' && Number.isInteger(this.value), 'an integer');
    return this.value as number;
  }

  str(): string {
    this.expect(typeof this.value === 'string', 'a string');
    return this.value as string;
  }

  bool(): boolean {
    this.expect(typeof this.value === 'boolean', 'true or false');
    return this.value as boolean;
  }
}
