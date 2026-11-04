import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_DIR,
  allFiles,
  callsIn,
  code,
  commandOf,
  jenkinsCalls,
  jobsOf,
  legsOf,
  read,
  stepsOf,
  withoutGroovyComments,
} from '../support/ci-files.ts';
import type { Call } from '../support/ci-files.ts';

// The same merge gate in two CI systems is only worth saying if the two files cannot drift apart unseen (ADR-173). This compares what
// each of them calls: the gate scripts and their order, the projects of the merge gate, the arguments each script is given, and that
// every script exists in package.json. What may differ is listed below, with the reason, and a difference that is not listed is a
// failure; so is a listed difference that no longer exists. The comparison is one function over the text of the two files, so that
// the same function can be run over a file with a mistake in it: the last tests do that, once per kind of mistake.

/** What may differ between the two pipelines, and why. Anything else must be equal. */
const ALLOWED = {
  /** The legs of GitHub with no Jenkins stage: no container is a macOS agent (README of the Jenkins setup, ADR-113, ADR-119). */
  githubOnlyLegs: ['webkit-macos'],
  /**
   * Options only GitHub gives a script. `--global-timeout`: a hosted runner kills a job at its timeout and takes the report with it, so
   * Playwright is told to stop earlier (ADR-114); Jenkins has the timeout of the build. `--git-identity`, `--push` and `--json`: the
   * history is a git branch there (ADR-172) and a file on a volume here (ADR-174), and GitHub judges two environments in one job.
   */
  githubOnlyOptions: {
    'gate:merge': ['--global-timeout'],
    'gate:flake': ['--git-identity', '--json', '--push'],
  } as Record<string, string[]>,
  /** The history store each system uses. */
  store: { github: 'git', jenkins: 'file' },
};

/** The gates in the order of the table of TEST_STRATEGY.md section 6.1. */
const strategyOrder = (strategy: string): string[] =>
  [...strategy.matchAll(/^\| `(gate:[\w-]+)` \|/gm)].map((m) => m[1] ?? '');

