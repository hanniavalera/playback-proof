import { capabilitiesFromEngine, selectStreams } from './capabilities.ts';
import type { Capabilities } from './capabilities.ts';
import {
  CONTROL_CASES,
  DEFAULT_PROFILE,
  FLAVOUR_IDS,
  LAB_STREAMS,
  PROBE_CASES,
  SENSITIVITY_CASE,
  SENSITIVITY_PROFILES,
  STREAM_PREFERENCE,
  mimeTypesOf,
} from './formats.ts';
import type { CaseGroup, FlavourId } from './formats.ts';
import type { ResultFile } from './report.ts';
import { claimsFalseButPlays, claimsTrueButFails, describeMediaError, isLaunchFailure } from './results.ts';
import type { CaseResult, EngineResult, ProbedEngine } from './results.ts';

// docs/CODEC_MATRIX.md is rendered from the committed JSON files, never written by hand. Everything that depends on the
// results (cells, gaps, consequences, the stream chosen per browser) is computed here from the data; the fixed prose
// only explains how to read the tables. The same input always renders the same document.

const ENGINE_ORDER = ['chromium', 'firefox', 'webkit'];
const RESULTS_DIR = 'results/codec-matrix';

function mdCell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
}

/** An inline code span that survives backticks inside the text. */
function code(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function engineNames(files: readonly ResultFile[]): string[] {
  const names = new Set(files.flatMap((file) => Object.keys(file.engines)));
  return [...names].sort((a, b) => {
    const ia = ENGINE_ORDER.indexOf(a);
    const ib = ENGINE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

function probed(engine: EngineResult | undefined): ProbedEngine | undefined {
  return engine && !isLaunchFailure(engine) ? engine : undefined;
}

function engineLabel(name: string, engine: EngineResult | undefined): string {
  const p = probed(engine);
  return p ? `${name} ${p.browserVersion}` : name;
}

export function verdictText(result: CaseResult): string {
  return `${result.reliability} ${result.passes}/${result.attempts}`;
}

/** One cell of a matrix: the verdict, and a loud flag where `isTypeSupported` disagrees with what really decoded. */
export function cellText(engine: EngineResult | undefined, result: CaseResult | undefined): string {
  if (!engine) return '—';
  if (isLaunchFailure(engine)) return 'launch failed';
  if (!result) return '—';
  const verdict = verdictText(result);
  if (claimsTrueButFails(result)) return `**${verdict} — claims true but fails**`;
  if (claimsFalseButPlays(result)) return `${verdict} — claims false but plays`;
  if (result.typeSupportedClaim === false) return `${verdict} (claims false)`;
  return verdict;
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.map(mdCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`),
  ];
}

function envTitle(file: ResultFile): string {
  return `${file.envId}: ${file.host.os.name}, ${file.host.os.arch}`;
}

function commandOf(file: ResultFile): string {
  const run = `npm run codec-matrix -- ${file.args.join(' ')}`.trim();
  return file.invokedVia === 'docker:pw' ? `npm run docker:pw -- ${run}` : run;
}

function failureText(result: CaseResult): string | null {
  const failure = result.failure;
  if (!failure) return null;
  const media = failure.mediaError
    ? `; media element error ${code(describeMediaError(failure.mediaError))}`
    : '';
  return `${code(`[${failure.stage}] ${failure.error}`)}${media} (${failure.count} of ${result.attempts} attempts)`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-environment tables

function renderMatrixTable(file: ResultFile, names: string[]): string[] {
  const header = ['Case', ...names.map((name) => engineLabel(name, file.engines[name]))];
  const rows: string[][] = [];
  const groups: Array<[CaseGroup, string]> = [
    ['flavour', "Lab flavours: what the lab's streams are made of"],
    ['single-track', 'Single tracks: which track of a flavour an engine cannot handle'],
    ['informational', 'Informational: codecs the lab does not stream'],
  ];
  for (const [group, title] of groups) {
    rows.push([`**${title}**`, ...names.map(() => '')]);
    for (const probeCase of PROBE_CASES.filter((c) => c.group === group)) {
      rows.push([
        `${code(probeCase.id)} ${probeCase.title}`,
        ...names.map((name) => cellText(file.engines[name], probed(file.engines[name])?.cases[probeCase.id])),
      ]);
    }
  }
  const known = new Set<string>(PROBE_CASES.map((c) => c.id));
  const extra = new Set<string>();
  for (const name of names)
    for (const id of Object.keys(probed(file.engines[name])?.cases ?? {})) if (!known.has(id)) extra.add(id);
  if (extra.size > 0) {
    rows.push(['**Other cases in the result file**', ...names.map(() => '')]);
    for (const id of [...extra].sort()) {
      rows.push([
        code(id),
        ...names.map((name) => cellText(file.engines[name], probed(file.engines[name])?.cases[id])),
      ]);
    }
  }
  return table(header, rows);
}

function renderControlsTable(file: ResultFile, names: string[]): string[] {
  const header = ['Control', ...names.map((name) => engineLabel(name, file.engines[name]))];
  const rows = CONTROL_CASES.map((control) => [
    `${code(control.id)} ${control.title}`,
    ...names.map((name) => cellText(file.engines[name], probed(file.engines[name])?.controls[control.id])),
  ]);
  return table(header, rows);
}

function renderSensitivityTable(file: ResultFile, names: string[]): string[] {
  const header = ['Page profile', ...names.map((name) => engineLabel(name, file.engines[name]))];
  const rows = [
    [
      `${code(DEFAULT_PROFILE.id)} ${DEFAULT_PROFILE.title}`,
      ...names.map((name) =>
        cellText(file.engines[name], probed(file.engines[name])?.cases[SENSITIVITY_CASE]),
      ),
    ],
    ...SENSITIVITY_PROFILES.map((profile) => [
      `${code(profile.id)} ${profile.title}`,
      ...names.map((name) =>
        cellText(file.engines[name], probed(file.engines[name])?.sensitivity[profile.id]),
      ),
    ]),
  ];
  return table(header, rows);
}

function claimLabel(value: boolean | null | undefined): string {
  if (value === undefined) return '—';
  return value === null ? 'no MediaSource' : String(value);
}

function renderClaimsTable(file: ResultFile, names: string[]): string[] {
  const header = [
    '`MediaSource.isTypeSupported(...)`',
    ...names.map((name) => engineLabel(name, file.engines[name])),
  ];
  const ordered = mimeTypesOf(PROBE_CASES);
  const extra = new Set<string>();
  for (const name of names) {
    for (const type of Object.keys(probed(file.engines[name])?.isTypeSupported ?? {}))
      if (!ordered.includes(type)) extra.add(type);
  }
  const rows = [...ordered, ...[...extra].sort()].map((type) => [
    code(type),
    ...names.map((name) => {
      const engine = file.engines[name];
      if (!engine) return '—';
      if (isLaunchFailure(engine)) return 'launch failed';
      return claimLabel(engine.isTypeSupported[type]);
    }),
  ]);
  return table(header, rows);
}

function hlsAnswer(engine: ProbedEngine): string {
  const answers = [...new Set(Object.values(engine.nativeHls))];
  return answers.map((answer) => (answer === '' ? 'no' : answer)).join(' / ') || '—';
}

function renderFactsTable(file: ResultFile, names: string[]): string[] {
  const rows = names.map((name) => {
    const engine = file.engines[name];
    const p = probed(engine);
    if (!p) return [name, engine ? 'launch failed' : '—', '', '', '', ''];
    return [
      name,
      p.browserVersion,
      p.mediaSource,
      hlsAnswer(p),
      p.requestVideoFrameCallback ? 'yes' : 'no',
      p.getVideoPlaybackQuality ? 'yes' : 'no',
    ];
  });
  return table(
    [
      'Engine',
      'Version',
      'MSE API',
      'Native HLS (`canPlayType`)',
      '`requestVideoFrameCallback`',
      '`getVideoPlaybackQuality`',
    ],
    rows,
  );
}

function renderOverview(files: readonly ResultFile[]): string[] {
  const columns = files.flatMap((file) => engineNames([file]).map((name) => ({ file, name })));
  const header = [
    'Flavour',
    ...columns.map(({ file, name }) => `${file.envId}: ${engineLabel(name, file.engines[name])}`),
  ];
  const rows = FLAVOUR_IDS.map((id) => [
    code(id),
    ...columns.map(({ file, name }) => cellText(file.engines[name], probed(file.engines[name])?.cases[id])),
  ]);
  return table(header, rows);
}

function renderEnvironment(file: ResultFile, names: string[]): string[] {
  const out: string[] = [];
  out.push(`### ${envTitle(file)}`, '');
  out.push(
    `${file.options.attempts} attempts per case, ${file.options.freshProcess ? 'a fresh browser process for every attempt' : 'one browser process per engine'}, ` +
      `pass = media time >= ${file.options.thresholdSec} s and (for video) >= ${file.options.minFrames} frames presented. ` +
      `Raw data: [${code(`${file.envId}.json`)}](${RESULTS_DIR}/${file.envId}.json).`,
    '',
  );
  out.push('#### Playback through MSE (real decode)', '', ...renderMatrixTable(file, names), '');
  const withControls = names.some(
    (name) => Object.keys(probed(file.engines[name])?.controls ?? {}).length > 0,
  );
  if (withControls) {
    out.push(
      '#### Control: the same files as a plain `<video src>` (no MediaSource)',
      '',
      "Where a control plays and the matching MSE case does not, the file is sound and the failure is in the engine's MSE pipeline.",
      '',
      ...renderControlsTable(file, names),
      '',
    );
  }
  const withSensitivity = names.some(
    (name) => Object.keys(probed(file.engines[name])?.sensitivity ?? {}).length > 0,
  );
  if (withSensitivity) {
    out.push(
      `#### Sensitivity: ${code(SENSITIVITY_CASE)} under differently behaving pages`,
      '',
      'The same case and the same bytes, with one thing changed about how the page drives the element. A verdict that flips between rows depends on the page, not only on the engine.',
      '',
      ...renderSensitivityTable(file, names),
      '',
    );
  }
  out.push('#### What each engine claims', '', ...renderClaimsTable(file, names), '');
  out.push('#### Engine facts', '', ...renderFactsTable(file, names), '');
  const agents = names.flatMap((name) => {
    const p = probed(file.engines[name]);
    return p ? [`- ${name}: ${code(p.userAgent)}`] : [];
  });
  if (agents.length > 0) out.push('User agents:', '', ...agents, '');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Gaps

export interface LabGap {
  file: ResultFile;
  engine: string;
  kind: 'launch' | 'lab-flavours';
  /** Lab flavours that did not decode in every attempt (empty for a launch gap). */
  flavours: FlavourId[];
}

const LAB_FLAVOURS: FlavourId[] = [...new Set(Object.values(LAB_STREAMS).map((s) => s.flavour))];

/** Every engine/environment where the lab cannot rely on what it streams: it does not start, or a lab flavour is not `ok`. */
export function deriveGaps(files: readonly ResultFile[]): LabGap[] {
  const gaps: LabGap[] = [];
  for (const file of files) {
    for (const name of engineNames([file])) {
      const engine = file.engines[name];
      if (!engine) continue;
      if (isLaunchFailure(engine)) {
        gaps.push({ file, engine: name, kind: 'launch', flavours: [] });
        continue;
      }
      const failing = LAB_FLAVOURS.filter((id) => {
        const result = engine.cases[id];
        return result !== undefined && result.reliability !== 'ok';
      });
      if (failing.length > 0) gaps.push({ file, engine: name, kind: 'lab-flavours', flavours: failing });
    }
  }
  return gaps;
}

function jsonPath(engine: string, section: string, id: string): string {
  return `engines.${engine}.${section}["${id}"]`;
}

function renderGap(gap: LabGap, index: number, files: readonly ResultFile[]): string[] {
  const { file, engine: name } = gap;
  const engine = file.engines[name] as EngineResult;
  const link = `[${code(`${file.envId}.json`)}](${RESULTS_DIR}/${file.envId}.json)`;
  const out: string[] = [];

  if (isLaunchFailure(engine)) {
    out.push(`### Gap ${index}: ${name} does not start on ${file.envId}`, '');
    out.push(`- **Environment, engine:** ${envTitle(file)}; ${name}.`);
    // Playwright repeats the browser's own log under "Call log:"; the document shows the browser's part, the JSON all of it.
    const browserLog = engine.launchFailed.split(/\n\s*Call log:/)[0] ?? engine.launchFailed;
    const shown = browserLog.split('\n').map((line) => (line.trim() === '' ? '' : `  ${line.trimEnd()}`));
    out.push(
      `- **Symptom:** the browser process could not be launched. Its own error text${browserLog === engine.launchFailed ? '' : " (up to Playwright's call log, which repeats it; the whole text is in the JSON)"}:`,
      '',
    );
    out.push('  ```text', ...shown, '  ```', '');
    out.push(`- **Evidence:** ${link}, ${code(`engines.${name}.launchFailed`)}.`);
    const elsewhere = files
      .filter((other) => other.envId !== file.envId)
      .filter((other) => {
        const e = probed(other.engines[name]);
        return e !== undefined && LAB_FLAVOURS.some((id) => e.cases[id]?.reliability === 'ok');
      })
      .map((other) => code(other.envId));
    out.push(
      `- **Consequence for the lab:** no ${name} suite can run in this environment, and the shared fixture reports the launch failure instead of skipping silently. ` +
        (elsewhere.length > 0
          ? `${name} runs the playback suites in ${elsewhere.join(', ')} (see [CONTRACTS.md](CONTRACTS.md), section 2).`
          : `No committed environment runs ${name} yet.`),
      '',
    );
    return out;
  }

  const caps = capabilitiesFromEngine(name, engine);
  out.push(
    `### Gap ${index}: ${name} ${engine.browserVersion} on ${file.envId}: MSE playback of ${gap.flavours.map(code).join(', ')} is not reliable`,
    '',
  );
  out.push(`- **Environment, engine:** ${envTitle(file)}; ${name} ${engine.browserVersion}.`);
  out.push('- **Symptom:**');
  for (const id of gap.flavours) {
    const result = engine.cases[id] as CaseResult;
    const claim = result.typeSupportedClaim
      ? ' `isTypeSupported` claims true.'
      : ' `isTypeSupported` claims false.';
    out.push(
      `  - ${code(id)}: ${verdictText(result)}. Most frequent failure: ${failureText(result) ?? 'none'}.${claim}`,
    );
  }
  const profileResults = SENSITIVITY_PROFILES.flatMap((profile) => {
    const result = engine.sensitivity[profile.id];
    return result ? [`${code(profile.id)} ${verdictText(result)}`] : [];
  });
  if (profileResults.length > 0 && gap.flavours.includes(SENSITIVITY_CASE)) {
    out.push(
      `  - Same flavour under other page profiles: ${profileResults.join(', ')}. The verdict depends on how the page drives MSE ([ADR-031](decisions/codecs.md)).`,
    );
  }
  const controls = Object.entries(engine.controls);
  if (controls.length > 0) {
    const notOk = controls.filter(([, result]) => result.reliability !== 'ok');
    out.push(
      notOk.length === 0
        ? `  - Plain \`<video src>\` playback of the same files: all ${controls.length} controls ok, so the files are sound and the failure is in the MSE pipeline.`
        : `  - Plain \`<video src>\` playback of the same files: ${controls.length - notOk.length} of ${controls.length} controls ok; not ok: ${notOk.map(([id, r]) => `${code(id)} ${verdictText(r)}`).join(', ')}.`,
    );
  }
  const everyCase = Object.values(engine.cases);
  const tally = (reliability: string): number =>
    everyCase.filter((c) => c.reliability === reliability).length;
  if (tally('intermittent') > 0) {
    out.push(
      `  - All ${everyCase.length} cases of this engine: ${tally('ok')} ok, ${tally('intermittent')} intermittent, ${tally('fail')} fail. An ${code('ok')} cell next to intermittent ones can be luck: ${file.options.attempts} attempts are a sample, not a guarantee, which is why a flavour must pass every attempt to count as supported.`,
    );
  }
  out.push(
    `- **Evidence:** ${link}: ${gap.flavours.map((id) => code(jsonPath(name, 'cases', id))).join(', ')}` +
      (profileResults.length > 0 ? `, ${code(`engines.${name}.sensitivity`)}` : '') +
      (controls.length > 0 ? `, ${code(`engines.${name}.controls`)}` : '') +
      '.',
  );
  const selection = selectStreams(caps);
  const skipped = selection.filter((s) => s.stream === null);
  const chosen = selection.filter((s) => s.stream !== null);
  const combo = (s: { kind: string; protocol: string }): string =>
    `${s.kind === 'vod' ? 'VOD' : 'live'} over ${s.protocol.toUpperCase()}`;
  const parts: string[] = [];
  if (chosen.length > 0) {
    parts.push(`${chosen.map((s) => `${combo(s)} uses ${code(s.stream as string)}`).join('; ')}.`);
  }
  if (skipped.length > 0) {
    parts.push(
      `Specs that need ${skipped.map(combo).join(', ')} are skipped in this engine and environment, ` +
        `with the reason ${code(skipped[0]?.reason ?? '')}.`,
    );
  } else {
    parts.push(
      'No suite is skipped: every kind and protocol still has a stream that decodes (the unreliable flavour is only a fallback).',
    );
  }
  out.push(`- **Consequence for the lab:** ${parts.join(' ')}`, '');
  return out;
}

function renderInformational(files: readonly ResultFile[]): string[] {
  const labCases = new Set<string>(LAB_FLAVOURS);
  const rows: string[][] = [];
  for (const file of files) {
    for (const name of engineNames([file])) {
      const engine = probed(file.engines[name]);
      if (!engine) continue;
      for (const probeCase of PROBE_CASES) {
        if (labCases.has(probeCase.id)) continue;
        const result = engine.cases[probeCase.id];
        if (!result || (result.reliability === 'ok' && !claimsFalseButPlays(result))) continue;
        rows.push([
          file.envId,
          engineLabel(name, engine),
          code(probeCase.id),
          cellText(engine, result),
          failureText(result) ?? 'decoded although `isTypeSupported` said no',
        ]);
      }
    }
  }
  if (rows.length === 0) return ['No other case failed or disagreed with its `isTypeSupported` claim.', ''];
  return [
    'These are real failures or disagreements too, but no lab stream is made of them, so no suite is skipped because of them.',
    '',
    ...table(['Environment', 'Engine', 'Case', 'Verdict', 'Symptom'], rows),
    '',
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Format selection

function renderSelection(files: readonly ResultFile[]): string[] {
  const rows: string[][] = [];
  for (const file of files) {
    for (const name of engineNames([file])) {
      const engine = file.engines[name];
      if (!engine) continue;
      const caps: Capabilities = capabilitiesFromEngine(name, engine);
      rows.push([
        file.envId,
        engineLabel(name, engine),
        ...selectStreams(caps).map((s) => (s.stream ? code(s.stream) : 'skipped')),
      ]);
    }
  }
  return table(['Environment', 'Engine', 'VOD, DASH', 'VOD, HLS', 'Live, DASH', 'Live, HLS'], rows);
}

// ---------------------------------------------------------------------------------------------------------------------

export function renderMatrix(inputs: readonly ResultFile[]): string {
  const files = [...inputs].sort((a, b) => a.envId.localeCompare(b.envId));
  const out: string[] = [];

  out.push(
    '# Codec and MSE capability matrix',
    '',
    '> Generated by `npm run codec-matrix -- --render` from the JSON files in [results/codec-matrix](results/codec-matrix). Do not edit it by hand: the next render overwrites it, and `npm run codec-matrix -- --check` fails when it is stale.',
    '',
    'Which formats really play in the browsers the lab tests with, per environment, and what the lab does about the ones that do not. It is the evidence behind [ADR-001](DESIGN_DECISIONS.md) and the decisions in [decisions/codecs.md](decisions/codecs.md).',
    '',
  );

  out.push(
    '## How to read it',
    '',
    `- A **case** appends one or two ffmpeg-generated tracks (test patterns, 4 s, a keyframe every 2 s) to a ${code('MediaSource')}, plays the element, and passes only when media time passes the threshold **and**, for video, frames were presented. The element is muted and the data is fetched after the SourceBuffers exist, like a player page does it (the sensitivity table shows what happens when the page behaves differently). The probe never trusts ${code('MediaSource.isTypeSupported')}: a browser can claim support and still fail to play.`,
    '- A **cell** is the verdict over all attempts of a case, as `verdict passes/attempts`: `ok 5/5` decoded in every attempt; `intermittent 2/5` decoded in some; `fail 0/5` in none. `launch failed` means the engine did not start in that environment; `—` means the case was not run.',
    '- **Claims** are what `MediaSource.isTypeSupported` answered for every track type of the case. A cell is flagged **claims true but fails** when the engine claims support yet at least one attempt did not decode: the capability report cannot be trusted there. `claims false but plays` is the opposite disagreement. A plain `(claims false)` next to a failure is an honest "not supported".',
    '- Every attempt runs in a fresh browser process unless the run says otherwise, so one attempt cannot influence the next (a first probe suspected state leaking between cases in Linux WebKit; fresh processes remove the question), and the attempts repeat so that an intermittent engine shows as such. A time limit exists only as a safety net: a timeout is reported as a failure at the stage it happened in, never used as a measurement.',
    "- Failure text is the engine's own: `[stage] error`, where the stage is the step of the probe that failed (`launch`, `navigate`, `setup`, `sourceopen`, `addSourceBuffer`, `fetch`, `append`, `endOfStream`, `play`, `currentTime`, `frames`, `evaluate`), plus the media element's `MediaError` when it had one.",
    '- Results of different environments are never merged: a number measured on a laptop says nothing about a CI runner.',
    '',
  );

  out.push('## How it was produced', '');
  if (files.length === 0) {
    out.push(
      'No result file is committed yet. Run the commands under "Regenerating this document" and render again.',
      '',
    );
  } else {
    out.push(
      ...table(
        [
          'Environment',
          'Command',
          'Date (UTC)',
          'OS',
          'Node',
          'Playwright',
          'ffmpeg (probe media)',
          'Commit',
        ],
        files.map((file) => [
          code(file.envId),
          code(commandOf(file)),
          file.generatedAt.slice(0, 10),
          `${file.host.os.name} ${file.host.os.arch}, kernel ${file.host.os.release}, ${file.host.cpus} CPUs${file.dockerCpus ? ` (container limited to ${file.dockerCpus})` : ''}`,
          file.host.node,
          file.host.playwright,
          file.media.ffmpeg,
          file.host.git.commit
            ? `${code(file.host.git.commit)}${file.host.git.dirty ? ' (uncommitted changes)' : ''}`
            : 'unknown',
        ]),
      ),
      '',
    );
  }

  out.push('## Results', '');
  if (files.length > 0) {
    out.push(
      '### At a glance: the lab flavours in every environment and engine',
      '',
      ...renderOverview(files),
      '',
    );
  }
  for (const file of files) out.push(...renderEnvironment(file, engineNames([file])));

  out.push('## Documented gaps', '');
  const gaps = deriveGaps(files);
  if (gaps.length === 0) {
    out.push(
      'No gap in the committed results: every engine started and every lab flavour that was probed decoded in every attempt.',
      '',
    );
  } else {
    out.push(
      "Each gap is an engine in an environment where the lab cannot rely on what it streams. The symptom is the engine's own error text, the evidence is the raw data, and the consequence is computed by the same rule the test support code uses (see the next section). A suite affected by a gap is skipped with the reason shown here, never silently; a suite that fails where no gap is documented is a bug.",
      '',
    );
    gaps.forEach((gap, index) => out.push(...renderGap(gap, index + 1, files)));
  }
  out.push('### Other disagreements and failures', '', ...renderInformational(files));

  out.push(
    '## How the lab chooses a format',
    '',
    'Specs never hard-code a stream. The e2e support code probes the browser it runs in (or reads this evidence) and asks `pickStream(capabilities, kind, protocol)` from [src/lab/probe/capabilities.ts](../src/lab/probe/capabilities.ts). Candidates, in order:',
    '',
    ...table(
      ['Kind', 'Order', 'Stream', 'Flavour (what the browser must decode)', 'Protocols'],
      (['vod', 'live'] as const).flatMap((kind) =>
        STREAM_PREFERENCE[kind].map((id, index) => [
          kind === 'vod' ? 'VOD' : 'Live',
          index === 0 ? 'first choice' : 'fallback',
          code(id),
          code(LAB_STREAMS[id].flavour),
          LAB_STREAMS[id].protocols.map((p) => p.toUpperCase()).join(', '),
        ]),
      ),
    ),
    '',
    `The first stream whose flavour decoded in **every** attempt (${FLAVOUR_IDS.length} flavours are probed; an intermittent flavour is not supported, because a gate cannot be built on a coin flip) and that is served over the requested protocol wins. If none does, the spec is skipped with the reason ${code('explainNoStream(...)')} builds from the same data, which names each candidate flavour with its verdict. If a spec fails and the combination is not a documented gap above, that is a defect to fix, not a skip to add.`,
    '',
    'The choice per environment and engine, computed from the committed results:',
    '',
    ...(files.length === 0 ? ['(no results yet)'] : renderSelection(files)),
    '',
  );

  out.push(
    '## Regenerating this document',
    '',
    '```sh',
    '# macOS or Linux host with the browsers installed (needs ffmpeg once, to generate the probe media)',
    'npm run codec-matrix -- --browsers chromium,firefox,webkit --attempts 5',
    '',
    '# the Linux environment, in the Playwright image that matches the pinned version (the media comes from the host cache)',
    'npm run docker:pw -- npm run codec-matrix -- --browsers chromium,firefox,webkit --attempts 5',
    '',
    '# render this file from every committed result, or check that it is up to date',
    'npm run codec-matrix -- --render',
    'npm run codec-matrix -- --check',
    '```',
    '',
  );

  return `${out.join('\n')}\n`;
}

/** The same cells as plain text for the console summary of a run. */
export function renderSummary(file: ResultFile): string {
  const names = engineNames([file]);
  const labels = names.map((name) => engineLabel(name, file.engines[name]));
  const width = Math.max(
    ...PROBE_CASES.map((c) => c.id.length),
    ...CONTROL_CASES.map((c) => c.id.length),
    24,
  );
  const cell = (text: string): string => text.replace(/\*\*/g, '');
  const rows: Array<[string, string[]]> = [];
  for (const probeCase of PROBE_CASES) {
    const cells = names.map((name) =>
      cell(cellText(file.engines[name], probed(file.engines[name])?.cases[probeCase.id])),
    );
    if (cells.some((text) => text !== '—')) rows.push([probeCase.id, cells]);
  }
  for (const control of CONTROL_CASES) {
    const cells = names.map((name) =>
      cell(cellText(file.engines[name], probed(file.engines[name])?.controls[control.id])),
    );
    if (cells.some((text) => text !== '—')) rows.push([control.id, cells]);
  }
  for (const profile of SENSITIVITY_PROFILES) {
    const cells = names.map((name) =>
      cell(cellText(file.engines[name], probed(file.engines[name])?.sensitivity[profile.id])),
    );
    if (cells.some((text) => text !== '—')) rows.push([`${SENSITIVITY_CASE} [${profile.id}]`, cells]);
  }
  const lines = [
    `${file.envId}  (${file.options.attempts} attempts per case)`,
    `${'case'.padEnd(width)}  ${labels.join('   |   ')}`,
  ];
  for (const [id, cells] of rows) lines.push(`${id.padEnd(width)}  ${cells.join('   |   ')}`);
  return lines.join('\n');
}
