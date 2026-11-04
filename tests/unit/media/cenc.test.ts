import { describe, expect, it } from 'vitest';
import {
  aesCtr,
  CENC_IV_SIZE,
  encryptSample,
  encryptSamples,
  ivForSample,
  protectInit,
} from '../../../src/server/media/cenc.ts';
import { BoxError, box } from '../../../src/server/media/isobmff.ts';

describe('aesCtr', () => {
  // NIST SP 800-38A, F.5.1 CTR-AES128.Encrypt: four blocks, so the 128-bit big-endian counter increments three times.
  it('is AES-128 in CTR mode: the published test vector of NIST SP 800-38A F.5.1', () => {
    const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
    const counter = Buffer.from('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 'hex');
    const plain = Buffer.from(
      '6bc1bee22e409f96e93d7e117393172a' +
        'ae2d8a571e03ac9c9eb76fac45af8e51' +
        '30c81c46a35ce411e5fbc1191a0a52ef' +
        'f69f2445df4f9b17ad2b417be66c3710',
      'hex',
    );
    expect(aesCtr(key, counter, plain).toString('hex')).toBe(
      '874d6191b620e3261bef6864990db6ce' +
        '9806f66b7970fdff8617187bb9fffdff' +
        '5ae4df3edbd5d35e5b4f09020db03eab' +
        '1e031dda2fbe03d1792170a0f3009cee',
    );
  });

  it('carries the counter from the low 64 bits into the high ones, as a 128-bit big-endian integer', () => {
    const key = Buffer.alloc(16, 1);
    const data = Buffer.alloc(48);
    const wrapped = aesCtr(key, Buffer.from('000000000000000affffffffffffffff', 'hex'), data);
    const second = aesCtr(key, Buffer.from('000000000000000b0000000000000000', 'hex'), data.subarray(0, 16));
    expect(wrapped.subarray(16, 32).equals(second)).toBe(true);
  });

  it('refuses a key or a counter block of the wrong size', () => {
    expect(() => aesCtr(Buffer.alloc(15), Buffer.alloc(16), Buffer.alloc(1))).toThrow(RangeError);
    expect(() => aesCtr(Buffer.alloc(16), Buffer.alloc(8), Buffer.alloc(1))).toThrow(RangeError);
  });
});

describe('CENC sample encryption (scheme cenc)', () => {
  const key = Buffer.alloc(16, 7);
  const sample = Buffer.from('a sample of more than one AES block, so the block counter runs');

  it('uses the IV followed by a 64-bit zero block counter as the counter block, and is its own inverse', () => {
    const iv = ivForSample(5);
    const encrypted = encryptSample(key, iv, sample);
    expect(encrypted).toHaveLength(sample.length);
    expect(encrypted.equals(sample)).toBe(false);
    expect(aesCtr(key, Buffer.concat([iv, Buffer.alloc(8)]), sample).equals(encrypted)).toBe(true);
    expect(encryptSample(key, iv, encrypted).equals(sample)).toBe(true);
    expect(encryptSample(key, ivForSample(6), sample).equals(encrypted)).toBe(false);
  });

  it('gives sample i the IV i: eight bytes, big endian, refusing an index that is not a non-negative safe integer', () => {
    expect(ivForSample(0).toString('hex')).toBe('0000000000000000');
    expect(ivForSample(0x1_0000_0001).toString('hex')).toBe('0000000100000001');
    expect(CENC_IV_SIZE).toBe(8);
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) expect(() => ivForSample(bad)).toThrow(RangeError);
    expect(() => encryptSample(key, Buffer.alloc(16), sample)).toThrow(/IV is 8 bytes/);
  });

  it('encrypts a track in order with distinct IVs and keeps every other property of the samples', () => {
    const samples = [0, 1, 2].map((n) => ({ data: Buffer.from(`sample ${n}`), sync: n === 0, tag: `t${n}` }));
    const out = encryptSamples(samples, key);
    expect(out.map((s) => s.tag)).toEqual(['t0', 't1', 't2']);
    expect(out.map((s) => s.sync)).toEqual([true, false, false]);
    expect(out.map((s) => Number(s.iv.readBigUInt64BE()))).toEqual([0, 1, 2]);
    out.forEach((s, i) =>
      expect(encryptSample(key, s.iv, s.data).equals((samples[i] as { data: Buffer }).data)).toBe(true),
    );
    expect(samples[0]?.data.toString()).toBe('sample 0'); // the input is not modified
  });
});

describe('protectInit', () => {
  it('refuses a key id that is not 16 bytes, and an init segment that has no sample description to protect', () => {
    expect(() => protectInit(box('moov'), Buffer.alloc(15))).toThrow(RangeError);
    expect(() =>
      protectInit(Buffer.concat([box('ftyp'), box('moov', box('mvhd'))]), Buffer.alloc(16)),
    ).toThrow(BoxError);
  });
});
