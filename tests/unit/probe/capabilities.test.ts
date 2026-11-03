import { describe, expect, it } from 'vitest';
import {
  capabilitiesFromEngine,
  explainNoStream,
  pickStream,
  selectStreams,
} from '../../../src/lab/probe/capabilities.ts';
import type { Capabilities, FlavourCapability } from '../../../src/lab/probe/capabilities.ts';
import { FLAVOUR_STREAMS, LAB_STREAMS } from '../../../src/lab/probe/formats.ts';
import type { FlavourId } from '../../../src/lab/probe/formats.ts';
import { STREAM_IDS } from '../../../src/shared/streams.ts';
import { UNSUPPORTED_FAILURE, probedEngine, verdict } from './fixtures.ts';

function flavour(reliability: FlavourCapability['reliability'], claim = true): FlavourCapability {
  const passes = reliability === 'ok' ? 5 : reliability === 'fail' ? 0 : 2;
  return {
    supported: reliability === 'ok',
    reliability,
    typeSupportedClaim: claim,
    attempts: 5,
    passes,
    ...(reliability === 'ok' ? {} : { stage: 'play' as const, error: 'NotSupportedError: nope' }),
  };
}

function caps(flavours: Partial<Record<FlavourId, FlavourCapability>>): Capabilities {
  return { engine: 'webkit', browserVersion: '3.0', flavours, lies: [] };
}

describe('pickStream', () => {
  it.each([
    ['both flavours play', { 'cmaf-vp9-aac': 'ok', 'webm-vp9-opus': 'ok' }, 'vod', 'dash', 'vod-cmaf'],
    ['both flavours play', { 'cmaf-vp9-aac': 'ok', 'webm-vp9-opus': 'ok' }, 'vod', 'hls', 'vod-cmaf'],
    ['only the primary plays', { 'cmaf-vp9-aac': 'ok' }, 'vod', 'dash', 'vod-cmaf'],
    [
      'the primary fails, WebM plays: DASH falls back',
      { 'cmaf-vp9-aac': 'fail', 'webm-vp9-opus': 'ok' },
      'vod',
      'dash',
      'vod-webm',
    ],
    [
      'the primary fails, WebM plays: HLS has no fallback (WebM is DASH only)',
      { 'cmaf-vp9-aac': 'fail', 'webm-vp9-opus': 'ok' },
      'vod',
      'hls',
      null,
    ],
    [
      'the primary is intermittent: not supported, WebM takes over',
      { 'cmaf-vp9-aac': 'intermittent', 'webm-vp9-opus': 'ok' },
      'vod',
      'dash',
      'vod-webm',
    ],
    [
      'everything is intermittent',
      { 'cmaf-vp9-aac': 'intermittent', 'webm-vp9-opus': 'intermittent' },
      'vod',
      'dash',
      null,
    ],
    ['nothing plays', { 'cmaf-vp9-aac': 'fail', 'webm-vp9-opus': 'fail' }, 'vod', 'dash', null],
    ['live uses the CMAF stream', { 'cmaf-vp9-aac': 'ok' }, 'live', 'dash', 'live-cmaf'],
    ['live over HLS', { 'cmaf-vp9-aac': 'ok' }, 'live', 'hls', 'live-cmaf'],
    ['live has no WebM fallback', { 'cmaf-vp9-aac': 'fail', 'webm-vp9-opus': 'ok' }, 'live', 'dash', null],
  ] as const)('%s: %s %s -> %s', (_name, verdicts, kind, protocol, expected) => {
    const flavours = Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, flavour(v)]));
    expect(pickStream(caps(flavours), kind, protocol)).toBe(expected);
  });

  it('does not pick a stream for a flavour that was not probed', () => {
    expect(pickStream(caps({}), 'vod', 'dash')).toBeNull();
  });

  it('ignores flavours no lab stream is made of (H.264 plays, but nothing streams it)', () => {
    expect(
      pickStream(caps({ 'cmaf-h264-aac': flavour('ok'), 'cmaf-vp9-opus': flavour('ok') }), 'vod', 'dash'),
    ).toBeNull();
  });

  it('only ever returns a stream the lab serves over the requested protocol', () => {
    const everything = caps({ 'cmaf-vp9-aac': flavour('ok'), 'webm-vp9-opus': flavour('ok') });
    for (const kind of ['vod', 'live'] as const) {
      for (const protocol of ['dash', 'hls'] as const) {
        const id = pickStream(everything, kind, protocol);
        if (id) {
          expect(STREAM_IDS).toContain(id);
          expect(LAB_STREAMS[id].protocols).toContain(protocol);
          expect(LAB_STREAMS[id].kind).toBe(kind);
        }
      }
    }
  });

  it('maps each probed flavour of the lab to its canonical stream', () => {
    expect(FLAVOUR_STREAMS).toEqual({ 'cmaf-vp9-aac': 'vod-cmaf', 'webm-vp9-opus': 'vod-webm' });
    for (const [flavourId, streamId] of Object.entries(FLAVOUR_STREAMS)) {
      expect(LAB_STREAMS[streamId as keyof typeof LAB_STREAMS].flavour).toBe(flavourId);
    }
  });
});

