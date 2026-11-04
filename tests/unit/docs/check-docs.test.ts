import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STRATEGY_FILE,
  blockBody,
  blockMarkers,
  checkBlockFresh,
  checkGeneratedBlocks,
  checkRelativeLinks,
  locateBlock,
  replaceBlock,
  strategyBlocks,
  writeGeneratedBlocks,
  writeGeneratedBlocksToFile,
} from '../../../tools/check-docs.ts';
import type { GeneratedBlock } from '../../../tools/check-docs.ts';
import { firstDifference } from '../../../tools/doc-blocks.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { renderLiveCriteria } from '../../../tools/policy-tables.ts';

const doc = (inner: string, name = 'X'): string =>
  `# Title\n\nBefore.\n\n${blockMarkers(name).begin}\n${inner}\n${blockMarkers(name).end}\n\nAfter.\n`;

describe('PB-LAB-006 generated blocks: locating and replacing', () => {
  it('names its markers the way the documents write them', () => {
    expect(blockMarkers('LIVE_CRITERIA')).toStrictEqual({
      begin: '<!-- BEGIN:LIVE_CRITERIA -->',
      end: '<!-- END:LIVE_CRITERIA -->',
    });
  });

  it('finds the block, its content and the line it starts on', () => {
    const located = locateBlock(doc('a\nb'), 'X');
    expect(located).toMatchObject({ found: true, firstLine: 6 });
    expect(blockBody(doc('  a\nb  \n\n'), 'X')).toBe('a\nb');
  });

  it.each([
    ['missing markers', '# nothing\n', /not found/],
    ['a lone BEGIN', '<!-- BEGIN:X -->\ntext', /found 1 and 0/],
    ['a lone END', 'text\n<!-- END:X -->', /found 0 and 1/],
    ['a duplicated block', `${doc('a')}\n${doc('b')}`, /found 2 and 2/],
    ['END before BEGIN', '<!-- END:X -->\n<!-- BEGIN:X -->', /comes before/],
  ])('reports %s', (_label, text, expected) => {
    const located = locateBlock(text, 'X');
    expect(located.found).toBe(false);
    expect(located.found === false && located.reason).toMatch(expected);
    expect(blockBody(text, 'X')).toBeUndefined();
  });

  it('does not mistake a block whose name starts the same', () => {
    const text = `${doc('one', 'LIVE')}\n${doc('two', 'LIVE_CRITERIA')}`;
    expect(blockBody(text, 'LIVE')).toBe('one');
    expect(blockBody(text, 'LIVE_CRITERIA')).toBe('two');
  });

  it('replaces only what is between the markers', () => {
    const replaced = replaceBlock(doc('old'), 'X', 'new\nlines');
    expect(replaced).toBe(doc('new\nlines'));
    expect(replaced.startsWith('# Title\n\nBefore.')).toBe(true);
    expect(replaced.endsWith('After.\n')).toBe(true);
  });

  it('refuses to replace a block it cannot find', () => {
    expect(() => replaceBlock('# nothing', 'X', 'body')).toThrow(
      /cannot replace block X: markers .* not found/,
    );
  });
});

describe('PB-LAB-006 generated blocks: freshness', () => {
  it('is fresh when the content matches, whatever the padding or line endings', () => {
    expect(checkBlockFresh(doc('a\nb'), 'X', 'a\nb')).toStrictEqual({ fresh: true });
    expect(checkBlockFresh(doc('\n\na\nb\n\n'), 'X', '  a\nb  ')).toStrictEqual({ fresh: true });
    expect(checkBlockFresh(doc('a\nb').replace(/\n/g, '\r\n'), 'X', 'a\nb')).toStrictEqual({ fresh: true });
  });

  it('is stale when a single character differs, and says where', () => {
    const result = checkBlockFresh(doc('a\nb'), 'X', 'a\nB');
    expect(result).toStrictEqual({
      fresh: false,
      reason: 'out of date (line 2 of the block: expected "B" but found "b")',
    });
  });

  it('is not fresh when the block is missing', () => {
    expect(checkBlockFresh('text', 'X', 'a')).toMatchObject({
      fresh: false,
      reason: expect.stringContaining('not found'),
    });
  });
});

describe('PB-LAB-006 firstDifference', () => {
  it('names the first differing line, in both versions, and copes with different lengths', () => {
    expect(firstDifference('a\nb\nc', 'a\nb\nd')).toBe('line 3 of the block: expected "c" but found "d"');
    expect(firstDifference('a\nb', 'a')).toBe('line 2 of the block: expected "b" but found nothing');
    expect(firstDifference('a', 'a\nb')).toBe('line 2 of the block: expected nothing but found "b"');
    expect(firstDifference(' a \n', '\r\na')).toBe('no difference');
  });

  it('shortens a long line so that a table row does not flood the report', () => {
    const long = 'x'.repeat(300);
    const text = firstDifference(long, 'y');
    expect(text).toContain(`"${'x'.repeat(100)}..."`);
    expect(text.length).toBeLessThan(200);
  });
});

