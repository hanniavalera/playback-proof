import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeUnmeasured,
  measurableCeilingKbps,
  measurableLatencyMs,
  smallestVideoSegmentBytes,
  unmeasuredWindows,
} from '../../../ab/conditions.ts';
import {
  PreregistrationError,
  canonicalJson,
  loadPreregistration,
  parsePreregistration,
  sha256Hex,
  validatePreregistration,
} from '../../../ab/prereg.ts';
import { PROFILE_NAMES, profile } from '../../../src/shared/profiles.ts';
import { mentionedSettings, settingNames } from '../../../ab/settings.ts';
import { AA_SOURCE, aaPrereg, rebufferPrereg, startupPrereg } from './fixtures.ts';
import type { Json } from './fixtures.ts';

// The pre-registration: what makes a plan valid, every way it can be invalid, and the hash that proves it was fixed first.

function problemsOf(raw: unknown): string[] {
  const result = validatePreregistration(raw);
  return result.ok ? [] : result.problems;
}

/** The valid plan with one thing changed, by a function over a fresh copy. */
function changed(edit: (plan: Json) => void, base: () => Json = startupPrereg): unknown {
  const plan = base();
  edit(plan);
  return plan;
}

const metrics = (plan: Json): Json[] => plan.metrics as Json[];
const conditions = (plan: Json): Json[] => plan.conditions as Json[];

describe('PB-AB what makes a condition measurable (ADR-095: Shaka ignores downloads under 5 ms)', () => {
  it('derives the ceiling of a measurable link from the ladder: the smallest segment must last six times the threshold', () => {
    expect(smallestVideoSegmentBytes()).toBe(75_000); // 300 kbps x 2 s
    expect(measurableLatencyMs()).toBe(30);
    expect(measurableCeilingKbps()).toBe(20_000); // 75,000 bytes x 8 in 30 ms: the figure ADR-095 settled on
  });

  it.each([
    ['clean', [{ fromMs: 0, toMs: null }]],
    ['constrained-1500', []],
    ['constrained-600', []],
    ['bandwidth-drop', [{ fromMs: 0, toMs: 8000 }]],
    ['high-latency', []],
  ] as const)('the profile %s leaves these stretches unmeasured: %j', (name, expected) => {
    expect(unmeasuredWindows(profile(name))).toStrictEqual(expected);
  });

  it('only a rule that applies to every media request makes a stretch measurable', () => {
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 20_000 }])).toStrictEqual([]);
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 20_001 }])).toStrictEqual([
      { fromMs: 0, toMs: null },
    ]);
    expect(unmeasuredWindows([{ type: 'latency', ms: 30 }])).toStrictEqual([]);
    expect(unmeasuredWindows([{ type: 'latency', ms: 29 }])).toStrictEqual([{ fromMs: 0, toMs: null }]);
    expect(unmeasuredWindows([{ type: 'latency', ms: 40, jitterMs: 20 }])).toStrictEqual([
      { fromMs: 0, toMs: null },
    ]);
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 600, match: { rep: 'v720' } }])).toHaveLength(1);
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 600, times: 3 }])).toHaveLength(1);
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 600, match: { kind: 'segment' } }])).toHaveLength(1);
    expect(unmeasuredWindows([{ type: 'status', status: 503, match: { kind: 'segment' } }])).toHaveLength(1);
  });

  it('joins rules into one measurable stretch, and names the gap between them or after them', () => {
    // The finite version of bandwidth-drop: 20 Mbps for the first 8 s, then 600 kbps. Nothing is left unmeasured.
    expect(
      unmeasuredWindows([
        { type: 'throttle', kbps: 20_000, forMs: 8000 },
        { type: 'throttle', kbps: 600, afterMs: 8000 },
      ]),
    ).toStrictEqual([]);
    expect(
      unmeasuredWindows([
        { type: 'throttle', kbps: 20_000, forMs: 5000 },
        { type: 'throttle', kbps: 600, afterMs: 8000 },
      ]),
    ).toStrictEqual([{ fromMs: 5000, toMs: 8000 }]);
    expect(unmeasuredWindows([{ type: 'throttle', kbps: 600, forMs: 4000 }])).toStrictEqual([
      { fromMs: 4000, toMs: null },
    ]);
  });

  it('describes a window in a sentence that says what the player does not hear', () => {
    const [sentence] = describeUnmeasured([{ fromMs: 0, toMs: 8000 }]);
    expect(sentence).toContain('between 0 ms and 8000 ms');
    expect(sentence).toContain('20000 kbps');
    expect(sentence).toContain('Shaka ignores downloads under 5 ms');
  });
});

