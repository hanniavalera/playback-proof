import type { Environment } from '../support/gaps.ts';

// Documented gaps of EME, in the style of tests/e2e/support/gaps.ts: an engine that cannot run the ClearKey test is skipped with a
// reason that starts with `documented gap in <environment id>:`, names the evidence and points at where it is written. The support
// library's gaps are decided from the codec probe's committed results, which know nothing about EME; this one is decided from the
// measurement of ADR-105 (docs/decisions/e2e-eme.md), which the spec RE-CHECKS on every run before it skips (see eme.spec.ts).

/** The error the player raises when the browser has no EME at all (Shaka's `MISSING_EME_SUPPORT`, 6020). */
export const NO_EME_ERROR = 'MISSING_EME_SUPPORT';

/**
 * Why the ClearKey test cannot run in this engine here, or null. Linux WebKit (the Playwright image's build, WebKit 27.2, measured on
 * 2026-11-04): `navigator.requestMediaKeySystemAccess` does not exist, so Shaka refuses an encrypted stream at load with 6020.
 */
export function emeGap(env: Pick<Environment, 'envId' | 'engine' | 'platform'>): string | null {
  if (env.engine === 'webkit' && env.platform === 'linux') {
    return `documented gap in ${env.envId}: webkit has no Encrypted Media Extensions here (navigator.requestMediaKeySystemAccess does not exist, so the player refuses the encrypted stream at load with ${NO_EME_ERROR}); measured with Playwright 1.64.1, WebKit 27.2: ADR-105 in docs/decisions/e2e-eme.md`;
  }
  return null;
}