describe('PB-LAB-006 generated blocks of the strategy', () => {
  const blocks: GeneratedBlock[] = [
    { name: 'ONE', render: () => 'first table' },
    { name: 'TWO', render: () => 'second table' },
  ];
  const placeholders = `intro\n\n${doc('', 'ONE')}\n${doc('stale', 'TWO')}\noutro\n`;

  it('reports a stale block with where it differs and the command that fixes it, and a missing one with its reason', () => {
    const problems = checkGeneratedBlocks(placeholders, [...blocks, { name: 'THREE', render: () => 'x' }]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toBe(
      'generated block ONE is out of date (line 1 of the block: expected "first table" but found ""); run `npm run docs:check -- --write`',
    );
    expect(problems[1]).toContain(
      'generated block TWO is out of date (line 1 of the block: expected "second table" but found "stale")',
    );
    expect(problems[2]).toMatch(/generated block THREE: markers .* not found/);
  });

  it('writes every block it can find and leaves the rest of the document alone', () => {
    const written = writeGeneratedBlocks(placeholders, [...blocks, { name: 'THREE', render: () => 'x' }]);
    expect(checkGeneratedBlocks(written, blocks)).toStrictEqual([]);
    expect(written).toContain('first table');
    expect(written).toContain('second table');
    expect(written).not.toContain('stale');
    expect(written.startsWith('intro\n')).toBe(true);
    expect(written.endsWith('outro\n')).toBe(true);
  });

  it('writes idempotently', () => {
    const once = writeGeneratedBlocks(placeholders, blocks);
    expect(writeGeneratedBlocks(once, blocks)).toBe(once);
  });

  it('notices that the live criteria changed, because the table is rendered from the constants', () => {
    const live = { name: 'LIVE_CRITERIA', render: renderLiveCriteria };
    const fresh = writeGeneratedBlocks(doc('', 'LIVE_CRITERIA'), [live]);
    expect(checkGeneratedBlocks(fresh, [live])).toStrictEqual([]);
    // Someone edits a number in the document by hand: the check fails and `--write` repairs it.
    const edited = fresh.replace('| Latency, p95 | 8,000 ms (8 s) |', '| Latency, p95 | 9,000 ms (9 s) |');
    expect(edited).not.toBe(fresh);
    expect(checkGeneratedBlocks(edited, [live])).toHaveLength(1);
    expect(writeGeneratedBlocks(edited, [live])).toBe(fresh);
  });

  it('lists the blocks of the strategy, with the merge budget only when the catalog is known', () => {
    const names = (rows?: Parameters<typeof strategyBlocks>[0]): string[] =>
      strategyBlocks(rows).map((b) => b.name);
    expect(names()).toStrictEqual([
      'RISK_TIERS',
      'AREA_LEGEND',
      'GATE_BUDGETS',
      'PERF_POLICY',
      'FLAKE_POLICY',
      'LIVE_CRITERIA',
      'FAULT_PROFILES',
    ]);
    const rows = parseCatalog(
      [
        '<!-- BEGIN:TEST_CATALOG -->',
        '| ID | Area | Scenario | Risk | Tier | Engines | Runs in | A failure means |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| PB-VOD-001 | VOD | Plays | 3x5=15 | merge | all | e2e | Block. |',
        '<!-- END:TEST_CATALOG -->',
      ].join('\n'),
    );
    expect(names(rows)).toContain('MERGE_BUDGET');
    expect(STRATEGY_FILE).toBe('TEST_STRATEGY.md');
  });
});

// Scratch files live under the repository's own gitignored .tmp, never in the system temp directory.
const SCRATCH = fileURLToPath(new URL('../../../.tmp/pb-check-docs-test/', import.meta.url));

describe('PB-LAB-006 on disk', () => {
  beforeEach(() => mkdirSync(SCRATCH, { recursive: true }));
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it('rewrites a stale generated block in the file, and leaves a fresh file untouched', () => {
    const path = `${SCRATCH}strategy.md`;
    const blocks: GeneratedBlock[] = [{ name: 'X', render: () => 'fresh table' }];
    writeFileSync(path, doc('stale table'));

    expect(writeGeneratedBlocksToFile(path, blocks)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(doc('fresh table'));
    expect(writeGeneratedBlocksToFile(path, blocks)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(doc('fresh table'));
  });

  it('keeps the link check it always had: a relative link must point at a file that exists', () => {
    writeFileSync(`${SCRATCH}other.md`, '# Other\n');
    writeFileSync(
      `${SCRATCH}page.md`,
      [
        '[ok](other.md)',
        '[ok with anchor](other.md#top)',
        '[only an anchor](#top)',
        '[external](https://example.com/page)',
        '[broken](missing.md)',
        '```',
        '[inside a fence](also-missing.md)',
        '```',
      ].join('\n'),
    );
    expect(checkRelativeLinks([`${SCRATCH}page.md`, `${SCRATCH}other.md`])).toStrictEqual([
      '.tmp/pb-check-docs-test/page.md: broken link -> missing.md',
    ]);
  });
});
