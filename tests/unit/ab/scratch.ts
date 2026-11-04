import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';

/** A scratch directory under the repository's own gitignored `.tmp/`, removed when the tests of the file are done. */
export function scratchDirectory(prefix: string): string {
  const scratch = resolve(import.meta.dirname, '../../../.tmp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, `${prefix}-`));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
