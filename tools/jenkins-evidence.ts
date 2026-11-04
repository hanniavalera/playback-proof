// `npx tsx tools/jenkins-evidence.ts [--trigger] [--build N] [--expect SUCCESS|FAILURE] [--label TEXT]`
//
// Collects the evidence of a build of the merge-gate pipeline from the Jenkins REST API (docs/decisions/ci-jenkins.md, jenkins/README.md):
// waits for the controller and the agent, optionally starts a build and waits for it to finish, then writes
//
//   docs/results/jenkins/build-<n>.json          the result, the stages with their durations, the versions, the tests, the failure
//   docs/results/jenkins/build-<n>-console.txt   the console log cut down to the stage markers and the summaries of each gate
//
// Nothing secret is written: the admin credentials come from the environment or from .env, are only ever sent to the controller as an
// authorization header, and the console log is redacted before it is excerpted (and the output is checked once more before it is
// written). Exit code: 0 when the build ended as --expect said (default SUCCESS), 1 when it did not, 2 on a usage or connection error.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildEvidence,
  excerptConsole,
  groupStages,
  parseSkippedStages,
  parseToolVersions,
  redact,
  stringifyEvidence,
  summarizePlaywright,
} from './lib/jenkins-evidence.ts';
import type { ProjectSummary, RawStage, StageSteps } from './lib/jenkins-evidence.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const USAGE = `usage: npx tsx tools/jenkins-evidence.ts [options]

  --url <url>           the controller (default http://127.0.0.1:4700)
  --job <name>          the pipeline job (default playback-proof)
  --trigger             start a new build, wait for it to finish, then collect
  --build <n>           collect build n (default: the last build); waits when it is still running
  --expect <result>     the result the run is meant to show: SUCCESS (default) or FAILURE. The exit code is 0 when it matches.
  --label <text>        one line that says what this run is for (recorded in the evidence)
  --out <dir>           where the files go (default docs/results/jenkins)
  --env-file <file>     where JENKINS_ADMIN_ID and JENKINS_ADMIN_PASSWORD are read when they are not in the environment (default .env)
  --timeout-min <n>     how long to wait for the controller, the agent and the build (default 45)
  --dry-run             print what would be written instead of writing it
  --help`;

function fail(message: string, code = 2): never {
  console.error(`jenkins-evidence: ${message}`);
  process.exit(code);
}

const log = (line: string): void => console.log(`[jenkins-evidence] ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

class Jenkins {
  version: string | null = null;
  private cookie = '';
  private crumb: { field: string; value: string } | null = null;
  private readonly authorization: string;

  constructor(
    private readonly base: string,
    user: string,
    password: string,
  ) {
    this.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: this.authorization };
    if (this.cookie) headers.cookie = this.cookie;
    Object.assign(headers, init.headers);
    const response = await fetch(new URL(path, this.base), {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    this.version = response.headers.get('x-jenkins') ?? this.version;
    const set = response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
    if (set.length > 0) this.cookie = set.join('; ');
    return response;
  }

  async text(path: string): Promise<string> {
    const response = await this.request(path);
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response.text();
  }

  async json<T>(path: string): Promise<T> {
    return JSON.parse(await this.text(path)) as T;
  }

  /** The body of a path that may not exist (an artifact the build did not make): null on a 404. */
  async textOrNull(path: string): Promise<string | null> {
    const response = await this.request(path);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response.text();
  }

  async post(path: string): Promise<Response> {
    if (!this.crumb) {
      const issued = await this.json<{ crumbRequestField: string; crumb: string }>('/crumbIssuer/api/json');
      this.crumb = { field: issued.crumbRequestField, value: issued.crumb };
    }
    return this.request(path, { method: 'POST', headers: { [this.crumb.field]: this.crumb.value } });
  }
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const ok = await probe().catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    if (!announced) log(`waiting for ${what}`);
    announced = true;
    await sleep(everyMs);
  }
}

interface RunInfo {
  number: number;
  result: string | null;
  building: boolean;
  duration: number;
  timestamp: number;
  actions: { lastBuiltRevision?: { SHA1?: string; branch?: { name?: string }[] } }[];
  artifacts: { relativePath: string }[];
}
interface Describe {
  status: string;
  startTimeMillis: number;
  endTimeMillis?: number;
  durationMillis: number;
  queueDurationMillis?: number;
  stages: RawStage[];
}

const RUN_TREE =
  'number,result,building,duration,timestamp,actions[lastBuiltRevision[SHA1,branch[name]]],artifacts[relativePath]';

async function startBuild(jenkins: Jenkins, job: string, timeoutMs: number): Promise<number> {
  const started = await jenkins.post(`/job/${job}/build`);
  if (started.status !== 201) fail(`starting the build answered ${started.status}`);
  const queue = new URL(started.headers.get('location') ?? '', 'http://x').pathname;
  let number = 0;
  await waitFor(
    'the build to leave the queue',
    async () => {
      const item = await jenkins.json<{ cancelled?: boolean; executable?: { number: number } }>(
        `${queue}api/json`,
      );
      if (item.cancelled) fail('the build was cancelled in the queue');
      number = item.executable?.number ?? 0;
      return number > 0;
    },
    timeoutMs,
    2000,
  );
  log(`started build ${number}`);
  return number;
}

async function waitForBuild(jenkins: Jenkins, job: string, build: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let shown = '';
  for (;;) {
    const run = await jenkins.json<{ building: boolean }>(`/job/${job}/${build}/api/json?tree=building`);
    const describe = await jenkins.json<Describe>(`/job/${job}/${build}/wfapi/describe`).catch(() => null);
    const line = (describe?.stages ?? []).map((s) => `${s.name}:${s.status}`).join(' ');
    if (line !== shown) log(`build ${build}: ${line || 'starting'}`);
    shown = line;
    if (!run.building) return;
    if (Date.now() > deadline) fail(`build ${build} did not finish in time`);
    await sleep(5000);
  }
}

async function collect(
  jenkins: Jenkins,
  job: string,
  build: number,
  expected: 'SUCCESS' | 'FAILURE',
  label: string,
  secrets: string[],
) {
  const base = `/job/${job}/${build}`;
  const run = await jenkins.json<RunInfo>(`${base}/api/json?tree=${RUN_TREE}`);
  const describe = await jenkins.json<Describe>(`${base}/wfapi/describe`);

  const steps = new Map<string, StageSteps>();
  for (const stage of describe.stages) {
    const node = await jenkins.json<{ stageFlowNodes?: { startTimeMillis: number }[] }>(
      `${base}/execution/node/${stage.id}/wfapi/describe`,
    );
    const flow = node.stageFlowNodes ?? [];
    steps.set(stage.id, {
      stepCount: flow.length,
      firstStepStartMillis: flow.length > 0 ? Math.min(...flow.map((n) => n.startTimeMillis)) : null,
    });
  }

  const consoleText = redact(await jenkins.text(`${base}/consoleText`), secrets);
  const excerpt = excerptConsole(consoleText);

  const plugins = Object.fromEntries(
    (
      await jenkins.json<{ plugins: { shortName: string; version: string }[] }>(
        '/pluginManager/api/json?depth=1&tree=plugins[shortName,version]',
      )
    ).plugins.map((p) => [p.shortName, p.version]),
  );
  const computers = await jenkins.json<{
    computer: { displayName: string; numExecutors: number; assignedLabels: { name: string }[] }[];
  }>('/computer/api/json?tree=computer[displayName,numExecutors,assignedLabels[name]]');
  const controller = await jenkins.json<{ numExecutors: number }>('/api/json?tree=numExecutors');

  const artifacts = run.artifacts.map((a) => a.relativePath);
  const playwright: ProjectSummary[] = [];
  for (const path of artifacts.filter((p) => /^reports\/[^/]+\/playwright\.json$/.test(p))) {
    const body = await jenkins.textOrNull(`${base}/artifact/${path}`);
    if (body !== null) playwright.push(...summarizePlaywright(JSON.parse(body)));
  }

  const revision = run.actions.find((a) => a.lastBuiltRevision)?.lastBuiltRevision;
  const branch = revision?.branch?.[0]?.name?.replace(/^refs\/remotes\/origin\//, '') ?? null;
  const evidence = buildEvidence({
    job,
    build,
    label,
    expected,
    result: run.result ?? 'UNKNOWN',
    startedAtMs: run.timestamp,
    durationMs: run.duration,
    queuedMs: describe.queueDurationMillis ?? 0,
    commit: revision?.SHA1 ?? null,
    branch,
    jenkinsVersion: jenkins.version,
    controllerExecutors: controller.numExecutors,
    plugins,
    agents: computers.computer
      .filter((c) => c.displayName !== 'Built-In Node')
      .map((c) => ({
        name: c.displayName,
        executors: c.numExecutors,
        labels: c.assignedLabels.map((l) => l.name),
      })),
    tools: parseToolVersions(consoleText),
    stages: groupStages(describe.stages, steps, describe.startTimeMillis, parseSkippedStages(consoleText)),
    playwright,
    artifacts,
  });
  return { evidence, excerpt };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:4700' },
      job: { type: 'string', default: 'playback-proof' },
      trigger: { type: 'boolean', default: false },
      build: { type: 'string' },
      expect: { type: 'string', default: 'SUCCESS' },
      label: { type: 'string', default: '' },
      out: { type: 'string', default: 'docs/results/jenkins' },
      'env-file': { type: 'string', default: '.env' },
      'timeout-min': { type: 'string', default: '45' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.expect !== 'SUCCESS' && values.expect !== 'FAILURE')
    fail(`--expect is SUCCESS or FAILURE, got '${values.expect}'`);
  const expected = values.expect;
  const timeoutMs = Number(values['timeout-min']) * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('--timeout-min must be a positive number');

  const file = readEnvFile(resolve(ROOT, values['env-file']));
  const user = process.env.JENKINS_ADMIN_ID ?? file.JENKINS_ADMIN_ID ?? 'admin';
  const password = process.env.JENKINS_ADMIN_PASSWORD ?? file.JENKINS_ADMIN_PASSWORD ?? '';
  if (password.length < 8)
    fail('JENKINS_ADMIN_PASSWORD is missing or shorter than 8 characters (run bash jenkins/init-env.sh)');

  const jenkins = new Jenkins(values.url, user, password);
  const job = values.job;
  await waitFor('the controller', async () => (await jenkins.request('/login')).status === 200, timeoutMs);
  await waitFor(
    'an agent to be online',
    async () => {
      const all = await jenkins.json<{ computer: { displayName: string; offline: boolean }[] }>(
        '/computer/api/json?tree=computer[displayName,offline]',
      );
      return all.computer.some((c) => c.displayName !== 'Built-In Node' && !c.offline);
    },
    timeoutMs,
  );

  let build: number;
  if (values.trigger) build = await startBuild(jenkins, job, timeoutMs);
  else if (values.build !== undefined) build = Number(values.build);
  else
    build =
      (
        await jenkins.json<{ lastBuild: { number: number } | null }>(
          `/job/${job}/api/json?tree=lastBuild[number]`,
        )
      ).lastBuild?.number ?? 0;
  if (!Number.isInteger(build) || build < 1) fail('there is no build to collect');
  await waitForBuild(jenkins, job, build, timeoutMs);

  const { evidence, excerpt } = await collect(jenkins, job, build, expected, values.label, [password]);
  const json = stringifyEvidence(evidence);
  const header = `Console log of build ${build} of ${job}, cut down to the stage markers, the tool versions and the summary of each gate.\nThe full log stays in Jenkins; ${excerpt.omitted} lines of progress output were left out. Credentials are redacted. Times are UTC.\n\n`;
  const text = header + excerpt.text;
  for (const [name, content] of [
    ['json', json],
    ['console', text],
  ] as const) {
    if (content.includes(password))
      fail(`the ${name} output contains the admin password: nothing was written`);
  }

  const out = resolve(ROOT, values.out);
  const jsonPath = join(out, `build-${build}.json`);
  const textPath = join(out, `build-${build}-console.txt`);
  if (values['dry-run']) {
    console.log(json);
    log(`dry run: would write ${jsonPath} and ${textPath}`);
  } else {
    mkdirSync(out, { recursive: true });
    writeFileSync(jsonPath, json);
    writeFileSync(textPath, text);
    log(`wrote ${jsonPath} and ${textPath}`);
  }
  log(`build ${build}: ${evidence.result} (expected ${expected})`);
  process.exit(evidence.asExpected ? 0 : 1);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
