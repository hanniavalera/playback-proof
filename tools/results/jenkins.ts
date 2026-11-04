// RESULTS_JENKINS: the builds of the local Jenkins whose evidence is committed (docs/results/jenkins/build-<n>.json, written by
// tools/jenkins-evidence.ts from the Jenkins REST API): what each build was for, how it ended against what was intended, and how
// long each stage took. The pipeline has grown since (the file says which stages a build ran): a build proves the stages it shows.
import { data, emptyState } from './files.ts';
import type { FileSet, Node, Rendered } from './files.ts';
import { code, day, link, listOf, mdTable, plural, seconds, shorten } from './format.ts';

export const JENKINS_DIR = 'docs/results/jenkins';
export const JENKINSFILE = 'Jenkinsfile';

interface Stage {
  name: string;
  group: string | null;
  status: string;
  durationMs: number;
}

interface Build {
  path: string;
  build: number;
  label: string;
  result: string;
  expected: string;
  expectedStage: string | null;
  asExpected: boolean;
  startedAt: string;
  durationMs: number;
  branch: string;
  commit: string;
  stages: Stage[];
  failure: string | null;
  environment: string;
}

function readStage(node: Node): Stage {
  return {
    name: node.at('name').str(),
    group: node.opt('group')?.str() ?? null,
    status: node.at('status').str(),
    durationMs: node.at('durationMs').num(),
  };
}

const stageText = (stage: Stage): string => {
  if (stage.status === 'SUCCESS') return `${stage.name} ${seconds(stage.durationMs)}`;
  return `${stage.name} ${stage.status} ${seconds(stage.durationMs)}`;
};

/** The stages that ran, a group with its members in brackets, then the ones that did not run. */
export function describeStages(stages: readonly Stage[]): string {
  const notRun = stages.filter((s) => s.status === 'NOT_EXECUTED');
  const ran = stages.filter((s) => s.status !== 'NOT_EXECUTED');
  const parts = ran
    .filter((s) => s.group === null)
    .map((parent) => {
      const children = ran.filter((s) => s.group === parent.name);
      return children.length === 0
        ? stageText(parent)
        : `${stageText(parent)} (${children.map(stageText).join(', ')})`;
    });
  const orphans = ran.filter(
    (s) => s.group !== null && !ran.some((p) => p.group === null && p.name === s.group),
  );
  if (orphans.length > 0) parts.push(...orphans.map(stageText));
  if (notRun.length > 0) parts.push(`not run: ${notRun.map((s) => s.name).join(', ')}`);
  return parts.join('; ');
}

function failureText(node: Node | undefined): string | null {
  if (node === undefined) return null;
  const stage = node.at('stage').str();
  const group = node.opt('group')?.str();
  const where = group ? `${stage} (${group})` : stage;
  const byTest = new Map<string, string[]>();
  for (const entry of node.at('tests').list()) {
    const id = entry.at('test').at('id').str();
    byTest.set(id, [...(byTest.get(id) ?? []), entry.at('project').str()]);
  }
  const tests = [...byTest].map(([id, projects]) => `${code(id)} in ${projects.join(', ')}`);
  return tests.length === 0 ? where : `${where}: ${tests.join('; ')}`;
}

function environmentOf(root: Node): string {
  const jenkins = root.at('jenkins');
  const agents = root
    .at('agents')
    .list()
    .map((a) => `${code(a.at('name').str())} with ${plural(a.at('executors').int(), 'executor')}`);
  const tools = root.at('tools');
  const tool = (name: string, label = name): string => `${label} ${tools.opt(name)?.str() ?? 'not recorded'}`;
  return `Jenkins ${jenkins.at('version').str()} with ${plural(jenkins.at('pluginCount').int(), 'plugin')} and ${plural(jenkins.at('executorsOnController').int(), 'executor')} on the controller; agent ${listOf(agents)}; ${[tool('node', 'Node'), tool('npm', 'npm'), tool('ffmpeg', 'ffmpeg'), tool('java', 'Java'), tool('playwright', 'Playwright')].join(', ')}`;
}

