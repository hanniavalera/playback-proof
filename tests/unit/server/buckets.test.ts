import { describe, expect, it } from 'vitest';
import { bucketFor, forgetBuckets } from '../../../src/server/buckets.ts';
import { SessionStore, parseSessionRequest } from '../../../src/server/sessions.ts';
import type { Session } from '../../../src/server/sessions.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { FAKE_VOD, createFakeMedia } from './fake-media.ts';

function newSession(): Session {
  const parsed = parseSessionRequest({ stream: FAKE_VOD }, createFakeMedia().streams());
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return new SessionStore({ clock: new ManualClock() }).create(parsed.value);
}

describe('the token buckets of a session', () => {
  it('gives every response of a rule the same bucket: that is what makes two responses share a link', () => {
    const session = newSession();
    expect(bucketFor(session, 'f1', 1500)).toBe(bucketFor(session, 'f1', 1500));
  });

  it('gives each rule its own bucket, and each session its own', () => {
    const a = newSession();
    const b = newSession();
    expect(bucketFor(a, 'f1', 1500)).not.toBe(bucketFor(a, 'f2', 1500));
    expect(bucketFor(a, 'f1', 1500)).not.toBe(bucketFor(b, 'f1', 1500));
  });

  it('recreates the bucket of a rule whose rate changed: a new link, not a faster old one', () => {
    const session = newSession();
    const slow = bucketFor(session, 'f1', 800);
    const fast = bucketFor(session, 'f1', 3000);
    expect(fast).not.toBe(slow);
    expect(fast.kbps).toBe(3000);
    expect(bucketFor(session, 'f1', 3000)).toBe(fast);
  });

  it('forgets one rule or all of them, and only buckets', () => {
    const session = newSession();
    session.attachments.set('something-else', 42);
    const f1 = bucketFor(session, 'f1', 800);
    const f2 = bucketFor(session, 'f2', 800);
    forgetBuckets(session, 'f1');
    expect(bucketFor(session, 'f1', 800)).not.toBe(f1);
    expect(bucketFor(session, 'f2', 800)).toBe(f2);
    forgetBuckets(session);
    expect(bucketFor(session, 'f2', 800)).not.toBe(f2);
    expect(session.attachments.get('something-else')).toBe(42);
  });
});
