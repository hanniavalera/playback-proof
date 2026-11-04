import type { Session } from './sessions.ts';
import { createBucket } from './throttle.ts';
import type { Bucket } from './throttle.ts';

// The token buckets of a session: one per throttle rule, kept in `session.attachments` so that they live and die with the session and
// are shared by every response the rule matches (audio and video compete for one link, docs/CONTRACTS.md section 5).

interface Held {
  kbps: number;
  bucket: Bucket;
}

const PREFIX = 'bucket:';

/** The bucket of a rule. It is recreated when the rate of the rule changed: a new link, not a faster old one. */
export function bucketFor(session: Session, ruleId: string, kbps: number): Bucket {
  const key = PREFIX + ruleId;
  const held = session.attachments.get(key) as Held | undefined;
  if (held && held.kbps === kbps) return held.bucket;
  const bucket = createBucket(kbps);
  session.attachments.set(key, { kbps, bucket } satisfies Held);
  return bucket;
}

/**
 * Forgets the bucket of one rule, or of every rule. Called when rules are removed or replaced, so a rule that comes back under
 * the same id starts on a fresh link. Responses that are already being written keep the bucket they were given.
 */
export function forgetBuckets(session: Session, ruleId?: string): void {
  if (ruleId !== undefined) {
    session.attachments.delete(PREFIX + ruleId);
    return;
  }
  for (const key of [...session.attachments.keys()]) {
    if (key.startsWith(PREFIX)) session.attachments.delete(key);
  }
}
