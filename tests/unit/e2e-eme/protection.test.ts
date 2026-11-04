import { describe, expect, it } from 'vitest';
import {
  CLEARKEY_SYSTEM_ID,
  MP4_PROTECTION_SCHEME,
  protectionOfAdaptationSets,
  protectionOfInit,
  textFormsOfKey,
  uuidOfKeyId,
} from '../../e2e/eme/protection.ts';

// Public throw-away values (16 ASCII bytes each: "playbackproof-id" and "playbackproofkey"); they protect nothing.
const KEY_ID = '706c61796261636b70726f6f662d6964';
const KEY = '706c61796261636b70726f6f666b6579';

// The manifest the lab's builder writes for vod-cmaf-clearkey, trimmed to what these helpers read.
const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static">
  <Period id="1" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="706c6179-6261-636b-7072-6f6f662d6964"/>
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"/>
      <Representation id="v360" bandwidth="702192" codecs="vp09.00.21.08"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="706c6179-6261-636b-7072-6f6f662d6964"/>
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"/>
      <Representation id="a-aac" bandwidth="39972" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('protectionOfAdaptationSets', () => {
  it('lists the protection of each AdaptationSet in order: the generic scheme with its default_KID, and the ClearKey system', () => {
    expect(protectionOfAdaptationSets(MPD)).toEqual([
      [
        { schemeIdUri: MP4_PROTECTION_SCHEME, value: 'cenc', defaultKid: uuidOfKeyId(KEY_ID) },
        { schemeIdUri: CLEARKEY_SYSTEM_ID, value: 'ClearKey1.0', defaultKid: null },
      ],
      [
        { schemeIdUri: MP4_PROTECTION_SCHEME, value: 'cenc', defaultKid: uuidOfKeyId(KEY_ID) },
        { schemeIdUri: CLEARKEY_SYSTEM_ID, value: 'ClearKey1.0', defaultKid: null },
      ],
    ]);
  });

  it('says so when one set is left in the clear: an empty list for it, not a shorter one for all', () => {
    const clearAudio = MPD.replace(
      /(<AdaptationSet id="2"[^>]*>)[\s\S]*?(<Representation id="a-aac")/,
      '$1\n      $2',
    );
    const sets = protectionOfAdaptationSets(clearAudio);
    expect(sets.map((elements) => elements.length)).toEqual([2, 0]);
  });

  it('reads an element whatever the order of its attributes, and a protection with no value', () => {
    const odd = `<MPD><Period><AdaptationSet id="1"><ContentProtection cenc:default_KID="aaaa" schemeIdUri="urn:x"></ContentProtection></AdaptationSet></Period></MPD>`;
    expect(protectionOfAdaptationSets(odd)).toEqual([
      [{ schemeIdUri: 'urn:x', value: null, defaultKid: 'aaaa' }],
    ]);
  });

  it('finds no sets in a document that has none', () => {
    expect(protectionOfAdaptationSets('<MPD/>')).toEqual([]);
  });
});

describe('uuidOfKeyId', () => {
  it('writes 32 hex digits as the 8-4-4-4-12 text of a manifest', () => {
    expect(uuidOfKeyId(KEY_ID)).toBe('706c6179-6261-636b-7072-6f6f662d6964');
    expect(uuidOfKeyId(KEY_ID.toUpperCase())).toBe('706c6179-6261-636b-7072-6f6f662d6964');
  });
});

describe('textFormsOfKey: every way the key could be written into a manifest', () => {
  const forms = textFormsOfKey(KEY);

  it('names them, with the values known from the key bytes ("playbackproofkey")', () => {
    expect(forms).toEqual({
      hex: KEY,
      'upper-case hex': KEY.toUpperCase(),
      base64: 'cGxheWJhY2twcm9vZmtleQ==',
      'base64 without padding': 'cGxheWJhY2twcm9vZmtleQ',
      base64url: 'cGxheWJhY2twcm9vZmtleQ',
    });
  });

  it('are all absent from the real manifest shape (the key id is not the key), and each one is found when it is written in', () => {
    for (const [form, text] of Object.entries(forms)) {
      expect(MPD.includes(text), form).toBe(false);
      expect(`${MPD}<!-- ${text} -->`.includes(text), form).toBe(true);
    }
  });

  it('a key whose base64 has URL-unsafe characters is also written the URL-safe way', () => {
    const odd = textFormsOfKey('fbff'.padEnd(32, '0'));
    expect(odd.base64).toContain('+');
    expect(odd.base64url).not.toContain('+');
    expect(odd.base64url).toContain('-');
  });
});

describe('protectionOfInit', () => {
  const drm = { keyId: KEY_ID, key: KEY };
  const tenc = Buffer.concat([Buffer.from('tenc'), Buffer.from([0, 0, 1, 8]), Buffer.from(KEY_ID, 'hex')]);

  it('sees a protected video entry, a tenc box and the key id', () => {
    const init = Buffer.concat([Buffer.from('....ftypisom....moov....encv....'), tenc]);
    expect(protectionOfInit(init, drm)).toEqual({
      protectedEntries: ['encv'],
      hasTenc: true,
      namesKeyId: true,
      containsKey: false,
    });
  });

  it('sees a protected audio entry', () => {
    expect(
      protectionOfInit(Buffer.concat([Buffer.from('....enca....'), tenc]), drm).protectedEntries,
    ).toEqual(['enca']);
  });

  it('sees a clear init segment: no protected entry, no tenc, no key id', () => {
    expect(protectionOfInit(Buffer.from('....ftypisom....moov....vp09....'), drm)).toEqual({
      protectedEntries: [],
      hasTenc: false,
      namesKeyId: false,
      containsKey: false,
    });
  });

  it('flags an init segment that carries the key itself', () => {
    const leaky = Buffer.concat([Buffer.from('....encv....'), tenc, Buffer.from(KEY, 'hex')]);
    expect(protectionOfInit(leaky, drm).containsKey).toBe(true);
  });
});
