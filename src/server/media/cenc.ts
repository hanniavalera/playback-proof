// Common Encryption (ISO/IEC 23001-7), scheme 'cenc': AES-128 in counter mode over whole samples, one 8-byte IV per sample. The counter
// block of a sample is its IV followed by a 64-bit block counter that starts at 0 for every sample.
//
// Written here and not by ffmpeg's `-encryption_scheme`: ffmpeg writes the per-fragment sample information (senc, saio, saiz in every
// traf) from release 8.0 on; before that it encrypts the samples and then leaves the fragments without the information needed to decrypt
// them, which was measured on 6.1.1, the version of the CI image (docs/decisions/media.md, ADR-049). The key is public and the IV is a
// counter: this protects nothing and is a test fixture. ffmpeg's own decryption (-decryption_key) is the oracle, in
// tools/verify-streams.ts, against the same stream generated without encryption.

import { createCipheriv } from 'node:crypto';
import { box, BoxError, fullBox, readBoxes, replaceBox } from './isobmff.ts';

export const CENC_IV_SIZE = 8;

/** AES-128 in CTR mode; the counter block is a 128-bit big-endian integer that increments by one per 16 bytes. */
export function aesCtr(key: Buffer, counterBlock: Buffer, data: Buffer): Buffer {
  if (key.length !== 16) throw new RangeError(`an AES-128 key is 16 bytes, got ${key.length}`);
  if (counterBlock.length !== 16)
    throw new RangeError(`a counter block is 16 bytes, got ${counterBlock.length}`);
  const cipher = createCipheriv('aes-128-ctr', key, counterBlock);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** The IV of sample `index` of a track: the index as a 64-bit big-endian number. Distinct for every sample of the track. */
export function ivForSample(index: number): Buffer {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`invalid sample index ${index}`);
  const iv = Buffer.alloc(CENC_IV_SIZE);
  iv.writeBigUInt64BE(BigInt(index));
  return iv;
}

/** CENC encryption (and decryption: CTR is its own inverse) of one whole sample. */
export function encryptSample(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  if (iv.length !== CENC_IV_SIZE) throw new RangeError(`an IV is ${CENC_IV_SIZE} bytes, got ${iv.length}`);
  return aesCtr(key, Buffer.concat([iv, Buffer.alloc(8)]), data);
}

/** Encrypts the samples of one track in order: sample i gets the IV `ivForSample(i)`. Everything else about a sample is kept. */
export function encryptSamples<T extends { data: Buffer }>(
  samples: T[],
  key: Buffer,
): Array<T & { iv: Buffer }> {
  return samples.map((s, i) => {
    const iv = ivForSample(i);
    return { ...s, data: encryptSample(key, iv, s.data), iv };
  });
}

/**
 * The init segment of a protected track: the only sample entry 'vp09' / 'mp4a' becomes 'encv' / 'enca' and gets a `sinf`
 * (frma = the real format, schm = 'cenc' 1.0, schi > tenc: protected, 8-byte per-sample IVs, the default key id), which is the layout
 * ffmpeg's muxer writes too. The containers on the way are resized; nothing else changes.
 */
export function protectInit(init: Buffer, keyId: Buffer): Buffer {
  if (keyId.length !== 16) throw new RangeError(`a key id is 16 bytes, got ${keyId.length}`);
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const protectStsd = (stsd: Buffer): Buffer => {
    // stsd: box header (8), version/flags (4), entry_count (4), then the entries
    const entries = readBoxes(stsd, 16, stsd.length);
    if (stsd.readUInt32BE(12) !== 1 || entries.length !== 1)
      throw new BoxError(`stsd has ${entries.length} sample entries, expected exactly one`);
    const entry = entries[0] as (typeof entries)[number];
    const protectedType = entry.type === 'vp09' ? 'encv' : entry.type === 'mp4a' ? 'enca' : undefined;
    if (!protectedType)
      throw new BoxError(
        `sample entry '${entry.type}' cannot be protected (the lab protects 'vp09' and 'mp4a')`,
      );
    const sinf = box(
      'sinf',
      box('frma', Buffer.from(entry.type, 'latin1')),
      fullBox('schm', 0, 0, Buffer.from('cenc', 'latin1'), u32(0x0001_0000)),
      box('schi', fullBox('tenc', 0, 0, Buffer.from([0, 0, 1, CENC_IV_SIZE]), keyId)),
    );
    const protectedEntry = box(
      protectedType,
      stsd.subarray(entry.start + entry.headerSize, entry.start + entry.size),
      sinf,
    );
    return fullBox('stsd', stsd.readUInt8(8), stsd.readUIntBE(9, 3), u32(1), protectedEntry);
  };
  const out = replaceBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'], protectStsd);
  if (out.length === init.length) throw new BoxError('the init segment has no sample description to protect');
  return out;
}