describe('PB-AB pre-registration: a valid plan', () => {
  it('accepts the startup experiment with no warning: latency of 300 ms measures every download', () => {
    const result = validatePreregistration(startupPrereg());
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (result.ok) {
      expect(result.prereg.conditions[0]?.profile).toBe('high-latency');
      expect(result.prereg.metrics[0]?.practicalThreshold).toBe(100);
      expect(result.prereg.seed).toBe(20261104);
      expect(result.prereg.aaCheck).toStrictEqual({ source: AA_SOURCE });
    }
  });

  it('needs no A/A check for the kinds that decide nothing or are the check: an A/A run and a pipeline check', () => {
    for (const make of [
      aaPrereg,
      () => changed((p) => ((p.kind = 'pipeline-check'), (p.catalogId = null), delete p.aaCheck)),
    ]) {
      const result = validatePreregistration(make());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.prereg.aaCheck).toBeNull();
    }
  });

  it('accepts the rebuffering experiment on the finite variant of bandwidth-drop, with no warning: every download is measured', () => {
    const result = validatePreregistration(rebufferPrereg());
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (result.ok) {
      expect(result.prereg.conditions[0]).toMatchObject({ id: 'bandwidth-drop-finite', profile: null });
      expect(result.prereg.conditions[0]?.rules).toStrictEqual([
        { type: 'throttle', kbps: 20000 },
        { type: 'throttle', kbps: 600, afterMs: 8000 },
      ]);
    }
  });

  it('refuses a condition with a stretch the player cannot hear for an experiment, an exploratory run and an A/A run: finite links only', () => {
    for (const kind of ['experiment', 'exploratory', 'aa'] as const) {
      const plan = changed((p) => {
        p.kind = kind;
        conditions(p)[0] = {
          id: 'bandwidth-drop',
          profile: 'bandwidth-drop',
          rules: profile('bandwidth-drop'),
          rationale: 'The catalog profile as it is: the link weakens after four segments.',
        };
      }, rebufferPrereg);
      const problems = problemsOf(plan).join('\n');
      expect(problems, kind).toContain('conditions[0] (bandwidth-drop)');
      expect(problems, kind).toContain('between 0 ms and 8000 ms');
      expect(problems, kind).toContain('finite links only');
      expect(problems, kind).toContain('at most 20000 kbps');
      expect(problems, kind).toContain('"profile": null');
    }
  });

  it('only warns for a pipeline check, which decides nothing', () => {
    const plan = changed((p) => {
      p.kind = 'pipeline-check';
      p.catalogId = null;
      conditions(p)[0] = {
        id: 'bandwidth-drop',
        profile: 'bandwidth-drop',
        rules: profile('bandwidth-drop'),
        rationale: 'The catalog profile as it is: the link weakens after four segments.',
      };
    }, rebufferPrereg);
    const result = validatePreregistration(plan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('conditions[0] (bandwidth-drop)');
      expect(result.warnings[0]).toContain('between 0 ms and 8000 ms');
    }
  });

  it('takes a finite link written another way, with the first 8 s covered by a throttle that ends when the drop begins', () => {
    const plan = changed((p) => {
      conditions(p)[0] = {
        id: 'bandwidth-drop-finite',
        profile: null,
        rules: [
          { type: 'throttle', kbps: 20000, forMs: 8000 },
          { type: 'throttle', kbps: 600, afterMs: 8000 },
        ],
        rationale:
          'The catalog profile with the first 8 s on a finite 20 Mbps link, so that every download is measured.',
      };
    }, rebufferPrereg);
    expect(validatePreregistration(plan)).toMatchObject({ ok: true, warnings: [] });
  });

  it('knows every named profile of the lab (a profile name is checked against the code, not a list kept here)', () => {
    for (const name of PROFILE_NAMES) {
      const withProfile = (p: Json): void => {
        conditions(p)[0] = {
          id: name,
          profile: name,
          rules: profile(name),
          rationale: `The condition called ${name} in the lab.`,
        };
        p.observation = { mediaSecondsAfterFirstFrame: 30, sessionTimeoutMs: 120000 };
      };
      // As a pipeline check every profile is accepted (a quiet stretch only warns); as an experiment only a finite link is.
      const asPipelineCheck = changed((p) => {
        withProfile(p);
        p.kind = 'pipeline-check';
        p.catalogId = null;
      });
      expect(problemsOf(asPipelineCheck), name).toStrictEqual([]);
      const asExperiment = problemsOf(changed(withProfile));
      if (unmeasuredWindows(profile(name)).length === 0) expect(asExperiment, name).toStrictEqual([]);
      else expect(asExperiment.join('\n'), name).toContain('finite links only');
    }
  });

  it('is not troubled by the order of the keys of a rule when it compares the condition with its profile', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    const plan = changed((p) => {
      conditions(p)[0] = {
        id: 'high-latency',
        profile: 'high-latency',
        rules: [{ match: { kind: 'any' }, jitterMs: 100, ms: 300, type: 'latency' }],
        rationale: 'The same profile with its keys written in another order.',
      };
    });
    expect(problemsOf(plan)).toStrictEqual([]);
  });

  it('lets a pipeline check break the sample-size, alpha and MDE rules, because it decides nothing', () => {
    const plan = changed((p) => {
      p.kind = 'pipeline-check';
      p.catalogId = null;
      p.sessionsPerArm = 3;
      p.warmupSessionsPerArm = 1;
      p.alpha = 0.1;
      p.bootstrapResamples = 100;
      delete metrics(p)[0]?.minimumDetectableEffect;
    });
    expect(problemsOf(plan)).toStrictEqual([]);
  });
});

