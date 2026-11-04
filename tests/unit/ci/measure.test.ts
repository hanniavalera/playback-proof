import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectEnvId } from '../../../src/shared/env.ts';
import { ROOT, WORKFLOW_DIR, code, commandOf, jobsOf, read, stepsOf } from '../support/ci-files.ts';

// measure.yml runs long measurements on GitHub's runners when somebody dispatches it by hand (ADR-175 to ADR-177, docs/CI.md). It takes
// free text (`args`, `label`) from whoever dispatches it, so what these tests keep is the property that makes that safe: the text reaches
// the shell only as data. They also keep the places where the file has to agree with the repository: the tasks and the scripts they run.
// The file is read as text, like the other workflows, and the checks are one function over the text, so that the last tests can run it
// over a copy with one mistake in it and see that it is reported.

const FILE = `${WORKFLOW_DIR}/measure.yml`;

/** The inputs of the workflow, and what each of them has to be. */
const INPUTS = {
  task: { type: 'choice', options: ['perf-baseline', 'perf-aa', 'ab', 'readiness', 'soak', 'flake-collect'] },
  runner: { type: 'choice', options: ['ubuntu-24.04', 'macos-15'] },
  engine: { type: 'choice', options: ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'] },
  args: { type: 'string' },
  repeat: { type: 'number' },
  timeout_minutes: { type: 'number' },
  label: { type: 'string' },
} as const;

/**
 * The files that a task runs and that are not on main yet, with the branch that has them. A task may call a file listed here while it
 * is missing; the day the branch merges, the test says that the entry has to go, and from then on it checks the file like any other.
 */
const PENDING: Readonly<Record<string, string>> = {
  'perf/aa.ts': 'p5/perf',
  'ab/run.ts': 'p6/ab',
  'live/readiness.ts': 'p7/live',
  'live/soak.ts': 'p7/live',
};

/** How each task is told which engine to use (null: it is not: the A/B plan names its own). */
const ENGINE_FLAG: Readonly<Record<string, string | null>> = {
  'perf-baseline': '--profile "$ENGINE"',
  'perf-aa': '--profile "$ENGINE"',
  ab: null,
  readiness: '--engine "$ENGINE"',
  soak: '--engine "$ENGINE"',
  'flake-collect': '--project "$ENGINE"',
};

/** The keys under which an input may be used in an expression: names and settings of the workflow, and environment variables. */
const KEYS_FOR_INPUTS = new Set(['run-name', 'group', 'name', 'runs-on', 'timeout-minutes', 'browser']);

const RESULT_PATHS = ['perf/baselines', 'docs/results', 'flake/history', 'reports', 'test-results'];

interface World {
  scripts: Readonly<Record<string, string>>;
  exists: (file: string) => boolean;
}

/** The lines under a top-level key (`on:`, `permissions:`), without the key. */
function section(body: string, key: string): string[] {
  const lines = body.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    out.push(line);
  }
  return out;
}

interface Input {
  type: string;
  options: string[];
}

/** The inputs of `workflow_dispatch`: their type and their options. */
function dispatchInputs(body: string): Map<string, Input> {
  const out = new Map<string, Input>();
  let current: Input | undefined;
  let inInputs = false;
  for (const line of section(body, 'on')) {
    if (line === '    inputs:') {
      inInputs = true;
      continue;
    }
    if (!inInputs) continue;
    const head = /^ {6}([a-z_]+):$/.exec(line);
    if (head) {
      current = { type: '', options: [] };
      out.set(head[1] ?? '', current);
      continue;
    }
    const type = /^ {8}type: (\w+)$/.exec(line);
    if (type && current) current.type = type[1] ?? '';
    const option = /^ {10}- (\S+)$/.exec(line);
    if (option && current) current.options.push(option[1] ?? '');
  }
  return out;
}

/** The branches of the `case "$TASK"` of the run step: the label and the commands under it. */
function branches(script: string): Map<string, string> {
  const out = new Map<string, string>();
  let label: string | null = null;
  for (const line of script.split('\n')) {
    const head = /^([a-z*-]+)\)$/.exec(line);
    if (head) {
      label = head[1] ?? '';
      out.set(label, '');
    } else if (label !== null) out.set(label, `${out.get(label)}${line}\n`);
  }
  return out;
}

/** The file a script runs: `tsx perf/run.ts --write-baseline` runs perf/run.ts. */
const fileOf = (script: string): string | undefined => /\btsx ([\w./-]+\.ts)\b/.exec(script)?.[1];

