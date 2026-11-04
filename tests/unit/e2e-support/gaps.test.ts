import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAVOUR_IDS } from '../../../src/lab/probe/formats.ts';
import { ResultFileError, serializeResultFile } from '../../../src/lab/probe/report.ts';
import type { CaseResult } from '../../../src/lab/probe/results.ts';
import {
  MATRIX_DIR,
  chooseStream,
  engineGap,
  explainUndocumentedGap,
  gapForStream,
  readEvidence,
  resolveEnvironment,
  versionDrift,
} from '../../../tests/e2e/support/gaps.ts';
import type { Environment } from '../../../tests/e2e/support/gaps.ts';
import { UNSUPPORTED_FAILURE, probedEngine, resultFile, verdict } from '../probe/fixtures.ts';
import { makeScratch } from '../support/scratch.ts';

// Gap resolution is the part of the e2e support that decides which tests do not run, so it is tested with invented
// environments (their ids start with "fixture-": none of this is a measurement) and, once, against the committed evidence.

const everyFlavour = (make: () => CaseResult): Record<string, CaseResult> =>
  Object.fromEntries(FLAVOUR_IDS.map((id) => [id, make()]));

const FIREFOX_LAUNCH_FAILURE =
  'browserType.launch: Failed to launch the browser process.\nBrowser logs:\n\n<launching> /fixture/firefox -headless\n[pid=1][err] *** You are running in headless mode.\n[pid=1][err] Could not find profile folder.\n[pid=1] <process did exit: exitCode=1, signal=null>\nCall log:\n  - <launching> /fixture/firefox\n  - [pid=1][err] Could not find profile folder.';

/** Linux-like: WebKit is intermittent in every flavour, the other engines are fine. */
const linuxEvidence = resultFile('fixture-linux-arm64', {
  chromium: probedEngine({ version: '100.0' }),
  firefox: probedEngine({ version: '200.0' }),
  webkit: probedEngine({ version: '3.0', cases: everyFlavour(() => verdict(2, 5, true)) }),
});

/** Mac-like: Firefox does not start, WebKit plays the CMAF flavour with AAC but not the one with Opus. */
const macEvidence = resultFile('fixture-mac-arm64', {
  chromium: probedEngine({ version: '100.0' }),
  firefox: { launchFailed: FIREFOX_LAUNCH_FAILURE },
  webkit: probedEngine({
    version: '3.0',
    cases: { 'cmaf-vp9-opus': verdict(0, 5, false, UNSUPPORTED_FAILURE) },
  }),
});

const env = (evidence: typeof linuxEvidence | null, engine: string, extra: object = {}): Environment =>
  resolveEnvironment({ envId: evidence?.envId ?? 'fixture-new-runner', engine, evidence, ...extra });

describe('readEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeScratch('e2e-gaps-');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for an environment without a committed result: a new runner documents nothing', () => {
    expect(readEvidence('fixture-new-runner', dir)).toBeNull();
  });

  it('reads and validates the file named after the environment', () => {
    writeFileSync(join(dir, 'fixture-linux-arm64.json'), serializeResultFile(linuxEvidence));
    expect(readEvidence('fixture-linux-arm64', dir)?.envId).toBe('fixture-linux-arm64');
  });

  it('throws on a file that does not validate: a broken record must not read as "no gap"', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fixture-broken.json'), '{ "schemaVersion": 1 ');
    expect(() => readEvidence('fixture-broken', dir)).toThrow(ResultFileError);
    const stale = { ...linuxEvidence, schemaVersion: 2 };
    writeFileSync(join(dir, 'fixture-stale.json'), JSON.stringify(stale));
    expect(() => readEvidence('fixture-stale', dir)).toThrow(/schemaVersion/);
  });
});