describe('PB-AB pre-registration: what is refused', () => {
  const refused: Array<[string, unknown, RegExp]> = [
    ['something that is not an object', [], /must be a JSON object/],
    [
      'an experiment that names no A/A check: the harness must have passed its own check first',
      changed((p) => delete p.aaCheck),
      /\$\.aaCheck is required for an experiment/,
    ],
    [
      'an experiment whose A/A check is null',
      changed((p) => (p.aaCheck = null)),
      /\$\.aaCheck is required for an experiment/,
    ],
    [
      'an A/A check that is not the committed report of an A/A run',
      changed((p) => (p.aaCheck = { source: 'docs/results/ab/pilot.json' })),
      /\$\.aaCheck\.source must name the committed report of the A\/A run under docs\/results\/ab\//,
    ],
    [
      'an A/A check outside docs/results/ab',
      changed((p) => (p.aaCheck = { source: '../elsewhere/x.report.json' })),
      /\$\.aaCheck\.source must name/,
    ],
    [
      'an A/A check with a field it does not know',
      changed((p) => (p.aaCheck = { source: (p.aaCheck as Json).source, passed: true })),
      /\$\.aaCheck\.passed is not a field/,
    ],
    [
      'a field it does not know (a typo in a threshold must not become no threshold)',
      changed((p) => (p.alfa = 0.05)),
      /\$\.alfa is not a field/,
    ],
    ['another schema version', changed((p) => (p.schemaVersion = 2)), /schemaVersion must be 1/],
    ['an unknown kind', changed((p) => (p.kind = 'trial')), /\$\.kind must be one of/],
    [
      'an experiment without a catalog id',
      changed((p) => (p.catalogId = null)),
      /catalogId is required for an experiment/,
    ],
    [
      'a catalog id that is not one',
      changed((p) => (p.catalogId = 'AB-2')),
      /catalogId must be null or a catalog id/,
    ],
    ['an id with spaces', changed((p) => (p.id = 'my experiment')), /\$\.id must match/],
    [
      'a date that is not one',
      changed((p) => (p.registeredOn = '2026-13-45')),
      /registeredOn must be a date/,
    ],
    [
      'fewer than thirty sessions per arm',
      changed((p) => (p.sessionsPerArm = 20)),
      /sessionsPerArm must be an integer from 30/,
    ],
    [
      'an odd number of sessions per arm',
      changed((p) => (p.sessionsPerArm = 31)),
      /sessionsPerArm must be even/,
    ],
    [
      'a warm-up that is a large part of the run',
      changed((p) => (p.warmupSessionsPerArm = 9)),
      /warmupSessionsPerArm must be an integer from 0 to 5/,
    ],
    ['an alpha other than the policy', changed((p) => (p.alpha = 0.1)), /alpha must be 0\.05/],
    [
      'a nonsensical alpha',
      changed((p) => (p.alpha = 0.7)),
      /alpha must be a number strictly between 0 and 0\.5/,
    ],
    [
      'a bootstrap of too few resamples',
      changed((p) => (p.bootstrapResamples = 500)),
      /bootstrapResamples must be an integer from 1000/,
    ],
    ['a seed that is not an integer', changed((p) => (p.seed = 1.5)), /seed must be an integer/],
    ['an unknown engine', changed((p) => (p.engine = 'edge')), /engine must be one of/],
    [
      'a stream that is not video on demand',
      changed((p) => (p.stream = 'live-cmaf')),
      /stream must be one of/,
    ],
    [
      'WebM over HLS',
      changed((p) => ((p.stream = 'vod-webm'), (p.protocol = 'hls'))),
      /vod-webm is served over DASH only/,
    ],
    [
      'the same configuration in both arms of an experiment',
      changed((p) => (p.arms = { A: 'A', B: 'A' })),
      /puts configuration A \(Shaka defaults\) in arm A/,
    ],
    [
      'an A/A run with configuration B in an arm',
      changed((p) => ((p.kind = 'aa'), (p.arms = { A: 'A', B: 'B' }))),
      /A\/A run puts configuration A in both arms/,
    ],
    [
      'two conditions in one experiment',
      changed((p) => conditions(p).push({ ...conditions(p)[0], id: 'second' })),
      /decides on one condition/,
    ],
    ['no condition', changed((p) => (p.conditions = [])), /conditions must be a non-empty array/],
    [
      'a condition id with capitals',
      changed((p) => (conditions(p)[0]!.id = 'High Latency')),
      /conditions\[0\]\.id must match/,
    ],
    [
      'a rule the service would refuse',
      changed((p) => (conditions(p)[0]!.rules = [{ type: 'throttle', kbps: -5 }])),
      /conditions\[0\]\.rules\[0\]\.kbps must be a number > 0/,
    ],
    [
      'a rule with a field it does not have',
      changed((p) => (conditions(p)[0]!.rules = [{ type: 'latency', ms: 300, jitter: 100 }])),
      /rules\[0\]\.jitter is not a field of latency/,
    ],
    [
      'an unknown named profile',
      changed((p) => (conditions(p)[0]!.profile = 'slow')),
      /profile must be null or one of/,
    ],
    [
      'a named profile whose rules are not the profile (it changed, or it is not that profile)',
      changed(
        (p) =>
          (conditions(p)[0]!.rules = [{ type: 'latency', ms: 250, jitterMs: 100, match: { kind: 'any' } }]),
      ),
      /differ from the named profile "high-latency"/,
    ],
    [
      'a rationale that says nothing',
      changed((p) => (conditions(p)[0]!.rationale = 'it is')),
      /rationale must be a sentence/,
    ],
    [
      'a fault that starts after the observation ends',
      changed(
        (p) => (p.observation = { mediaSecondsAfterFirstFrame: 6, sessionTimeoutMs: 120000 }),
        rebufferPrereg,
      ),
      /starts 8000 ms after the first media request, but the session observes only 6000 ms/,
    ],
    [
      'a session timeout of milliseconds',
      changed((p) => (p.observation = { mediaSecondsAfterFirstFrame: 0, sessionTimeoutMs: 50 })),
      /sessionTimeoutMs must be an integer from 5000/,
    ],
    ['no metric', changed((p) => (p.metrics = [])), /metrics must be a non-empty array/],
    [
      'a metric that does not exist',
      changed((p) => (metrics(p)[0]!.id = 'latency')),
      /metrics\[0\]\.id must be one of/,
    ],
    [
      'no primary metric',
      changed((p) => (metrics(p)[0]!.role = 'secondary')),
      /at least one metric must be primary/,
    ],
    [
      'a primary metric without a practical threshold',
      changed((p) => delete metrics(p)[0]!.practicalThreshold),
      /practicalThreshold is required for a primary metric/,
    ],
    [
      'a practical threshold of zero',
      changed((p) => (metrics(p)[0]!.practicalThreshold = 0)),
      /practicalThreshold must be a number > 0/,
    ],
    [
      'a share threshold above 1',
      changed((p) => (metrics(p)[0]!.practicalThreshold = 1.5), rebufferPrereg),
      /at most 1/,
    ],
    [
      'a threshold without its basis',
      changed((p) => delete metrics(p)[0]!.thresholdBasis),
      /thresholdBasis is required for a primary metric/,
    ],
    [
      'a primary metric without the MDE of the pilot',
      changed((p) => delete metrics(p)[0]!.minimumDetectableEffect),
      /minimumDetectableEffect is required/,
    ],
    [
      'a practical threshold below the minimum detectable effect',
      changed((p) => (metrics(p)[0]!.practicalThreshold = 60)),
      /practicalThreshold \(60\) is below the minimum detectable effect \(80\)/,
    ],
    [
      'an MDE computed for another number of sessions',
      changed((p) => ((metrics(p)[0]!.minimumDetectableEffect as Json).sessionsPerArm = 40)),
      /minimumDetectableEffect\.sessionsPerArm \(40\) is not the sessionsPerArm of the plan \(30\)/,
    ],
    [
      'an MDE at a power below the policy',
      changed((p) => ((metrics(p)[0]!.minimumDetectableEffect as Json).power = 0.5)),
      /power \(0\.5\) is below the 0\.8 of the policy/,
    ],
    [
      'an MDE that cites no pilot file',
      changed((p) => ((metrics(p)[0]!.minimumDetectableEffect as Json).source = 'my head')),
      /source must name the committed pilot file under docs\/results\/ab\//,
    ],
    [
      'a metric listed twice',
      changed((p) => metrics(p).push({ ...metrics(p)[0], role: 'secondary' })),
      /a metric is listed twice/,
    ],
    [
      'a metric of playback with no playback',
      changed((p) =>
        metrics(p).push({ id: 'rebufferCount', role: 'secondary', direction: 'lower-is-better' }),
      ),
      /rebufferCount only exist once the player has played/,
    ],
    ['no hypothesis', changed((p) => (p.hypotheses = [])), /hypotheses must be a non-empty array/],
    [
      'a primary metric with no hypothesis in words',
      changed(
        (p) => (p.hypotheses = [{ metric: 'switches', text: 'B switches rung less often than A does.' }]),
      ),
      /primary metric startupMs has no hypothesis/,
    ],
    [
      'a decision rule that is not one the code implements',
      changed((p) => ((p.decisionRule as Json).id = 'custom')),
      /decisionRule\.id must be one of pb-ab-v1/,
    ],
    [
      'a decision rule without words',
      changed((p) => ((p.decisionRule as Json).text = 'ship if better')),
      /decisionRule\.text must be a sentence of at least 60/,
    ],
    [
      'an exclusion rule that tolerates most sessions failing',
      changed((p) => ((p.exclusionRule as Json).maxFailedShare = 0.9)),
      /maxFailedShare must be a number above 0 and at most 0\.5/,
    ],
    ['no exclusion rule', changed((p) => delete p.exclusionRule), /exclusionRule must be an object/],
  ];

  it.each(refused)('refuses %s', (_name, plan, message) => {
    expect(problemsOf(plan).join('\n')).toMatch(message);
  });

  it('lists every problem at once, not just the first', () => {
    const plan = changed((p) => {
      p.sessionsPerArm = 11;
      p.alpha = 0.2;
      p.metrics = [];
    });
    expect(problemsOf(plan).length).toBeGreaterThanOrEqual(3);
  });
});

