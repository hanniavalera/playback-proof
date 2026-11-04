// Time and text helpers shared by the manifest builders: ISO 8601 durations and timestamps, tick conversions, XML escaping.
// Pure functions, tested in tests/unit/media/time.test.ts.

/**
 * ISO 8601 duration with millisecond resolution, as DASH and its schema want it: 2 -> "PT2S", 60 -> "PT1M", 60.0107 -> "PT1M0.011S",
 * 3661.5 -> "PT1H1M1.5S", 0 -> "PT0S". Hours are not folded into days (xs:duration allows "PT36H").
 */
export function isoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new RangeError(`isoDuration: invalid duration ${seconds}`);
  let ms = Math.round(seconds * 1000);
  if (ms === 0) return 'PT0S';
  const hours = Math.floor(ms / 3_600_000);
  ms -= hours * 3_600_000;
  const minutes = Math.floor(ms / 60_000);
  ms -= minutes * 60_000;
  const wholeSeconds = Math.floor(ms / 1000);
  const fraction = ms - wholeSeconds * 1000;
  let out = 'PT';
  if (hours > 0) out += `${hours}H`;
  if (minutes > 0) out += `${minutes}M`;
  if (wholeSeconds > 0 || fraction > 0) {
    out +=
      fraction > 0
        ? `${wholeSeconds}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}S`
        : `${wholeSeconds}S`;
  }
  return out;
}

/** ISO 8601 UTC timestamp with milliseconds ("2026-11-03T23:00:00.000Z"): DASH availabilityStartTime / publishTime, HLS program date time. */
export function isoTimestamp(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new RangeError('isoTimestamp: invalid Date');
  return date.toISOString();
}

/** Wall-clock instant of a media time: `origin` plus `ticks / timescale` seconds, rounded to the millisecond. */
export function instantAt(origin: Date, ticks: number, timescale: number): Date {
  if (!(timescale > 0)) throw new RangeError(`instantAt: invalid timescale ${timescale}`);
  return new Date(origin.getTime() + Math.round((ticks * 1000) / timescale));
}

/** Seconds as a fixed-decimal string (HLS EXTINF uses 6 decimals: microsecond resolution, so 94 AAC frames read 2.005333). */
export function formatSeconds(ticks: number, timescale: number, decimals: number): string {
  if (!(timescale > 0)) throw new RangeError(`formatSeconds: invalid timescale ${timescale}`);
  return (ticks / timescale).toFixed(decimals);
}

/** Escapes a value for use inside a double-quoted XML attribute. Characters XML 1.0 cannot represent are an error, not a silent drop. */
export function xmlEscape(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) {
    throw new RangeError(
      `xmlEscape: value contains a character that is not allowed in XML: ${JSON.stringify(value)}`,
    );
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

/** Greatest common divisor of two non-negative integers. */
export function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