/** The calls of the steps of a workflow, in the order of the file. */
function workflowCalls(text: string): Call[] {
  return [...jobsOf(code(text)).values()].flatMap((job) =>
    stepsOf(job).flatMap((step) => callsIn(commandOf(step) ?? '')),
  );
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const gatesOf = (calls: readonly Call[]): string[] =>
  unique(calls.map((c) => c.script).filter((script) => script.startsWith('gate:')));
const optionNames = (args: readonly string[]): string[] =>
  args.filter((a) => a.startsWith('--') && a !== '--').map((a) => a.split('=')[0] ?? a);
const valueOf = (args: readonly string[], option: string): string | undefined => {
  const at = args.indexOf(option);
  return at < 0 ? undefined : args[at + 1];
};
const isSubsequence = (items: readonly string[], order: readonly string[]): boolean => {
  let next = 0;
  for (const entry of order) if (entry === items[next]) next++;
  return next === items.length;
};

/** The gate scripts with their options, the flake gate told apart by what it does with the build. */
function optionsByGate(calls: readonly Call[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const call of calls) {
    if (!call.script.startsWith('gate:')) continue;
    const key = call.script === 'gate:flake' ? `gate:flake (${flakeMode(call)})` : call.script;
    const set = out.get(key) ?? new Set<string>();
    for (const name of optionNames(call.args)) set.add(name);
    out.set(key, set);
  }
  return out;
}
const flakeMode = (call: Call): 'record' | 'judge' => (call.args.includes('--record') ? 'record' : 'judge');

interface Sources {
  /** `.github/workflows/ci.yml` */
  ci: string;
  jenkinsfile: string;
  /** The `scripts` of package.json. */
  scripts: Record<string, string>;
  /** TEST_STRATEGY.md */
  strategy: string;
}

/** What differs between the two pipelines, as sentences. Empty when they are the same up to what ALLOWED says. */
function differences({ ci, jenkinsfile, scripts, strategy }: Sources): string[] {
  const problems: string[] = [];
  const github = workflowCalls(ci);
  const jenkins = jenkinsCalls(jenkinsfile);

  // The same gate scripts, in the same order, which is the order of the strategy.
  const githubGates = gatesOf(github);
  const jenkinsGates = gatesOf(jenkins);
  if (githubGates.join(' ') !== jenkinsGates.join(' ')) {
    problems.push(
      `the gate scripts differ: GitHub calls ${githubGates.join(', ')}; Jenkins calls ${jenkinsGates.join(', ')}`,
    );
  }
  const order = strategyOrder(strategy);
  for (const [name, gates] of [
    ['ci.yml', githubGates],
    ['the Jenkinsfile', jenkinsGates],
  ] as const) {
    if (!isSubsequence(gates, order)) {
      problems.push(`${name} calls the gates in an order the strategy does not list: ${gates.join(', ')}`);
    }
  }

  // The same projects in the merge gate; the macOS leg of GitHub is the one difference.
  const legs = legsOf(jobsOf(code(ci)).get('merge-gate') ?? '');
  const mergeArgs = github.find((c) => c.script === 'gate:merge')?.args ?? [];
  if (mergeArgs[0] !== '--project=${{matrix.project}}') {
    problems.push(`ci.yml gives gate:merge the project of the leg first, not ${mergeArgs[0] ?? 'nothing'}`);
  }
  const jenkinsProjects = jenkins
    .filter((c) => c.script === 'gate:merge')
    .map((c) => c.args.find((a) => a.startsWith('--project='))?.slice('--project='.length) ?? '');
  const linuxProjects = legs.filter((l) => !l.runner.startsWith('macos')).map((l) => l.project);
  if (linuxProjects.join(' ') !== jenkinsProjects.join(' ')) {
    problems.push(
      `the merge gate runs other projects: the Linux legs of GitHub run ${linuxProjects.join(', ')}; Jenkins runs ${jenkinsProjects.join(', ')}`,
    );
  }
  const githubOnly = legs.filter((l) => l.runner.startsWith('macos')).map((l) => l.leg);
  if (githubOnly.join(' ') !== ALLOWED.githubOnlyLegs.join(' ')) {
    problems.push(
      `the legs that only GitHub runs are ${githubOnly.join(', ') || 'none'}, and the one allowed difference is ${ALLOWED.githubOnlyLegs.join(', ')}`,
    );
  }

  // The same arguments, but the ones that are allowed to differ, which must still be there.
  const githubOptions = optionsByGate(github);
  const jenkinsOptions = optionsByGate(jenkins);
  for (const key of unique([...githubOptions.keys(), ...jenkinsOptions.keys()])) {
    const script = key.replace(/ \(.*\)$/, '');
    const allowed = ALLOWED.githubOnlyOptions[script] ?? [];
    const onGithub = [...(githubOptions.get(key) ?? [])].filter((o) => !allowed.includes(o)).sort();
    const onJenkins = [...(jenkinsOptions.get(key) ?? [])].sort();
    if (githubOptions.has(key) !== jenkinsOptions.has(key)) continue; // reported as a gate script that differs
    if (onGithub.join(' ') !== onJenkins.join(' ')) {
      problems.push(
        `${key} is given other options: GitHub ${onGithub.join(' ') || 'none'}, Jenkins ${onJenkins.join(' ') || 'none'} (allowed to be only GitHub's: ${allowed.join(' ') || 'none'})`,
      );
    }
  }
  for (const [script, allowed] of Object.entries(ALLOWED.githubOnlyOptions)) {
    const given = new Set(
      [...githubOptions].filter(([key]) => key.startsWith(script)).flatMap(([, names]) => [...names]),
    );
    for (const option of allowed) {
      if (!given.has(option))
        problems.push(`${option} is allowed on GitHub's ${script} but is not there: remove it from ALLOWED`);
    }
  }

  // The flake gate judges every build and records the builds of main, in both; the store is the one each system has.
  const modes = (calls: readonly Call[]): string =>
    unique(calls.filter((c) => c.script === 'gate:flake').map(flakeMode))
      .sort()
      .join(' ');
  if (modes(github) !== modes(jenkins)) {
    problems.push(`gate:flake runs in other modes: GitHub ${modes(github)}; Jenkins ${modes(jenkins)}`);
  }
  for (const [system, calls] of [
    ['github', github],
    ['jenkins', jenkins],
  ] as const) {
    const stores = unique(
      calls.filter((c) => c.script === 'gate:flake').map((c) => valueOf(c.args, '--store')),
    );
    if (stores.join(' ') !== ALLOWED.store[system]) {
      problems.push(
        `${system} judges against the ${ALLOWED.store[system]} store, not ${stores.join(', ') || 'none'}`,
      );
    }
  }

  // A script that is given arguments runs its command itself: npm gives the arguments of an alias to itself (gate:flake was one).
  for (const [system, calls] of [
    ['ci.yml', github],
    ['the Jenkinsfile', jenkins],
  ] as const) {
    for (const call of calls) {
      if (call.args.length > 0 && /^npm run [\w:.-]+$/.test(scripts[call.script] ?? '')) {
        problems.push(
          `${system} gives ${call.script} arguments, but it is an alias of another npm script (${scripts[call.script]}): npm would keep them`,
        );
      }
    }
  }
  return problems;
}

/** The `npm run <script>` of a file that package.json does not have. */
function unknownTargets(files: Readonly<Record<string, string>>, scripts: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) => {
    const plain = file === 'Jenkinsfile' ? withoutGroovyComments(text) : code(text);
    return [...plain.matchAll(/npm run ([\w:.-]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((script) => scripts[script] === undefined)
      .map((script) => `${file}: npm run ${script} is not a script of package.json`);
  });
}

const sources: Sources = {
  ci: read(`${WORKFLOW_DIR}/ci.yml`),
  jenkinsfile: read('Jenkinsfile'),
  scripts: (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
  strategy: read('TEST_STRATEGY.md'),
};
const pipelineFiles: Record<string, string> = {
  Jenkinsfile: sources.jenkinsfile,
  ...Object.fromEntries(allFiles.map((file) => [file, read(file)])),
};

describe('the parity of the Jenkinsfile and the GitHub workflows', () => {
  it('finds no difference between them that is not an allowed one', () => {
    expect(differences(sources)).toEqual([]);
  });

  it('has an order of gates to compare, and the same engines to compare them on', () => {
    expect(strategyOrder(sources.strategy)).toEqual([
      'gate:static',
      'gate:unit',
      'gate:merge',
      'gate:perf',
      'gate:flake',
      'gate:triage',
    ]);
    expect(gatesOf(workflowCalls(sources.ci))).toEqual([
      'gate:static',
      'gate:unit',
      'gate:merge',
      'gate:perf',
      'gate:flake',
      'gate:triage',
    ]);
    expect(gatesOf(jenkinsCalls(sources.jenkinsfile))).toEqual([
      'gate:static',
      'gate:unit',
      'gate:merge',
      'gate:perf',
      'gate:flake',
      'gate:triage',
    ]);
  });

  it('calls only npm scripts that exist, in every workflow, in the setup action and in the Jenkinsfile', () => {
    expect(Object.keys(pipelineFiles).length).toBeGreaterThan(5);
    expect(unknownTargets(pipelineFiles, sources.scripts)).toEqual([]);
  });
});

describe('the parity test fails when the pipelines drift apart', () => {
  const mutate = (change: Partial<Sources> | ((s: Sources) => Partial<Sources>)): string[] =>
    differences({ ...sources, ...(typeof change === 'function' ? change(sources) : change) });
  const expectProblem = (problems: string[], fragment: string): void => {
    expect(problems.join('\n')).toContain(fragment);
  };

  it('renames a gate in one file: a script that is not there, and gates that differ', () => {
    const jenkinsfile = sources.jenkinsfile.replaceAll('npm run gate:unit', 'npm run gate:unti');
    expectProblem(mutate({ jenkinsfile }), 'the gate scripts differ');
    expectProblem(
      mutate({ ci: sources.ci.replaceAll('gate:merge', 'gate:merg') }),
      'the gate scripts differ',
    );
    expect(unknownTargets({ Jenkinsfile: jenkinsfile }, sources.scripts)).toEqual([
      'Jenkinsfile: npm run gate:unti is not a script of package.json',
    ]);
  });

  it('adds a gate to one file only', () => {
    const jenkinsfile = sources.jenkinsfile.replace(
      "sh 'npm run gate:unit'",
      "sh 'npm run gate:unit'\n sh 'npm run gate:perf'",
    );
    expectProblem(mutate({ jenkinsfile }), 'the gate scripts differ');
  });

  it('runs a gate in another order', () => {
    const jenkinsfile = sources.jenkinsfile.replace(
      "sh 'npm run gate:static'",
      "sh 'npm run gate:merge -- --project=chromium'\n sh 'npm run gate:static'",
    );
    expectProblem(mutate({ jenkinsfile }), 'in an order the strategy does not list');
  });

  it('leaves an engine out of one of the files', () => {
    const jenkinsfile = sources.jenkinsfile.replace(
      "sh 'npm run gate:merge -- --project=webkit'",
      "sh 'true'",
    );
    expectProblem(mutate({ jenkinsfile }), 'the merge gate runs other projects');
    const ci = sources.ci.replace(/ {10}- leg: firefox\n(?: {12}.+\n)+/, '');
    expectProblem(mutate({ ci }), 'the merge gate runs other projects');
  });

  it('adds a leg or drops the macOS one: the allowed difference is exactly one leg', () => {
    const ci = sources.ci.replace(/ {10}- leg: webkit-macos\n(?: {12}.+\n)+/, '');
    expectProblem(mutate({ ci }), 'the one allowed difference is webkit-macos');
  });

  it('gives a script an option in one file only, and keeps the allowed ones honest', () => {
    const ci = sources.ci.replace(
      '--global-timeout=${{ matrix.limit }}',
      '--global-timeout=${{ matrix.limit }} --workers=1',
    );
    expectProblem(mutate({ ci }), 'gate:merge is given other options');
    const jenkinsfile = sources.jenkinsfile.replace(
      "sh 'npm run gate:static'",
      "sh 'npm run gate:static -- --fast'",
    );
    expectProblem(mutate({ jenkinsfile }), 'gate:static is given other options');
    // The allowance for --global-timeout is dead if no leg passes it any more.
    const stale = sources.ci.replaceAll(' --global-timeout=${{ matrix.limit }}', '');
    expectProblem(mutate({ ci: stale }), '--global-timeout is allowed on GitHub');
  });

  it('records in one system only, or on another store', () => {
    const jenkinsfile = sources.jenkinsfile.replace(
      "sh 'npm run gate:flake -- --store file --runs reports/flake --record'",
      "sh 'true'",
    );
    expectProblem(mutate({ jenkinsfile }), 'gate:flake runs in other modes');
    const git = sources.jenkinsfile.replaceAll('--store file', '--store git');
    expectProblem(mutate({ jenkinsfile: git }), 'jenkins judges against the file store');
  });

  it('turns a script that is given arguments into an alias of another one, as gate:flake was', () => {
    const scripts = { ...sources.scripts, 'gate:flake': 'npm run flake:gate' };
    expectProblem(mutate({ scripts }), 'is an alias of another npm script');
  });
});