describe('without evidence nothing is documented, so nothing is skipped', () => {
  it.each([
    [
      'an environment without a result file',
      null,
      'webkit',
      /no committed probe result for fixture-new-runner/,
    ],
    [
      'an engine the result file did not probe',
      resultFile('fixture-x', { chromium: probedEngine() }),
      'webkit',
      /has no result for webkit/,
    ],
  ])('%s', (_label, evidence, engine, basis) => {
    const environment = env(evidence, engine);
    expect(environment.capabilities).toBeNull();
    expect(environment.basis).toMatch(basis);
    expect(engineGap(environment)).toBeNull();
    expect(gapForStream(environment, 'vod-webm')).toBeNull();
    expect(chooseStream(environment, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
    expect(chooseStream(environment, 'vod', 'hls')).toStrictEqual({ stream: 'vod-cmaf' });
    expect(chooseStream(environment, 'live', 'hls')).toStrictEqual({ stream: 'live-cmaf' });
  });
});

describe('an engine that plays', () => {
  it('has no gap and gets the primary stream', () => {
    const chromium = env(linuxEvidence, 'chromium');
    expect(engineGap(chromium)).toBeNull();
    expect(chooseStream(chromium, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
    expect(chooseStream(chromium, 'live', 'dash')).toStrictEqual({ stream: 'live-cmaf' });
    expect(gapForStream(chromium, 'vod-webm')).toBeNull();
    expect(gapForStream(chromium, 'vod-cmaf-short')).toBeNull();
  });
});

describe('a gap that comes from the evidence', () => {
  it('skips every spec in an engine where no flavour decoded in every attempt, with the evidence as the reason', () => {
    const webkit = env(linuxEvidence, 'webkit', { platform: 'linux' });
    const reason = engineGap(webkit);
    expect(reason).toMatch(/^documented gap in fixture-linux-arm64: /);
    expect(reason).toContain('no vod stream plays over dash in webkit 3.0');
    expect(reason).toContain('cmaf-vp9-aac intermittent 2/5');
    expect(reason).toContain('webm-vp9-opus intermittent 2/5');
    expect(reason).toContain('docs/CODEC_MATRIX.md');
    expect(chooseStream(webkit, 'vod', 'dash')).toMatchObject({
      gap: expect.stringContaining('intermittent 2/5'),
    });
  });

  it("says why an engine does not start, in the browser's own words", () => {
    const firefox = env(macEvidence, 'firefox', { platform: 'darwin' });
    const reason = engineGap(firefox);
    expect(reason).toContain('documented gap in fixture-mac-arm64: firefox does not start here');
    expect(reason).toContain('Failed to launch the browser process: Could not find profile folder.');
    expect(reason).not.toContain('headless');
    expect(reason).not.toContain('[pid=');
  });

  it('treats the same engine differently in another environment: the evidence is per environment', () => {
    const evidence = resultFile('fixture-other-linux', { webkit: probedEngine({ version: '4.0' }) });
    expect(engineGap(env(evidence, 'webkit', { platform: 'linux' }))).toBeNull();
    expect(engineGap(env(linuxEvidence, 'webkit', { platform: 'linux' }))).not.toBeNull();
  });
});

describe('a gap in one stream while others play', () => {
  const mac = env(macEvidence, 'webkit', { platform: 'darwin' });

  it('is not an engine gap', () => {
    expect(engineGap(mac)).toBeNull();
    expect(chooseStream(mac, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
  });

  it('names the stream, its flavour and the verdict when a spec insists on that stream', () => {
    const webmBroken = env(
      resultFile('fixture-webm', {
        chromium: probedEngine({ cases: { 'webm-vp9-opus': verdict(0, 5, true) } }),
      }),
      'chromium',
    );
    const reason = gapForStream(webmBroken, 'vod-webm');
    expect(reason).toMatch(
      /^documented gap in fixture-webm: vod-webm is made of webm-vp9-opus, which does not play in chromium 1\.0: webm-vp9-opus fail 0\/5/,
    );
    expect(gapForStream(webmBroken, 'vod-cmaf')).toBeNull();
    expect(chooseStream(webmBroken, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
  });

  it('falls back to the open-codec stream for DASH when the primary flavour fails, and has none for HLS', () => {
    const cmafBroken = env(
      resultFile('fixture-cmaf', {
        webkit: probedEngine({ cases: { 'cmaf-vp9-aac': verdict(0, 5, true) } }),
      }),
      'webkit',
    );
    expect(engineGap(cmafBroken)).toBeNull();
    expect(chooseStream(cmafBroken, 'vod', 'dash')).toStrictEqual({ stream: 'vod-webm' });
    expect(chooseStream(cmafBroken, 'vod', 'hls')).toMatchObject({
      gap: expect.stringContaining('no vod stream plays over hls'),
    });
    expect(chooseStream(cmafBroken, 'live', 'dash')).toMatchObject({
      gap: expect.stringContaining('documented gap in fixture-cmaf'),
    });
    expect(gapForStream(cmafBroken, 'live-cmaf')).toContain('live-cmaf is made of cmaf-vp9-aac');
  });

  it('counts an intermittent flavour as a gap: a gate can only rely on what decoded every time', () => {
    const flaky = env(
      resultFile('fixture-flaky', {
        webkit: probedEngine({ cases: { 'webm-vp9-opus': verdict(4, 5, true) } }),
      }),
      'webkit',
    );
    expect(gapForStream(flaky, 'vod-webm')).toContain('webm-vp9-opus intermittent 4/5');
  });
});

describe('the Linux WebKit override', () => {
  it('lets the specs run in Linux WebKit whatever the evidence says', () => {
    const forced = env(linuxEvidence, 'webkit', { platform: 'linux', runInLinuxWebKit: true });
    expect(forced.capabilities).toBeNull();
    expect(forced.basis).toContain('RUN_SPECS_IN_LINUX_WEBKIT');
    expect(engineGap(forced)).toBeNull();
  });

  it('touches nothing else: not WebKit elsewhere, not another engine on Linux', () => {
    const flaky = resultFile('fixture-elsewhere', {
      chromium: probedEngine({ cases: everyFlavour(() => verdict(0, 5, true)) }),
      webkit: probedEngine({ cases: everyFlavour(() => verdict(0, 5, true)) }),
    });
    expect(engineGap(env(flaky, 'webkit', { platform: 'darwin', runInLinuxWebKit: true }))).not.toBeNull();
    expect(engineGap(env(flaky, 'chromium', { platform: 'linux', runInLinuxWebKit: true }))).not.toBeNull();
  });

  it('is off in the repository: the committed default is "by evidence"', async () => {
    const { RUN_SPECS_IN_LINUX_WEBKIT } = await import('../../../tests/e2e/support/gaps.ts');
    expect(RUN_SPECS_IN_LINUX_WEBKIT).toBe(false);
  });
});

describe('versionDrift', () => {
  const chromium = env(linuxEvidence, 'chromium');
  it('is silent when the engine is the one the matrix was probed on, and when nothing was probed', () => {
    expect(versionDrift(chromium, '100.0')).toBeNull();
    expect(versionDrift(env(null, 'chromium'), '100.0')).toBeNull();
  });
  it('says what to do when the engine changed', () => {
    expect(versionDrift(chromium, '101.2')).toBe(
      'chromium is 101.2 here, the committed matrix of fixture-linux-arm64 was probed on 100.0: re-run npm run codec-matrix and commit the result if the engine changed',
    );
  });
});

describe('explainUndocumentedGap: the failure text of PB-ENV-001', () => {
  const gap = {
    stream: 'vod-cmaf',
    protocol: 'dash',
    actualVersion: '101.2',
    userAgent: 'Fixture/101.2',
    cause: 'qa.waitFor(firstframe) timed out',
  } as const;

  it('against evidence that claims the engine plays: an environment failure, with the claim, the drift and what to do', () => {
    const text = explainUndocumentedGap(env(linuxEvidence, 'chromium'), gap);
    expect(text).toContain(
      'chromium 101.2 in fixture-linux-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it.',
    );
    expect(text).toContain('What the player said: qa.waitFor(firstframe) timed out');
    expect(text).toContain('User agent: Fixture/101.2');
    expect(text).toContain('claims it plays: cmaf-vp9-aac ok 5/5');
    expect(text).toContain('environment failure, not a playback regression');
    expect(text).toContain('was probed on 100.0');
  });

  it('without evidence: says that nothing is documented and how to document it', () => {
    const text = explainUndocumentedGap(env(null, 'webkit'), gap);
    expect(text).toContain('Committed evidence: no committed probe result for fixture-new-runner');
    expect(text).toContain('npm run codec-matrix');
    expect(text).toContain('docs/results/codec-matrix/fixture-new-runner.json');
    expect(text).not.toContain('claims it plays');
  });
});

describe('the committed evidence of this repository', () => {
  const real = (envId: string, engine: string, platform: string): Environment =>
    resolveEnvironment({ envId, engine, platform, evidence: readEvidence(envId, MATRIX_DIR) });

  it('documents exactly the gaps of docs/CONTRACTS.md section 2: Linux WebKit, and Firefox on the macOS host', () => {
    const gaps = (['docker-linux-arm64', 'local-darwin-arm64'] as const).flatMap((envId) =>
      (['chromium', 'firefox', 'webkit'] as const).map((engine) => {
        const platform = envId.includes('linux') ? 'linux' : 'darwin';
        return [envId, engine, engineGap(real(envId, engine, platform)) !== null] as const;
      }),
    );
    expect(gaps.filter(([, , gap]) => gap).map(([envId, engine]) => `${envId}/${engine}`)).toStrictEqual([
      'docker-linux-arm64/webkit',
      'local-darwin-arm64/firefox',
    ]);
  });

  it('gives the reasons the skips will print', () => {
    expect(engineGap(real('docker-linux-arm64', 'webkit', 'linux'))).toMatch(
      /^documented gap in docker-linux-arm64: no vod stream plays over dash in webkit .*cmaf-vp9-aac intermittent \d\/5/,
    );
    expect(engineGap(real('local-darwin-arm64', 'firefox', 'darwin'))).toContain(
      'Could not find profile folder',
    );
  });

  it('plays every lab stream in macOS WebKit and Chromium, and picks the CMAF stream', () => {
    for (const [envId, engine, platform] of [
      ['local-darwin-arm64', 'webkit', 'darwin'],
      ['local-darwin-arm64', 'chromium', 'darwin'],
      ['docker-linux-arm64', 'firefox', 'linux'],
    ] as const) {
      const environment = real(envId, engine, platform);
      expect(chooseStream(environment, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
      expect(chooseStream(environment, 'vod', 'hls')).toStrictEqual({ stream: 'vod-cmaf' });
      expect(chooseStream(environment, 'live', 'dash')).toStrictEqual({ stream: 'live-cmaf' });
      expect(gapForStream(environment, 'vod-cmaf-short')).toBeNull();
    }
  });
});