/** What is wrong with the workflow, as sentences. Empty when it keeps everything. */
function problems(text: string, world: World): string[] {
  const out: string[] = [];
  const body = code(text);
  const jobs = jobsOf(body);
  const measure = jobs.get('measure') ?? '';

  // Who can start it, and with what token.
  const events = [
    ...section(body, 'on')
      .join('\n')
      .matchAll(/^ {2}([a-z_]+):/gm),
  ].map((m) => m[1]);
  if (events.join() !== 'workflow_dispatch') {
    out.push(`it must start only by hand (workflow_dispatch), not on: ${events.join(', ')}`);
  }
  if (section(body, 'permissions').join('\n').trim() !== 'contents: read') {
    out.push('the token must be contents: read at the top');
  }
  if ((body.match(/^\s*permissions:/gm) ?? []).length !== 1) {
    out.push('no job may ask for permissions of its own');
  }
  if (/continue-on-error|pull_request_target|secrets\./.test(body)) {
    out.push('no continue-on-error, no pull_request_target and no secret');
  }

  // The inputs: closed choices where the value picks code, and only the inputs of the brief.
  const inputs = dispatchInputs(body);
  if ([...inputs.keys()].join() !== Object.keys(INPUTS).join()) {
    out.push(`the inputs are ${[...inputs.keys()].join(', ')}, not ${Object.keys(INPUTS).join(', ')}`);
  }
  for (const [name, wanted] of Object.entries(INPUTS)) {
    const input = inputs.get(name);
    if (input?.type !== wanted.type)
      out.push(`input ${name} must be a ${wanted.type}, not ${input?.type ?? 'missing'}`);
    if ('options' in wanted && input?.options.join() !== wanted.options.join()) {
      out.push(`input ${name} must offer exactly ${wanted.options.join(', ')}`);
    }
  }

  // Data, not code: no expression in a script, and an input only under the keys that cannot be a script.
  for (const job of jobs.values()) {
    for (const step of stepsOf(job)) {
      if (commandOf(step)?.includes('${{')) out.push(`step "${step.name}" has an expression in its script`);
    }
  }
  for (const line of body.split('\n')) {
    if (!/inputs\.|github\.event\.inputs/.test(line)) continue;
    const key = /^\s*(?:- )?([A-Za-z_][\w.-]*):/.exec(line)?.[1];
    if (
      /github\.event\.inputs/.test(line) ||
      key === undefined ||
      !(KEYS_FOR_INPUTS.has(key) || /^[A-Z][A-Z0-9_]*$/.test(key))
    ) {
      out.push(`an input is used where it could be code: ${line.trim()}`);
    }
  }

  // The run step: one branch per task, each calling files that exist or are pending, each given the engine the way its CLI takes it.
  const run = stepsOf(measure).find((s) => s.name === 'Run the task');
  const script = (run && commandOf(run)) ?? '';
  const byTask = branches(script);
  const tasks = Object.keys(ENGINE_FLAG);
  const choices = inputs.get('task')?.options ?? [];
  if (
    [...byTask.keys()]
      .filter((l) => l !== '*')
      .sort()
      .join() !== [...choices].sort().join()
  ) {
    out.push(
      `the case of the run step has branches ${[...byTask.keys()].join(', ')} for the tasks ${choices.join(', ')}`,
    );
  }
  if (!byTask.has('*')) out.push('the case of the run step has no branch for an unknown task');
  const needed = new Set<string>();
  for (const task of tasks) {
    const branch = byTask.get(task) ?? '';
    for (const [, name] of branch.matchAll(/npm run ([\w:.-]+)/g)) {
      const known = world.scripts[name ?? ''];
      if (known === undefined) out.push(`${task} runs npm run ${name}, which package.json does not have`);
      else if (fileOf(known)) needed.add(fileOf(known) as string);
    }
    for (const [, file] of branch.matchAll(/npx tsx ([\w./-]+\.ts)/g)) needed.add(file ?? '');
    const flag = ENGINE_FLAG[task];
    if (flag !== null && flag !== undefined && !branch.includes(flag))
      out.push(`${task} is not given the engine as ${flag}`);
    if (flag === null && branch.includes('$ENGINE'))
      out.push(`${task} takes its engine from its plan, not from the input`);
  }
  for (const file of needed) {
    if (!world.exists(file) && PENDING[file] === undefined)
      out.push(`${file} is missing and not listed as pending`);
  }
  for (const [file, branch] of Object.entries(PENDING)) {
    if (world.exists(file)) out.push(`${file} exists now (${branch} has merged): remove it from PENDING`);
    if (!needed.has(file)) out.push(`PENDING lists ${file}, which no task runs`);
  }

  // The rest of the job.
  if (
    !/^ {4}needs: streams$/m.test(measure) ||
    !/^ {2}streams:\n {4}name: streams\n {4}uses: \.\/\.github\/workflows\/streams\.yml$/m.test(body)
  ) {
    out.push('the job must need the streams job, which is the reusable workflow of ci.yml');
  }
  if (!measure.includes("browser: ${{ inputs.engine == 'chromium-cpu4x' && 'chromium' || inputs.engine }}")) {
    out.push('the browser to install is the engine, and Chromium for chromium-cpu4x');
  }
  if (
    !/^ {4}timeout-minutes: \$\{\{ fromJSON\(inputs\.timeout_minutes > 340 && '340' \|\| inputs\.timeout_minutes < 1 && '1' \|\| inputs\.timeout_minutes\) \}\}$/m.test(
      measure,
    )
  ) {
    out.push(
      'the job must be limited to 340 minutes whatever is asked, as a number: an expression of strings is refused by GitHub (Unexpected value)',
    );
  }
  if (!measure.includes('timeout-minutes: ${{ fromJSON(steps.meta.outputs.task_timeout) }}')) {
    out.push('the task must have a limit of its own, shorter than the job, so that the upload still runs');
  }
  if (
    !/^ {2}group: measure-\$\{\{ inputs\.task \}\}-\$\{\{ inputs\.label \}\}-\$\{\{ inputs\.runner \}\}-\$\{\{ inputs\.engine \}\}\n {2}cancel-in-progress: false$/m.test(
      body,
    )
  ) {
    out.push('one measurement per task, label, runner and engine, and never cancelled');
  }
  if (/PB_ENV_ID/.test(body)) out.push('the environment id is the code’s own (detectEnvId), not an override');
  const upload = stepsOf(measure).find((s) => s.text.includes('uses: actions/upload-artifact@'));
  if (!upload || !/^ {8}if: always\(\)$/m.test(upload.text))
    out.push('the results are uploaded also when the task failed');
  if (!upload?.text.includes('name: ${{ steps.meta.outputs.artifact }}'))
    out.push('the artifact is named by the sanitised name of the first step');
  for (const path of RESULT_PATHS) {
    if (!upload?.text.includes(`            ${path}\n`)) out.push(`the artifact must carry ${path}`);
  }
  const machine = stepsOf(measure).find((s) => s.name === 'Record the machine');
  const facts = (machine && commandOf(machine)) ?? '';
  for (const fact of [
    'reports/measure-machine.txt',
    'uname -a',
    'uptime',
    'node --version',
    'npm --version',
    'playwright --version',
    'ffmpeg',
    'detectEnvId',
    'memory',
    'cpus',
  ]) {
    if (!facts.includes(fact)) out.push(`the machine record has no ${fact}`);
  }
  return out;
}

