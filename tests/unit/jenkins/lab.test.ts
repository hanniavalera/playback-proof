import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The merge gate in Jenkins is only worth what its files say, and the files are read by nobody until a build goes wrong. These tests
// keep the properties that docs/decisions/ci-jenkins.md and jenkins/README.md state from drifting away from the files: the
// Jenkinsfile runs scripts and projects that exist, the agent image is the one the Playwright pin needs, the stack stays inside its
// ports and keeps no credential, and the plugins are pinned. They read text; no Docker, no Jenkins.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const jenkinsfile = read('Jenkinsfile');
const compose = read('docker-compose.yml');
const casc = read('jenkins/controller/casc.yaml');
const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The non-empty, non-comment lines of a file. */
const significant = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe('the Jenkinsfile', () => {
  const shLines = [...jenkinsfile.matchAll(/^\s*sh '([^']+)'/gm)].map((m) => m[1] ?? '');

  it('runs only scripts that package.json has, and the gates are the ones the strategy names', () => {
    const scripts = shLines.flatMap((line) =>
      [...line.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1] ?? ''),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(packageJson.scripts, `npm run ${script}`).toHaveProperty([script]);
    expect(scripts).toEqual(
      expect.arrayContaining(['gate:static', 'gate:unit', 'generate:streams', 'gate:merge']),
    );
  });

  it('runs the merge gate once per Playwright project, each project of the config being one that exists', () => {
    const config = read('playwright.config.ts');
    const projects = [...jenkinsfile.matchAll(/npm run gate:merge -- --project=([\w-]+)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(projects).toEqual(['chromium', 'firefox', 'chromium-cpu4x', 'webkit']);
    for (const project of projects) expect(config, project).toContain(`name: '${project}'`);
  });

  it('gives every engine of the merge gate its own service port and its own report paths', () => {
    const branches = jenkinsfile
      .split(/^\s*stage\('(chromium|firefox|chromium-cpu4x|webkit)'\) \{/m)
      .slice(1);
    expect(branches.length).toBe(8);
    const ports: string[] = [];
    for (let i = 0; i < branches.length; i += 2) {
      const [name, body] = [branches[i] ?? '', branches[i + 1] ?? ''];
      ports.push(/PB_PORT = '(\d+)'/.exec(body)?.[1] ?? 'missing');
      expect(body, name).toContain(`PLAYWRIGHT_JSON_OUTPUT_FILE = 'reports/${name}/playwright.json'`);
      expect(body, name).toContain(`PLAYWRIGHT_HTML_OUTPUT_DIR = 'reports/${name}/html'`);
      expect(body, name).toContain("agent { label 'playwright' }");
    }
    expect(new Set(ports).size).toBe(4);
    expect(ports).not.toContain('missing');
  });

  it('has the options the setup promises: timestamps, colour, a timeout, no concurrent builds', () => {
    for (const option of ['timestamps()', "ansiColor('xterm')", 'timeout(time:', 'disableConcurrentBuilds()'])
      expect(jenkinsfile, option).toContain(option);
    expect(jenkinsfile).toMatch(/^\s*agent none$/m);
  });

  it('runs no stage that has no script behind it', () => {
    // Later gates (perf, flake, triage) are added with their scripts; a stage for one that cannot run yet would be a stub.
    for (const gate of ['gate:perf', 'gate:flake', 'gate:triage']) {
      const exists = packageJson.scripts[gate] !== undefined;
      expect(jenkinsfile.includes(`npm run ${gate}`) && !exists, gate).toBe(false);
    }
  });
});

describe('the compose project', () => {
  it('publishes only ports of the 4700-4709 range, on the loopback interface', () => {
    const published = [...compose.matchAll(/^\s*-\s*'?(\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):\d+'?\s*$/gm)];
    expect(published.length).toBeGreaterThan(0);
    for (const match of published) {
      expect(match[1], match[0]).toBe('127.0.0.1:');
      expect(Number(match[2])).toBeGreaterThanOrEqual(4700);
      expect(Number(match[2])).toBeLessThanOrEqual(4709);
    }
  });

  it('runs the browsers the way their image asks, with a bounded share of the machine', () => {
    const agent = compose.slice(compose.indexOf('\n  agent:'));
    expect(agent).toMatch(/^\s+init: true$/m);
    expect(agent).toMatch(/^\s+ipc: host$/m);
    expect(agent).toMatch(/^\s+cpus: \d+(\.\d+)?$/m);
    expect(agent).toMatch(/^\s+mem_limit: \S+$/m);
  });

  it('keeps no credential: the password comes from .env, is required, and has no default', () => {
    expect(compose).toContain('${JENKINS_ADMIN_PASSWORD:?');
    expect(compose).not.toMatch(/JENKINS_ADMIN_PASSWORD:-/);
    expect(casc).toMatch(/password: ["']\$\{JENKINS_ADMIN_PASSWORD\}["']/);
    const example = read('.env.example');
    expect(example).toMatch(/^JENKINS_ADMIN_PASSWORD=$/m);
    expect(read('.gitignore')).toMatch(/^\.env$/m);
  });

  it('shares one named volume for the streams, mounted where the Jenkinsfile reads them', () => {
    const cache = /PB_CACHE_DIR = '([^']+)'/.exec(jenkinsfile)?.[1] ?? '';
    expect(cache).toMatch(/^\/cache\//);
    expect(compose).toMatch(/^\s+- streams-cache:\/cache$/m);
    expect(compose).toMatch(/^ {2}streams-cache:$/m);
  });
});

describe('the controller', () => {
  it('has no executors, no TCP agent port, no anonymous access', () => {
    expect(casc).toMatch(/^ {2}numExecutors: 0$/m);
    expect(casc).toMatch(/^ {2}slaveAgentPort: -1$/m);
    expect(casc).toMatch(/allowAnonymousRead: false/);
  });

  it('has a Linux agent labelled the way the Jenkinsfile asks for it, connecting over WebSocket', () => {
    const labels = /labelString: ["']([^"']+)["']/.exec(casc)?.[1] ?? '';
    expect(labels.split(' ')).toContain('playwright');
    expect(casc).toMatch(/webSocket: true/);
  });

  it('is built from a pinned core and pinned plugins, dependencies included', () => {
    const dockerfile = read('jenkins/controller/Dockerfile');
    expect(/^FROM jenkins\/jenkins:(\S+)$/m.exec(dockerfile)?.[1]).toMatch(/^\d+\.\d+\.\d+-lts-jdk\d+$/);
    const plugins = significant(read('jenkins/controller/plugins.txt'));
    expect(plugins.length).toBeGreaterThan(20);
    const names = new Set<string>();
    for (const line of plugins) {
      const [name, version, ...rest] = line.split(':');
      expect(rest, line).toEqual([]);
      expect(name, line).toMatch(/^[a-z0-9-]+$/);
      expect(version, line).toMatch(/^[\w.-]+$/);
      expect(version, line).not.toBe('latest');
      expect(names.has(name ?? ''), `${name} listed twice`).toBe(false);
      names.add(name ?? '');
    }
    // What the job and the Jenkinsfile use must be among them.
    for (const needed of [
      'configuration-as-code',
      'job-dsl',
      'git',
      'pipeline-model-definition',
      'pipeline-stage-view',
      'timestamper',
      'ansicolor',
      'ws-cleanup',
      'junit',
    ])
      expect(names, needed).toContain(needed);
  });
});

describe('the agent image', () => {
  it('is the Playwright image of the version package.json pins, the one tools/docker/pw.sh runs', () => {
    const pinned = packageJson.devDependencies['@playwright/test'];
    const dockerfile = read('jenkins/agent/Dockerfile');
    const tag = /^FROM mcr\.microsoft\.com\/playwright:(\S+)$/m.exec(dockerfile)?.[1] ?? '';
    expect(tag).toBe(`v${pinned}-noble`);
    expect(read('tools/docker/pw.sh')).toContain(`PW_IMAGE="mcr.microsoft.com/playwright:${tag}"`);
    expect(compose).toContain(`image: playback-proof/jenkins-agent:pw${pinned}`);
  });

  it('carries what the pipeline calls: Java for the agent, ffmpeg for the media tests', () => {
    const dockerfile = read('jenkins/agent/Dockerfile');
    expect(dockerfile).toMatch(/openjdk-\d+-jre-headless/);
    expect(dockerfile).toMatch(/\bffmpeg\b/);
    expect(read('jenkins/agent/entrypoint.sh')).toContain('-webSocket');
  });
});
