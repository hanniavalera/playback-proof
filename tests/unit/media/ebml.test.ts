import { describe, expect, it } from 'vitest';
import {
  EbmlError,
  ID,
  buildCluster,
  buildWebmInit,
  element,
  parseWebmFile,
  parseWebmInit,
  parseWebmMediaSegment,
  readElements,
  stringElement,
  uintElement,
  withDefaultDuration,
} from '../../../src/server/media/ebml.ts';

/** EBML header as ffmpeg writes it for WebM: DocType "webm". */
const ebmlHeader = (docType = 'webm'): Buffer =>
  element(ID.EBML, uintElement(0x4286, 1), stringElement(ID.DocType, docType), uintElement(0x4287, 4));

const tracks = (): Buffer =>
  element(
    ID.Tracks,
    element(
      ID.TrackEntry,
      uintElement(ID.TrackNumber, 1),
      uintElement(ID.TrackUID, 77),
      uintElement(ID.TrackType, 1),
      stringElement(ID.CodecID, 'V_VP9'),
      uintElement(ID.DefaultDuration, 33_333_333),
      element(ID.Video, uintElement(ID.PixelWidth, 640), uintElement(ID.PixelHeight, 360)),
    ),
  );

describe('EBML sizes and elements', () => {
  it('round-trips unsigned integers of every length, with minimal bytes', () => {
    for (const v of [0, 1, 127, 128, 255, 256, 65_535, 65_536, 2 ** 32, 2 ** 40 + 3]) {
      const el = uintElement(ID.Timecode, v);
      const [parsed] = readElements(el);
      expect(parsed).toBeDefined();
      expect(parsed?.dataEnd).toBe(el.length);
    }
    expect(uintElement(ID.Timecode, 0).length).toBe(3); // id (1) + size (1) + one data byte
    expect(uintElement(ID.Timecode, 256).length).toBe(4);
  });

  it('reserves the all-ones size for "unknown": a 127 byte payload needs a two byte size', () => {
    expect(element(ID.Void, Buffer.alloc(126))[1]).toBe(0x80 | 126);
    const el = element(ID.Void, Buffer.alloc(127));
    expect(el[1]).toBe(0x40); // two-byte size: 0x407f
    expect(readElements(el)[0]?.dataEnd).toBe(el.length);
  });

  it('rejects truncated, overlong and unknown-size (non-Segment) elements', () => {
    expect(() => readElements(Buffer.from([0xec, 0x85, 1, 2]))).toThrow(EbmlError); // claims 5 bytes, has 2
    expect(() => readElements(Buffer.from([0x00]))).toThrow(EbmlError); // invalid id
    expect(() =>
      readElements(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])),
    ).toThrow(/unknown size/);
    expect(() => readElements(Buffer.from([0xec]))).toThrow(EbmlError);
  });
});

