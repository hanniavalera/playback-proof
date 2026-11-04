import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = join(fileURLToPath(new URL('../../../', import.meta.url)), '.cache');

/**
 * A fresh scratch directory under the git-ignored `.cache`. The parent is created here: on a clean checkout (CI, a new
 * worktree) `.cache` does not exist until something has generated media, and a test must not depend on that having happened.
 */
export function makeScratch(prefix: string): string {
  mkdirSync(CACHE, { recursive: true });
  return mkdtempSync(join(CACHE, prefix));
}
