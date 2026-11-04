// Blocks that wait for data. Their result files are produced by measurements that have not been committed; until they are, the block
// has an empty state with no number in it. The day files appear, `docs:check` says so (a note, or a problem when the README already
// holds the block) until a renderer exists: a renderer is one function that reads the files with the Node reader of files.ts, and
// registering it replaces `waiting(...)` below in tools/results-tables.ts. docs/README-TOOLING.md lists the shapes expected.
import { ResultsError, emptyState } from './files.ts';
import type { FileSet, Rendered } from './files.ts';

export interface WaitingBlock {
  /** What the results are, for the empty state: "A/B results". */
  what: string;
  /** Where they will be committed. */
  dir: string;
  /** Which files are results (relative to `dir`). */
  match: RegExp;
}

export function waiting(block: WaitingBlock): (files: FileSet) => Rendered {
  return (files) => {
    const found = files.list(block.dir, block.match);
    if (found.length === 0) return emptyState(block.what, block.dir);
    throw new ResultsError(
      `${block.dir} holds ${found.length} result file(s) (${found.slice(0, 3).join(', ')}${found.length > 3 ? ', ...' : ''}) but no renderer reads them yet: write one in tools/results/, register it in tools/results-tables.ts (docs/README-TOOLING.md)`,
    );
  };
}
