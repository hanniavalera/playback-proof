// The results tables of README.md: blocks rendered from the committed result files, kept fresh by `npm run docs:check`.
//
//   <!-- BEGIN:RESULTS_CODEC -->
//   ...a table rendered from docs/results/codec-matrix/*.json...
//   <!-- END:RESULTS_CODEC -->
//
// `docs:check` fails when a block differs from what the files render to, so a number in the README cannot drift from the data it
// quotes; `npm run docs:check -- --write` rewrites the blocks. A renderer is a pure function of a FileSet (strings in, string out):
// tests/unit/docs/results-tables.test.ts runs every one on the real committed files and on synthetic ones. To add a block: write one
// function in tools/results/, register it in RESULT_BLOCKS below, and put one marker pair where the table belongs (docs/README-TOOLING.md).
import { blockMarkers, checkBlockFresh, locateBlock, replaceBlock } from './doc-blocks.ts';
import { renderCodec } from './results/codec.ts';
import { ResultsError, loadFileSet } from './results/files.ts';
import type { FileSet, Read, Rendered } from './results/files.ts';
import { FLAKE_DIR, FLAKE_RAW_PATTERN, renderFlake } from './results/flake.ts';
import { JENKINSFILE, JENKINS_DIR, renderJenkins } from './results/jenkins.ts';
import { BASELINES_DIR, PERF_RESULTS_DIR, renderPerf } from './results/perf.ts';
import { GATE_MERGE, MERGE_WORKFLOW, NIGHTLY_WORKFLOW, STRATEGY, renderSuites } from './results/suites.ts';
import { PROVENANCE_DIR, READINESS_DIR, SOAK_DIR, renderReadiness, renderSoak } from './results/readiness.ts';
import { TRIAGE_DIR, renderTriage } from './results/triage.ts';
import { waiting } from './results/waiting.ts';

export interface ResultsBlock {
  /** The marker name: `RESULTS_CODEC` is `<!-- BEGIN:RESULTS_CODEC -->` ... `<!-- END:RESULTS_CODEC -->`. */
  name: string;
  /** What the block shows, in a few words. */
  title: string;
  /** The committed files it reads: only these are loaded. */
  reads: readonly Read[];
  /**
   * Whether README.md must hold the block today. A block that waits for data is optional: it is checked when the README has its
   * markers, and until then `docs:check` only says (in a note) that results exist that the README does not show.
   */
  required: boolean;
  render: (files: FileSet) => Rendered;
}

export const RESULT_BLOCKS: readonly ResultsBlock[] = [
  {
    name: 'RESULTS_CODEC',
    title: 'which stream flavours each engine plays, per environment',
    reads: [{ path: 'docs/results/codec-matrix', match: /^docs\/results\/codec-matrix\/[^/]+\.json$/ }],
    required: true,
    render: renderCodec,
  },
  {
    name: 'RESULTS_SUITES',
    title: 'the automated tests per area and tier, and the CI legs that run them',
    reads: [
      { path: STRATEGY },
      { path: MERGE_WORKFLOW },
      { path: NIGHTLY_WORKFLOW },
      { path: GATE_MERGE },
      { path: 'tests/e2e', match: /\.spec\.ts$/ },
      { path: 'tests/live', match: /\.spec\.ts$/ },
    ],
    required: true,
    render: renderSuites,
  },
  {
    name: 'RESULTS_PERF',
    title: 'performance baselines, thresholds, A/A checks and sensitivity checks',
    reads: [
      { path: BASELINES_DIR, match: /\.json$/ },
      // The summaries and write-ups, not the raw per-pass reports; of those only the machine record of each job (its CPU model).
      { path: PERF_RESULTS_DIR, match: /^docs\/results\/perf\/(?!.*\/raw\/).*\.(json|md)$/ },
      { path: PERF_RESULTS_DIR, match: /\/raw\/[^/]+\/machine\.txt$/ },
    ],
    required: true,
    render: renderPerf,
  },
  {
    name: 'RESULTS_TRIAGE',
    title: 'seven induced failures, their clusters and root causes',
    reads: [{ path: TRIAGE_DIR, match: /\.json$/ }],
    required: true,
    render: renderTriage,
  },
  {
    name: 'RESULTS_JENKINS',
    title: 'the builds of the local Jenkins and their stages',
    reads: [{ path: JENKINS_DIR, match: /build-\d+(?:-console\.txt|\.json)$/ }, { path: JENKINSFILE }],
    required: true,
    render: renderJenkins,
  },
  {
    name: 'RESULTS_FLAKE',
    title:
      'the flake collections: executions, flaky, failed and invalid runs, counted from the raw histories',
    reads: [{ path: FLAKE_DIR, match: FLAKE_RAW_PATTERN }],
    required: true,
    render: renderFlake,
  },
  {
    name: 'RESULTS_READINESS',
    title: 'live-event readiness checks, through the readiness evidence module',
    reads: [
      { path: READINESS_DIR, match: /\.json$/ },
      { path: SOAK_DIR, match: /\.json$/ },
      { path: PROVENANCE_DIR, match: /(?:runs\.json|machines\/[^/]+\.txt)$/ },
    ],
    required: true,
    render: renderReadiness,
  },
  {
    name: 'RESULTS_SOAK',
    title: 'soak runs, through the readiness evidence module',
    reads: [
      { path: READINESS_DIR, match: /\.json$/ },
      { path: SOAK_DIR, match: /\.json$/ },
      { path: PROVENANCE_DIR, match: /(?:runs\.json|machines\/[^/]+\.txt)$/ },
    ],
    required: true,
    render: renderSoak,
  },
  // The results below are committed by changes that have not landed: each block is optional, and has an empty state, until its data is.
  {
    name: 'RESULTS_AB',
    title: 'A/B comparisons of player configurations',
    reads: [{ path: 'docs/results/ab', match: /\.(json|md)$/ }],
    required: false,
    render: waiting({ what: 'A/B results', dir: 'docs/results/ab', match: /\.(json|md)$/ }),
  },
];