const world: World = {
  scripts: (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
  exists: (file) => existsSync(join(ROOT, file)),
};
const text = read(FILE);

describe('the measurement workflow keeps its promises', () => {
  it('has no problem: dispatched by hand, a read token, inputs that are data, tasks that map to files', () => {
    expect(problems(text, world)).toEqual([]);
  });

  it('reads the real inputs and tasks, so that the checks above are not empty', () => {
    const inputs = dispatchInputs(code(text));
    expect([...inputs.keys()]).toEqual(Object.keys(INPUTS));
    expect(inputs.get('task')?.options).toHaveLength(6);
    const script = commandOf(
      stepsOf(jobsOf(code(text)).get('measure') ?? '').find((s) => s.name === 'Run the task') ?? {
        name: '',
        text: '',
      },
    );
    expect([...branches(script ?? '').keys()]).toEqual([...INPUTS.task.options, '*']);
  });

  it('names the runners the way the documentation says, without an override', () => {
    const ubuntu = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
    const macos = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' };
    expect(detectEnvId(ubuntu)).toBe('gha-linux-x64');
    expect(detectEnvId(macos)).toBe('gha-macos-arm64');
    expect(text).not.toContain('PB_ENV_ID');
  });
});

describe('the measurement workflow test fails when a promise is broken', () => {
  const broken = (change: (t: string) => string, w: World = world): string =>
    problems(change(text), w).join('\n');
  const replaced = (from: string, to: string) => (t: string) => {
    expect(t, `the mutation needs "${from}" in the file`).toContain(from);
    return t.replace(from, to);
  };

  it('puts an input into a script', () => {
    expect(
      broken(replaced('read -r -a ARGV <<< "$ARGS"', 'read -r -a ARGV <<< "${{ inputs.args }}"')),
    ).toContain('has an expression in its script');
    expect(broken(replaced('ARGS: ${{ inputs.args }}', 'ARGS: ${{ github.event.inputs.args }}'))).toContain(
      'an input is used where it could be code',
    );
    expect(broken(replaced('  group: measure-', '  note: ${{ inputs.args }}\n  group: measure-'))).toContain(
      'an input is used where it could be code',
    );
  });

  it('lets the workflow start on something else, or write', () => {
    expect(
      broken(replaced('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:')),
    ).toContain('must start only by hand');
    expect(broken(replaced('  contents: read', '  contents: write'))).toContain(
      'the token must be contents: read',
    );
    expect(
      broken(
        replaced('    needs: streams\n', '    needs: streams\n    permissions:\n      contents: read\n'),
      ),
    ).toContain('no job may ask for permissions');
    expect(
      broken(
        replaced(
          'actions/upload-artifact@v7\n',
          'actions/upload-artifact@v7\n        continue-on-error: true\n',
        ),
      ),
    ).toContain('continue-on-error');
  });

  it('opens the task to free text, or adds a task nobody runs, or drops one', () => {
    expect(
      broken(
        replaced(
          '        type: choice\n        required: true',
          '        type: string\n        required: true',
        ),
      ),
    ).toContain('input task must be a choice');
    expect(
      broken(replaced('          - flake-collect\n', '          - flake-collect\n          - cleanup\n')),
    ).toContain('input task must offer exactly');
    expect(broken(replaced('            soak)\n', '            soak-run)\n'))).toContain(
      'the case of the run step has branches',
    );
    expect(broken(replaced('            *)\n', '            nothing)\n'))).toContain(
      'no branch for an unknown task',
    );
  });

  it('runs a script or a file that does not exist, and keeps a pending entry that is stale', () => {
    expect(broken(replaced('npm run perf:baseline', 'npm run perf:basline'))).toContain(
      'package.json does not have',
    );
    expect(broken(replaced('npx tsx perf/aa.ts', 'npx tsx perf/aaa.ts'))).toContain(
      'perf/aaa.ts is missing and not listed as pending',
    );
    expect(broken((t) => t, { ...world, exists: () => true })).toContain(
      'exists now (p5/perf has merged): remove it from PENDING',
    );
    expect(
      broken((t) => t, { ...world, exists: (f) => f !== 'tools/flake-collect.ts' && world.exists(f) }),
    ).toContain('tools/flake-collect.ts is missing and not listed as pending');
    expect(broken(replaced('npm run soak', 'npm run flake:gate'))).toContain(
      'PENDING lists live/soak.ts, which no task runs',
    );
  });

  it('forgets to hand over the engine, or hands one to a task that has its own', () => {
    expect(
      broken(replaced('npm run readiness -- --engine "$ENGINE"', 'npm run readiness -- --engine chromium')),
    ).toContain('readiness is not given the engine');
    expect(
      broken(replaced('npm run ab -- "${ARGV[@]}"', 'npm run ab -- --engine "$ENGINE" "${ARGV[@]}"')),
    ).toContain('ab takes its engine from its plan');
  });

  it('loses the results of a task that failed, or the means to tell machines apart, or lets two measurements cancel each other', () => {
    expect(
      broken(
        replaced(
          '        if: always()\n        uses: actions/upload-artifact@v7',
          '        uses: actions/upload-artifact@v7',
        ),
      ),
    ).toContain('uploaded also when the task failed');
    expect(broken(replaced('            docs/results\n', ''))).toContain(
      'the artifact must carry docs/results',
    );
    expect(broken(replaced('echo "uname: $(uname -a)"', 'echo "uname: none"'))).toContain(
      'the machine record has no uname -a',
    );
    expect(broken(replaced('cancel-in-progress: false', 'cancel-in-progress: true'))).toContain(
      'never cancelled',
    );
    expect(
      broken(replaced('      PB_WORKERS:', '      PB_ENV_ID: gha-linux-x64\n      PB_WORKERS:')),
    ).toContain('the environment id is the code’s own');
  });

  it('loses the limits: the job, the task, the browser of chromium-cpu4x', () => {
    expect(
      broken(
        replaced("inputs.timeout_minutes > 340 && '340' ||", "inputs.timeout_minutes > 400 && '400' ||"),
      ),
    ).toContain('limited to 340 minutes');
    expect(
      broken(replaced('timeout-minutes: ${{ fromJSON(steps.meta.outputs.task_timeout) }}\n', '')),
    ).toContain('limit of its own');
    expect(
      broken(replaced("inputs.engine == 'chromium-cpu4x' && 'chromium' || inputs.engine", 'inputs.engine')),
    ).toContain('Chromium for chromium-cpu4x');
  });
});
