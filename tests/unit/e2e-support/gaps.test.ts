import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAVOUR_IDS } from '../../../src/lab/probe/formats.ts';
import { ResultFileError, serializeResultFile } from '../../../src/lab/probe/report.ts';
import type { CaseResult } from '../../../src/lab/probe/results.ts';
import {
  EXPERIMENTAL_LINUX_WEBKIT,
  MATRIX_DIR,
  RUN_SPECS_IN_LINUX_WEBKIT,
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

// The committed setting of the Linux WebKit override is `true`; every test below that is about the evidence says `false` (or `true`)
// out loud, so that none of them depends on what is committed.
const env = (evidence: typeof linuxEvidence | null, engine: string, extra: object = {}): Environment =>
  resolveEnvironment({
    envId: evidence?.envId ?? 'fixture-new-runner',
    engine,
    evidence,
    runInLinuxWebKit: false,
    ...extra,
  });

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

describe('the Linux WebKit override, in both of its settings', () => {
  const linuxWebkit = (setting: boolean, evidence: typeof linuxEvidence | null = linuxEvidence) =>
    env(evidence, 'webkit', { platform: 'linux', runInLinuxWebKit: setting });

  it('false: Linux WebKit is a gap exactly where the committed evidence says it cannot play, and is not experimental', () => {
    const off = linuxWebkit(false);
    expect(off.experimental).toBeNull();
    expect(off.capabilities).not.toBeNull();
    expect(engineGap(off)).toMatch(
      /^documented gap in fixture-linux-arm64: no vod stream plays over dash in webkit 3\.0/,
    );
    expect(chooseStream(off, 'vod', 'dash')).toMatchObject({
      gap: expect.stringContaining('intermittent 2/5'),
    });
    expect(
      engineGap(linuxWebkit(false, resultFile('fixture-ok-linux', { webkit: probedEngine() }))),
    ).toBeNull();
  });

  it('true: the specs run in Linux WebKit whatever the evidence says, and the engine is marked experimental', () => {
    const on = linuxWebkit(true);
    expect(on.capabilities).toBeNull();
    expect(on.experimental).toContain(
      'Linux WebKit runs the specs although the codec probe is intermittent there',
    );
    expect(on.experimental).toContain('100 of 100');
    expect(on.basis).toContain('RUN_SPECS_IN_LINUX_WEBKIT');
    expect(engineGap(on)).toBeNull();
    expect(gapForStream(on, 'vod-webm')).toBeNull();
    expect(chooseStream(on, 'vod', 'hls')).toStrictEqual({ stream: 'vod-cmaf' });
  });

  it('true: also without evidence for the environment or for the engine, because the annotation follows the engine and not the file', () => {
    expect(linuxWebkit(true, null).experimental).not.toBeNull();
    expect(
      linuxWebkit(true, resultFile('fixture-no-webkit', { chromium: probedEngine() })).experimental,
    ).not.toBeNull();
    expect(linuxWebkit(false, null).experimental).toBeNull();
  });

  it.each([true, false])(
    'touches nothing else when it is %s: not WebKit elsewhere, not another engine on Linux',
    (setting) => {
      const flaky = resultFile('fixture-elsewhere', {
        chromium: probedEngine({ cases: everyFlavour(() => verdict(0, 5, true)) }),
        firefox: probedEngine({ cases: everyFlavour(() => verdict(0, 5, true)) }),
        webkit: probedEngine({ cases: everyFlavour(() => verdict(0, 5, true)) }),
      });
      const mac = env(flaky, 'webkit', { platform: 'darwin', runInLinuxWebKit: setting });
      expect(engineGap(mac)).not.toBeNull();
      expect(mac.experimental).toBeNull();
      for (const engine of ['chromium', 'firefox']) {
        const other = env(flaky, engine, { platform: 'linux', runInLinuxWebKit: setting });
        expect(engineGap(other)).not.toBeNull();
        expect(other.experimental).toBeNull();
      }
    },
  );

  it('is on in the repository: the committed setting enables Linux WebKit as an experimental engine', () => {
    expect(RUN_SPECS_IN_LINUX_WEBKIT).toBe(true);
    const committed = resolveEnvironment({
      envId: 'fixture-linux-arm64',
      engine: 'webkit',
      platform: 'linux',
      evidence: linuxEvidence,
    });
    expect(committed.experimental).toBe(EXPERIMENTAL_LINUX_WEBKIT);
    expect(engineGap(committed)).toBeNull();
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

  it('in an experimental engine: a failure of the experiment, which is not an environment change and says how to go back', () => {
    const text = explainUndocumentedGap(
      env(linuxEvidence, 'webkit', { platform: 'linux', runInLinuxWebKit: true }),
      gap,
    );
    expect(text).toContain(
      'webkit is an experimental engine in fixture-linux-arm64: Linux WebKit runs the specs',
    );
    expect(text).toContain('a failure of the experiment, not a change of the environment');
    expect(text).toContain(
      'RUN_SPECS_IN_LINUX_WEBKIT in src/lab/gaps.ts goes back to the committed matrix when it is false',
    );
    expect(text).not.toContain('do not retry the specs');
    expect(text).not.toContain('npm run codec-matrix');
  });
});

describe('the committed evidence of this repository', () => {
  const real = (envId: string, engine: string, platform: string, runInLinuxWebKit: boolean): Environment =>
    resolveEnvironment({
      envId,
      engine,
      platform,
      evidence: readEvidence(envId, MATRIX_DIR),
      runInLinuxWebKit,
    });
  const ENVIRONMENTS = [
    ['docker-linux-arm64', 'linux'],
    ['gha-linux-x64', 'linux'],
    ['local-darwin-arm64', 'darwin'],
    ['gha-macos-arm64', 'darwin'],
  ] as const;
  const gapsOf = (runInLinuxWebKit: boolean): string[] =>
    ENVIRONMENTS.flatMap(([envId, platform]) =>
      (['chromium', 'firefox', 'webkit'] as const)
        .filter((engine) => engineGap(real(envId, engine, platform, runInLinuxWebKit)) !== null)
        .map((engine) => `${envId}/${engine}`),
    );

  it('documents the gaps of docs/CONTRACTS.md section 2 when the override is false: Linux WebKit, and Firefox on the macOS host', () => {
    expect(gapsOf(false)).toStrictEqual([
      'docker-linux-arm64/webkit',
      'gha-linux-x64/webkit',
      'local-darwin-arm64/firefox',
    ]);
  });

  it('documents only Firefox on the macOS host when the override is true, which is how it is committed', () => {
    expect(gapsOf(true)).toStrictEqual(['local-darwin-arm64/firefox']);
  });

  it('marks as experimental exactly Linux WebKit, in both Linux environments, when the override is true', () => {
    const experimental = ENVIRONMENTS.flatMap(([envId, platform]) =>
      (['chromium', 'firefox', 'webkit'] as const)
        .filter((engine) => real(envId, engine, platform, true).experimental !== null)
        .map((engine) => `${envId}/${engine}`),
    );
    expect(experimental).toStrictEqual(['docker-linux-arm64/webkit', 'gha-linux-x64/webkit']);
    expect(
      ENVIRONMENTS.flatMap(([envId, platform]) =>
        (['chromium', 'firefox', 'webkit'] as const).filter(
          (engine) => real(envId, engine, platform, false).experimental !== null,
        ),
      ),
    ).toStrictEqual([]);
  });

  it('gives the reasons the skips will print', () => {
    expect(engineGap(real('docker-linux-arm64', 'webkit', 'linux', false))).toMatch(
      /^documented gap in docker-linux-arm64: no vod stream plays over dash in webkit .*cmaf-vp9-aac (intermittent|fail) \d\/5/,
    );
    // Linux WebKit is intermittent on the probe's page: a re-run of the same environment can say 2 of 5 or 0 of 5 for the same case.
    expect(engineGap(real('gha-linux-x64', 'webkit', 'linux', false))).toMatch(
      /^documented gap in gha-linux-x64: no vod stream plays over dash in webkit .*cmaf-vp9-aac (intermittent|fail) \d\/5/,
    );
    expect(engineGap(real('local-darwin-arm64', 'firefox', 'darwin', true))).toContain(
      'Could not find profile folder',
    );
  });

  it('plays every lab stream in macOS WebKit, Chromium and Firefox where the matrix says so, and picks the CMAF stream', () => {
    for (const [envId, engine, platform] of [
      ['local-darwin-arm64', 'webkit', 'darwin'],
      ['local-darwin-arm64', 'chromium', 'darwin'],
      ['gha-macos-arm64', 'firefox', 'darwin'],
      ['docker-linux-arm64', 'firefox', 'linux'],
    ] as const) {
      const environment = real(envId, engine, platform, true);
      expect(chooseStream(environment, 'vod', 'dash')).toStrictEqual({ stream: 'vod-cmaf' });
      expect(chooseStream(environment, 'vod', 'hls')).toStrictEqual({ stream: 'vod-cmaf' });
      expect(chooseStream(environment, 'live', 'dash')).toStrictEqual({ stream: 'live-cmaf' });
      expect(gapForStream(environment, 'vod-cmaf-short')).toBeNull();
    }
  });
});