function readBuild(files: FileSet, path: string): Build {
  const root = files.json(path);
  if (root.at('schemaVersion').int() !== 1)
    root.at('schemaVersion').fail('this renderer reads schema version 1');
  const build = root.at('build').int();
  if (path !== `${JENKINS_DIR}/build-${build}.json`) {
    root.at('build').fail(`says build ${build}, so the file must be build-${build}.json`);
  }
  return {
    path,
    build,
    label: root.at('label').str(),
    result: root.at('result').str(),
    expected: root.at('expected').str(),
    expectedStage: root.opt('expectedStage')?.str() ?? null,
    asExpected: root.at('asExpected').bool(),
    startedAt: root.at('startedAt').str(),
    durationMs: root.at('durationMs').num(),
    branch: root.at('branch').str(),
    commit: root.at('commit').str(),
    stages: root.at('stages').list().map(readStage),
    failure: failureText(root.opt('failure')),
    environment: environmentOf(root),
  };
}

function resultText(build: Build): string {
  const intended = `${build.expected}${build.expectedStage ? ` in ${build.expectedStage}` : ''}`;
  return build.asExpected
    ? `${build.result} (as intended)`
    : `${build.result} (not as intended; intended: ${intended})`;
}

function jenkinsfileStages(text: string): string[] {
  return [...new Set([...text.matchAll(/^\s*stage\('([^']+)'\)/gm)].map((m) => m[1] ?? ''))];
}

export function renderJenkins(files: FileSet): Rendered {
  const paths = files.list(JENKINS_DIR, /^build-\d+\.json$/);
  if (paths.length === 0) return emptyState('Jenkins builds', JENKINS_DIR);
  const builds = paths.map((path) => readBuild(files, path)).sort((a, b) => a.build - b.build);

  const table = mdTable(
    ['Build', 'Date, branch, commit', 'What it was for', 'Result', 'Duration', 'Stages', 'Where it failed'],
    builds.map((b) => [
      link(String(b.build), b.path),
      `${day(b.startedAt)}, ${code(b.branch)}, ${code(b.commit.slice(0, 7))}`,
      shorten(b.label, 340),
      resultText(b),
      seconds(b.durationMs),
      describeStages(b.stages),
      b.failure ?? '-',
    ]),
  );

  const groups = new Map<string, number[]>();
  for (const b of builds) groups.set(b.environment, [...(groups.get(b.environment) ?? []), b.build]);
  const environment = [...groups].map(
    ([text, numbers]) =>
      `- ${numbers.length === 1 ? 'Build' : 'Builds'} ${listOf(numbers.map(String))}: ${text}.`,
  );

  const ran = new Set(
    builds.flatMap((b) => b.stages.filter((s) => s.status !== 'NOT_EXECUTED').map((s) => s.name)),
  );
  const unseen = jenkinsfileStages(files.text(JENKINSFILE)).filter((name) => !ran.has(name));
  const consoles = builds.every((b) => files.has(`${JENKINS_DIR}/build-${b.build}-console.txt`));

  const lines = [
    table,
    '',
    `${plural(builds.length, 'build')} are committed in ${link(JENKINS_DIR, JENKINS_DIR)}${consoles ? ', each with a console excerpt (`build-<n>-console.txt`)' : ''}. Durations are wall-clock seconds on the local docker-compose Jenkins: what the pipeline needs there, and nothing about a hosted service. ${
      unseen.length === 0
        ? `Every stage of the ${link('Jenkinsfile', JENKINSFILE)} ran in at least one committed build.`
        : `Stages of the ${link('Jenkinsfile', JENKINSFILE)} that no committed build ran: ${listOf(unseen.map(code))}.`
    }`,
    '',
    ...environment,
  ];
  return data(lines.join('\n'));
}