export type BlockOutcome = Rendered | { kind: 'problem'; problem: string };

/** Renders one block; whatever goes wrong is a problem with a message, never an exception. */
export function renderBlock(block: ResultsBlock, files: FileSet): BlockOutcome {
  try {
    return block.render(files);
  } catch (error) {
    if (error instanceof ResultsError) return { kind: 'problem', problem: error.message };
    return {
      kind: 'problem',
      problem: `the renderer failed (${error instanceof Error ? error.message : String(error)}): this is a bug in tools/results/`,
    };
  }
}

/** What every block needs, for the loader. */
export const resultReads = (blocks: readonly ResultsBlock[] = RESULT_BLOCKS): Read[] =>
  blocks.flatMap((block) => block.reads);

export const loadResultFiles = (root: string, blocks: readonly ResultsBlock[] = RESULT_BLOCKS): FileSet =>
  loadFileSet(root, resultReads(blocks));

function hasAnyMarker(markdown: string, name: string): boolean {
  const { begin, end } = blockMarkers(name);
  return markdown.includes(begin) || markdown.includes(end);
}

export interface ResultsCheck {
  problems: string[];
  /** Said, never failing: results exist that the README (which does not have to show them yet) does not show. */
  notes: string[];
}

const unshown = (block: ResultsBlock, outcome: BlockOutcome): string =>
  outcome.kind === 'problem'
    ? `${block.name}: the README has no such block, and the results cannot be rendered yet: ${outcome.problem}`
    : `${block.name}: results exist (${block.title}) but the README has no block for them: add \`<!-- BEGIN:${block.name} -->\` and \`<!-- END:${block.name} -->\` where they belong and run \`npm run docs:check -- --write\``;

/** One problem per block that is missing, malformed, unrenderable or out of date; blocks that wait for data may be absent. */
export function checkResultBlocks(
  readme: string,
  files: FileSet,
  blocks: readonly ResultsBlock[] = RESULT_BLOCKS,
): ResultsCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const block of blocks) {
    const outcome = renderBlock(block, files);
    const located = locateBlock(readme, block.name);
    if (!located.found && !hasAnyMarker(readme, block.name)) {
      if (block.required) {
        problems.push(
          `generated block ${block.name}: ${located.reason}; the README must hold it (${block.title})`,
        );
      } else if (outcome.kind !== 'empty') {
        notes.push(unshown(block, outcome));
      }
      continue;
    }
    if (!located.found) {
      problems.push(`generated block ${block.name}: ${located.reason}`);
      continue;
    }
    if (outcome.kind === 'problem') {
      problems.push(`generated block ${block.name} cannot be rendered: ${outcome.problem}`);
      continue;
    }
    const fresh = checkBlockFresh(readme, block.name, outcome.markdown);
    if (!fresh.fresh) {
      problems.push(
        `generated block ${block.name} is ${fresh.reason}; run \`npm run docs:check -- --write\``,
      );
    }
  }
  return { problems, notes };
}

export interface ResultsWrite extends ResultsCheck {
  text: string;
}

/** The README with every block that can be rendered replaced by its fresh rendering; the others are left as they are and reported. */
export function writeResultBlocks(
  readme: string,
  files: FileSet,
  blocks: readonly ResultsBlock[] = RESULT_BLOCKS,
): ResultsWrite {
  let text = readme;
  const problems: string[] = [];
  const notes: string[] = [];
  for (const block of blocks) {
    const outcome = renderBlock(block, files);
    const located = locateBlock(text, block.name);
    if (!located.found) {
      if (hasAnyMarker(text, block.name)) problems.push(`generated block ${block.name}: ${located.reason}`);
      else if (block.required) problems.push(`generated block ${block.name}: ${located.reason}`);
      else if (outcome.kind !== 'empty') notes.push(unshown(block, outcome));
      continue;
    }
    if (outcome.kind === 'problem') {
      problems.push(`generated block ${block.name} cannot be rendered: ${outcome.problem}`);
      continue;
    }
    text = replaceBlock(text, block.name, outcome.markdown);
  }
  return { text, problems, notes };
}

/** The blocks as `docs:check -- --print` shows them: the rendering, or the problem. */
export function printResultBlocks(
  files: FileSet,
  names: readonly string[] = [],
  blocks: readonly ResultsBlock[] = RESULT_BLOCKS,
): string[] {
  return blocks
    .filter((block) => names.length === 0 || names.includes(block.name))
    .map((block) => {
      const outcome = renderBlock(block, files);
      return outcome.kind === 'problem' ? `${block.name}: ${outcome.problem}` : outcome.markdown;
    });
}