describe('capabilitiesFromEngine', () => {
  it('turns attempts into a verdict per flavour and lists the lies', () => {
    const capabilities = capabilitiesFromEngine(
      'webkit',
      probedEngine({
        version: '3.0',
        cases: {
          'cmaf-vp9-aac': verdict(2, 5, true),
          'webm-vp9-opus': verdict(0, 5, true),
          'cmaf-vp9-opus': verdict(0, 5, false, UNSUPPORTED_FAILURE),
          'vp9-fmp4-video': verdict(0, 5, true),
        },
      }),
    );
    expect(capabilities.engine).toBe('webkit');
    expect(capabilities.browserVersion).toBe('3.0');
    expect(capabilities.flavours['cmaf-vp9-aac']).toMatchObject({
      supported: false,
      reliability: 'intermittent',
      typeSupportedClaim: true,
      attempts: 5,
      passes: 2,
      stage: 'play',
    });
    expect(capabilities.flavours['cmaf-h264-aac']).toMatchObject({ supported: true, reliability: 'ok' });
    // The honest "no" is not a lie; the single-track case is not a flavour and is not listed here.
    expect(capabilities.lies).toEqual(['cmaf-vp9-aac', 'webm-vp9-opus']);
    expect(capabilities.flavours).not.toHaveProperty('vp9-fmp4-video');
  });

  it('turns a launch failure into "every flavour unsupported at stage launch", not an exception', () => {
    const capabilities = capabilitiesFromEngine('firefox', {
      launchFailed: 'Failed to launch\nCould not find profile folder',
    });
    expect(capabilities.browserVersion).toBeNull();
    expect(capabilities.launchFailed).toContain('Could not find profile folder');
    expect(capabilities.flavours['cmaf-vp9-aac']).toMatchObject({
      supported: false,
      stage: 'launch',
      error: 'Failed to launch',
    });
    expect(pickStream(capabilities, 'vod', 'dash')).toBeNull();
    expect(capabilities.lies).toEqual([]);
  });
});

describe('explainNoStream', () => {
  it('is null when a stream can be played', () => {
    expect(explainNoStream(caps({ 'cmaf-vp9-aac': flavour('ok') }), 'vod', 'dash')).toBeNull();
  });

  it('carries the evidence: engine, flavour, verdict, failing stage, error and the lie', () => {
    const reason =
      explainNoStream(
        caps({ 'cmaf-vp9-aac': flavour('intermittent'), 'webm-vp9-opus': flavour('fail') }),
        'vod',
        'dash',
      ) ?? '';
    expect(reason).toContain('no vod stream plays over dash in webkit 3.0');
    expect(reason).toContain(
      'cmaf-vp9-aac intermittent 2/5, [play] NotSupportedError: nope, isTypeSupported claims true',
    );
    expect(reason).toContain('webm-vp9-opus fail 0/5');
    expect(reason).toContain('docs/CODEC_MATRIX.md');
  });

  it('says the flavour was not probed instead of inventing a verdict', () => {
    expect(explainNoStream(caps({}), 'live', 'hls')).toContain('cmaf-vp9-aac was not probed');
  });

  it('explains a launch failure with the launch error', () => {
    const reason =
      explainNoStream(capabilitiesFromEngine('firefox', { launchFailed: 'boom\nmore' }), 'vod', 'dash') ?? '';
    expect(reason).toContain('firefox');
    expect(reason).toContain('boom');
  });
});

describe('selectStreams', () => {
  it('decides every kind and protocol at once, with a reason for each skip', () => {
    const selection = selectStreams(
      caps({ 'cmaf-vp9-aac': flavour('fail'), 'webm-vp9-opus': flavour('ok') }),
    );
    expect(selection.map((s) => [s.kind, s.protocol, s.stream])).toEqual([
      ['vod', 'dash', 'vod-webm'],
      ['vod', 'hls', null],
      ['live', 'dash', null],
      ['live', 'hls', null],
    ]);
    expect(selection.filter((s) => s.stream === null).every((s) => s.reason !== null)).toBe(true);
    expect(selection.filter((s) => s.stream !== null).every((s) => s.reason === null)).toBe(true);
  });
});