describe('WebM init and media segments', () => {
  const header = ebmlHeader();
  const init = buildWebmInit({
    ebmlHeader: header,
    tracksElement: tracks(),
    timecodeScaleNs: 1_000_000,
    app: 'playback-proof',
  });

  it('writes EBML header + Segment (unknown size) + Info + Tracks and no Cluster', () => {
    const parsed = parseWebmInit(init);
    expect(parsed.docType).toBe('webm');
    expect(parsed.timecodeScaleNs).toBe(1_000_000);
    expect(parsed.tracks).toEqual([
      { number: 1, type: 'video', codecId: 'V_VP9', defaultDurationNs: 33_333_333, width: 640, height: 360 },
    ]);
    expect(parsed.segmentChildIds).toEqual([ID.Info, ID.Tracks]);
    expect(parsed.ebmlHeader.equals(header)).toBe(true);
  });

  it('refuses an init segment that contains a Cluster, and a file that is not WebM', () => {
    const withCluster = Buffer.concat([
      init,
      buildCluster(0, [{ trackNumber: 1, relativeTimecode: 0, keyframe: true, data: Buffer.from('x') }]),
    ]);
    expect(() => parseWebmInit(withCluster)).toThrow(/contains a Cluster/);
    const mkv = buildWebmInit({
      ebmlHeader: ebmlHeader('matroska'),
      tracksElement: tracks(),
      timecodeScaleNs: 1_000_000,
      app: 'x',
    });
    expect(() => parseWebmInit(mkv)).toThrow(/DocType/);
  });

  it('round-trips a Cluster: timecode, relative timestamps, keyframe flags, payload bytes', () => {
    const blocks = [
      { trackNumber: 1, relativeTimecode: 0, keyframe: true, data: Buffer.from('key') },
      { trackNumber: 1, relativeTimecode: 33, keyframe: false, data: Buffer.from('delta-a') },
      { trackNumber: 1, relativeTimecode: 67, keyframe: false, data: Buffer.from('delta-b') },
    ];
    const cluster = parseWebmMediaSegment(buildCluster(2000, blocks));
    expect(cluster.timecode).toBe(2000);
    expect(cluster.blocks.map((b) => [b.timecode, b.keyframe, b.data.toString()])).toEqual([
      [2000, true, 'key'],
      [2033, false, 'delta-a'],
      [2067, false, 'delta-b'],
    ]);
  });

  it('a whole file (init + clusters) parses as init plus every cluster', () => {
    const file = Buffer.concat([
      init,
      buildCluster(0, [{ trackNumber: 1, relativeTimecode: 0, keyframe: true, data: Buffer.from('a') }]),
      buildCluster(2000, [{ trackNumber: 1, relativeTimecode: 0, keyframe: true, data: Buffer.from('b') }]),
    ]);
    const parsed = parseWebmFile(file);
    expect(parsed.clusters.map((c) => c.timecode)).toEqual([0, 2000]);
  });

  it('a media segment must be exactly one Cluster', () => {
    const one = buildCluster(0, [
      { trackNumber: 1, relativeTimecode: 0, keyframe: true, data: Buffer.from('a') },
    ]);
    expect(() => parseWebmMediaSegment(Buffer.concat([one, one]))).toThrow(/exactly one Cluster/);
    expect(() => parseWebmMediaSegment(element(ID.Void, Buffer.alloc(3)))).toThrow(/exactly one Cluster/);
  });

  it('rejects laced blocks and relative timestamps that do not fit 16 bits', () => {
    const laced = element(
      ID.Cluster,
      uintElement(ID.Timecode, 0),
      element(ID.SimpleBlock, Buffer.from([0x81, 0, 0, 0x02, 1, 2, 3])),
    );
    expect(() => parseWebmMediaSegment(laced)).toThrow(/lacing/);
    expect(() =>
      buildCluster(0, [{ trackNumber: 1, relativeTimecode: 40_000, keyframe: true, data: Buffer.from('x') }]),
    ).toThrow(RangeError);
    expect(() => buildCluster(0, [])).toThrow(RangeError);
  });

  it('reads a BlockGroup block with its BlockDuration; a block with a ReferenceBlock is not a keyframe', () => {
    const block = (extra: Buffer[]): Buffer =>
      element(
        ID.Cluster,
        uintElement(ID.Timecode, 10),
        element(
          ID.BlockGroup,
          element(ID.Block, Buffer.from([0x81, 0, 5, 0x00, 9])),
          uintElement(ID.BlockDuration, 7),
          ...extra,
        ),
      );
    const key = parseWebmMediaSegment(block([])).blocks[0];
    expect(key).toMatchObject({ timecode: 15, keyframe: true, durationTicks: 7 });
    const delta = parseWebmMediaSegment(block([uintElement(ID.ReferenceBlock, 1)])).blocks[0];
    expect(delta?.keyframe).toBe(false);
  });
});

describe('withDefaultDuration (ffmpeg 6.1 writes no DefaultDuration, ffmpeg 9 does)', () => {
  const entry = (...extra: Buffer[]): Buffer =>
    element(
      ID.Tracks,
      element(
        ID.TrackEntry,
        uintElement(ID.TrackNumber, 1),
        uintElement(ID.TrackType, 1),
        stringElement(ID.CodecID, 'V_VP9'),
        ...extra,
        element(ID.Video, uintElement(ID.PixelWidth, 640), uintElement(ID.PixelHeight, 360)),
      ),
    );
  const durationOf = (t: Buffer): number | undefined =>
    parseWebmInit(
      buildWebmInit({ ebmlHeader: ebmlHeader(), tracksElement: t, timecodeScaleNs: 1_000_000, app: 'x' }),
    ).tracks[0]?.defaultDurationNs;

  it('inserts the element when the muxer left it out, keeping every other child', () => {
    const out = withDefaultDuration(entry(), 1, 33_333_333);
    expect(durationOf(out)).toBe(33_333_333);
    const [t] = parseWebmInit(
      buildWebmInit({ ebmlHeader: ebmlHeader(), tracksElement: out, timecodeScaleNs: 1_000_000, app: 'x' }),
    ).tracks;
    expect(t).toMatchObject({ number: 1, type: 'video', codecId: 'V_VP9', width: 640, height: 360 });
  });

  it('replaces a value the muxer wrote, so the init is the same whichever ffmpeg made the packets', () => {
    const withOwn = entry(uintElement(ID.DefaultDuration, 33_000_000));
    expect(durationOf(withDefaultDuration(withOwn, 1, 33_333_333))).toBe(33_333_333);
    // the muxer that wrote exactly the same value and the one that wrote none give identical bytes
    expect(
      withDefaultDuration(entry(uintElement(ID.DefaultDuration, 33_333_333)), 1, 33_333_333).equals(
        withDefaultDuration(entry(), 1, 33_333_333),
      ),
    ).toBe(true);
  });

  it('refuses a track that is not there and something that is not a Tracks element', () => {
    expect(() => withDefaultDuration(entry(), 2, 1)).toThrow(/no TrackEntry with number 2/);
    expect(() => withDefaultDuration(element(ID.Void, Buffer.alloc(3)), 1, 1)).toThrow(
      /exactly one Tracks element/,
    );
  });
});
