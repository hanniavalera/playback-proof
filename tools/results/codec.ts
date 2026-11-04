// RESULTS_CODEC: which of the lab's stream flavours each engine really plays in each environment, summarised from the committed probe
// results (docs/results/codec-matrix/<envId>.json). docs/CODEC_MATRIX.md has the whole matrix, the claims of isTypeSupported, the
// controls and the sensitivity runs; this is the table a reader of the README needs, and a link to the rest.
import { FLAVOUR_IDS } from '../../src/lab/probe/formats.ts';
import { deriveGaps } from '../../src/lab/probe/render.ts';
import { ResultFileError, parseResultFile } from '../../src/lab/probe/report.ts';
import type { ResultFile } from '../../src/lab/probe/report.ts';
import { claimsTrueButFails, isLaunchFailure } from '../../src/lab/probe/results.ts';
import type { CaseResult, EngineResult } from '../../src/lab/probe/results.ts';
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Rendered } from './files.ts';
import { code, link, listOf, mdTable } from './format.ts';

export const CODEC_DIR = 'docs/results/codec-matrix';
const ENGINE_ORDER = ['chromium', 'firefox', 'webkit'];

function readResults(files: FileSet): ResultFile[] {
  return files.list(CODEC_DIR, /^[^/]+\.json$/).map((path) => {
    let file: ResultFile;
    try {
      file = parseResultFile(files.text(path), path);
    } catch (error) {
      if (error instanceof ResultFileError) throw new ResultsError(error.message);
      throw error;
    }
    const name = path.slice(CODEC_DIR.length + 1);
    if (name !== `${file.envId}.json`) {
      throw new ResultsError(
        `${path}: the file of environment "${file.envId}" must be named ${file.envId}.json`,
      );
    }
    return file;
  });
}

const engineNames = (file: ResultFile): string[] =>
  Object.keys(file.engines).sort((a, b) => {
    const ia = ENGINE_ORDER.indexOf(a);
    const ib = ENGINE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

function verdict(result: CaseResult | undefined): string {
  if (!result) return 'not probed';
  const text = `${result.reliability} ${result.passes}/${result.attempts}`;
  return claimsTrueButFails(result) ? `${text} *` : text;
}

function engineCell(name: string, engine: EngineResult): string {
  return isLaunchFailure(engine) ? name : `${name} ${engine.browserVersion}`;
}

function optionsSentence(files: readonly ResultFile[]): string {
  const describe = (f: ResultFile): string =>
    `${f.options.attempts} attempts per case${f.options.freshProcess ? ', each in a fresh browser process' : ''}; an attempt passes when media time reaches ${f.options.thresholdSec} s and, for video, at least ${f.options.minFrames} frames were presented`;
  const distinct = [...new Set(files.map(describe))];
  if (distinct.length === 1)
    return `Each cell is the attempts that played out of the attempts made: ${distinct[0]}.`;
  return `Each cell is the attempts that played out of the attempts made. ${files.map((f) => `${code(f.envId)}: ${describe(f)}`).join('. ')}.`;
}

export function renderCodec(files: FileSet): Rendered {
  const results = readResults(files);
  if (results.length === 0) return emptyState('codec probe results', CODEC_DIR);

  const rows: string[][] = [];
  let flagged = false;
  for (const file of results) {
    for (const name of engineNames(file)) {
      const engine = file.engines[name] as EngineResult;
      const cells = FLAVOUR_IDS.map((id, i) => {
        if (isLaunchFailure(engine)) return i === 0 ? 'did not launch' : 'n/a';
        const text = verdict(engine.cases[id]);
        flagged ||= text.endsWith('*');
        return text;
      });
      rows.push([
        code(file.envId),
        `${file.host.os.name} ${file.host.os.arch}`,
        engineCell(name, engine),
        ...cells,
      ]);
    }
  }

  const gaps = deriveGaps(results).map((gap) =>
    gap.kind === 'launch'
      ? `${code(gap.file.envId)}: ${gap.engine} does not launch`
      : `${code(gap.file.envId)}: ${gap.engine} does not decode every attempt of ${listOf(gap.flavours.map(code))}`,
  );

  const lines = [
    mdTable(['Environment', 'OS', 'Engine', ...FLAVOUR_IDS.map(code)], rows),
    '',
    optionsSentence(results),
    '',
    ...(flagged
      ? [
          '`*` marks a cell where `MediaSource.isTypeSupported` answered yes for every track of the flavour and the engine still did not decode every attempt: the reason the lab trusts a probe that decodes and not the answer of the API.',
          '',
        ]
      : []),
    gaps.length === 0
      ? 'In every probed environment and engine, every lab flavour decoded in every attempt.'
      : `Lab flavours the probe could not rely on, or engines it could not start: ${gaps.join('; ')}.`,
    '',
    `The whole matrix (single tracks, plain-video controls, the sensitivity runs and what each engine claims) is ${link('docs/CODEC_MATRIX.md', 'docs/CODEC_MATRIX.md')}, rendered from ${results.map((f) => link(`${f.envId}.json`, `${CODEC_DIR}/${f.envId}.json`)).join(', ')}.`,
  ];
  return data(lines.join('\n'));
}
