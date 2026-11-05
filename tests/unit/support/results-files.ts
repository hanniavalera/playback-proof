import { expect } from 'vitest';
import type { FileSet } from '../../../tools/results/files.ts';

// What the tests of the README's results tables share (tests/unit/docs/results-*.test.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

/** A copy of the files in which one JSON file has been changed the way the callback says. */
export function changed(files: FileSet, path: string, change: (root: Loose) => void): FileSet {
  const root = JSON.parse(files.text(path)) as Loose;
  change(root);
  return files.with(path, `${JSON.stringify(root, null, 2)}\n`);
}

/** Every table of a rendering has as many cells in each row as in its header, and a separator line. */
export function expectWellFormedTables(markdown: string): number {
  let tables = 0;
  const width = (line: string): number => line.replace(/\\\|/g, '').split('|').length;
  for (const chunk of markdown.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.startsWith('|'));
    if (lines.length === 0) continue;
    tables++;
    expect(lines[1], 'separator line').toMatch(/^\| (--- \| )*---\s*\|$/);
    for (const line of lines) expect(width(line), line).toBe(width(lines[0] ?? ''));
  }
  return tables;
}