describe('PB-AB pre-registration: B is several settings together, so no sentence of a plan may credit one setting', () => {
  it('knows every setting of B under each name it goes by: its path, its last key and the id of its knob', () => {
    expect(settingNames()).toStrictEqual(
      [
        'abr.defaultBandwidthEstimate',
        'abr.switchInterval',
        'abr.useNetworkInformation',
        'bufferingGoal',
        'conservative-start',
        'deeper-buffer',
        'defaultBandwidthEstimate',
        'faster-switching',
        'streaming.bufferingGoal',
        'switchInterval',
        'useNetworkInformation',
      ].sort(),
    );
    expect(mentionedSettings('B starts on the lowest rung and keeps more buffer')).toStrictEqual([]);
    expect(mentionedSettings('the SwitchInterval of B')).toStrictEqual(['switchInterval']);
  });

  it.each([
    ['a hypothesis', (p: Json) => ((p.hypotheses as Json[])[0] as Json).text, 'hypotheses[0].text'],
    ['a threshold basis', (p: Json) => (metrics(p)[0] as Json).thresholdBasis, 'metrics[0].thresholdBasis'],
    ['a condition rationale', (p: Json) => (conditions(p)[0] as Json).rationale, 'conditions[0].rationale'],
    ['the title', (p: Json) => p.title, '$.title'],
  ])('refuses %s that names a single setting', (_name, original, where) => {
    const plan = changed((p) => {
      const sentence = `${String(original(p))} The shorter switchInterval of B is what should show.`;
      if (where === 'hypotheses[0].text') ((p.hypotheses as Json[])[0] as Json).text = sentence;
      else if (where === 'metrics[0].thresholdBasis') (metrics(p)[0] as Json).thresholdBasis = sentence;
      else if (where === 'conditions[0].rationale') (conditions(p)[0] as Json).rationale = sentence;
      else p.title = sentence;
    });
    const problems = problemsOf(plan).join('\n');
    expect(problems).toContain(`${where} names a single setting of configuration B (switchInterval)`);
    expect(problems).toContain('B is several settings together');
  });

  it('accepts what is expected of B as a whole', () => {
    const plan = changed((p) => {
      ((p.hypotheses as Json[])[0] as Json).text =
        'B starts on the lowest rung in every engine and keeps more media buffered, so it should stall less after the link drops.';
    });
    expect(problemsOf(plan)).toStrictEqual([]);
  });
});

