import { dirname } from 'node:path/posix';
import type { StackFrame } from './types.ts';

// The application frames of a failure's stack. A Playwright error's stack is the Node process's: the test, the lab's helpers, then
// Playwright and Node. Triage keeps the lab's own frames only (the ones a person can edit), relative to the repository root so that
// the same failure on two machines reads the same.

export const MAX_FRAMES = 5;

const FRAME = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** The top-level directories of the repository, as they appear in a path. `live` is last: `tests/live` must not be read as `live`. */
const TOP_DIRS = ['tests', 'src', 'tools', 'flake', 'perf', 'ab', 'triage'];
const AMBIGUOUS_TOP_DIR = 'live';

const toPosix = (path: string): string => path.replace(/\\/g, '/');

function isApplicationPath(path: string): boolean {
  if (path.startsWith('node:') || path.startsWith('internal/') || path === '<anonymous>') return false;
  return !/(?:^|\/)node_modules\//.test(path);
}

/**
 * A path as the repository writes it (`tests/e2e/rec/faults.ts`). With the report's `rootDir` (Playwright's test directory, whose
 * parent is the repository) it is exact; without, the last `tests/`, `src/`... segment names the root, which is right for this
 * repository's layout and the reason the fallback is documented as a heuristic (docs/TRIAGE.md).
 */
export function repoRelative(path: string, rootDir?: string | null): string {
  const posix = toPosix(path.replace(/^file:\/\//, ''));
  if (rootDir) {
    const root = toPosix(rootDir).replace(/\/+$/, '');
    const repo = TOP_DIRS.includes(root.split('/').pop() ?? '') ? dirname(root) : root;
    if (repo !== '' && posix.startsWith(`${repo}/`)) return posix.slice(repo.length + 1);
  }
  const segments = posix.split('/');
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (TOP_DIRS.includes(segments[i] ?? '')) return segments.slice(i).join('/');
  }
  const live = segments.lastIndexOf(AMBIGUOUS_TOP_DIR);
  if (live >= 0 && live < segments.length - 1) return segments.slice(live).join('/');
  return segments.slice(-3).join('/');
}

/** The function a frame names, or null for an anonymous one (the body of a test, an arrow function). */
function functionName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const name = raw.replace(/^new\s+/, '').trim();
  if (name === '' || name.includes('<anonymous>') || name === 'async') return null;
  return name;
}

export function isSpecFile(file: string): boolean {
  return /\.spec\.[cm]?[jt]s$/.test(file);
}

/**
 * The frames of `stack` that are the lab's own code, the top one first. The message at the head of a stack (`Error: ...`) and the
 * lines that are not frames are skipped.
 */
export function applicationFrames(
  stack: string | undefined | null,
  options: { rootDir?: string | null; max?: number } = {},
): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split(/\r?\n/)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, name, rawPath, rawLine] = match;
    // A message line such as "at 22:19:10" has the shape of a frame; a real frame's path always has a separator.
    if (rawPath === undefined || !/[\\/]/.test(rawPath) || !isApplicationPath(toPosix(rawPath))) continue;
    frames.push({
      file: repoRelative(rawPath, options.rootDir),
      fn: functionName(name),
      line: rawLine === undefined ? null : Number(rawLine),
    });
    if (frames.length >= (options.max ?? MAX_FRAMES)) break;
  }
  return frames;
}