describe('PB-AB pre-registration: the file, its hash and the refusal to run without it', () => {
  const scratch = resolve(import.meta.dirname, '../../../.tmp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'ab-prereg-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const write = (name: string, content: string): string => {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  };

  it('hashes the bytes of the file: the known sha256 of "abc", and any change of a byte changes the hash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const text = `${JSON.stringify(startupPrereg(), null, 2)}\n`;
    const loaded = loadPreregistration(write('valid.json', text));
    expect(loaded.sha256).toBe(sha256Hex(text));
    expect(loaded.text).toBe(text);
    expect(sha256Hex(text.replace('30000', '30001'))).not.toBe(loaded.sha256);
    expect(sha256Hex(`${text} `)).not.toBe(loaded.sha256);
    expect(loaded.prereg.id).toBe('PB-AB-002');
  });

  it('refuses a file that is missing, that is not JSON, or that does not validate, naming the file and every problem', () => {
    expect(() => loadPreregistration(join(directory, 'absent.json'))).toThrow(/cannot be read/);
    expect(() => loadPreregistration(write('broken.json', '{ "id": '))).toThrow(/not valid JSON/);
    const invalid = write(
      'invalid.json',
      JSON.stringify(changed((p) => ((p.sessionsPerArm = 3), (p.seed = -1)))),
    );
    expect(() => loadPreregistration(invalid)).toThrow(PreregistrationError);
    try {
      loadPreregistration(invalid);
    } catch (error) {
      expect((error as PreregistrationError).message).toContain(
        'invalid.json is not a valid pre-registration',
      );
      expect((error as PreregistrationError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('parses from text too (the report re-validates the plan embedded in the results)', () => {
    const text = JSON.stringify(startupPrereg());
    expect(parsePreregistration('embedded', text).sha256).toBe(sha256Hex(text));
    expect(() => parsePreregistration('embedded', '[]')).toThrow(/must be a JSON object/);
  });
});
