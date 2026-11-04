import type { RungChange } from '../src/lab/measure/types.ts';

// The shapes of what the runner records and the analysis reads. Nothing here needs a browser.

export type ArmId = 'A' | 'B';
/** The page's configuration preset (src/player/configs.ts): A is Shaka's defaults, B is the three documented overrides. */
export type ConfigLetter = 'A' | 'B';

export type FailureKind = 'critical-error' | 'timeout' | 'page';

export interface SessionFailure {
  kind: FailureKind;
  message: string;
}

/** What `qa.info()` said about the player of the session: the proof that the arm really ran the configuration it was meant to. */
export interface SessionInfoRecord {
  config: string;
  configOverrides: Record<string, unknown>;
  configDefaults: Record<string, unknown>;
  loadMode: string | null;
  userAgent: string;
}

/**
 * What the service says about the condition of a session, read from its own state and its request log after the observation: the proof
 * that both arms met the SAME condition, and that the condition was really applied (a rule that never fired is a condition that was not).
 */
export interface ConditionEvidence {
  /** The rules the service held for the session (without the ids it gave them) are exactly the rules of the pre-registration. */
  rulesMatch: boolean;
  /** Requests the service logged for the session. */
  requests: number;
  /** For each rule of the condition, in order: how many logged requests it fired on. */
  fired: number[];
}

/** One session: one fresh browser context, one service session, one player. */
export interface SessionRecord {
  /** 0-based order of execution within the condition (warm-up included). */
  index: number;
  /** 0-based pair of sessions (one of each arm); the arm that goes first alternates from block to block. */
  block: number;
  arm: ArmId;
  config: ConfigLetter;
  condition: string;
  /** A warm-up session is executed like the others, recorded, and left out of every statistic. */
  warmup: boolean;
  status: 'ok' | 'failed';
  failure?: SessionFailure;
  /** The metrics of the session (docs/METRICS.md): startupMs, manifestMs, rebufferCount, rebufferMs, rebufferRatio, switches, droppedRatio. Null: could not be measured. */
  values: Record<string, number | null>;
  /** The height of the rung the player started on, null when it was not recorded. */
  startRungHeight: number | null;
  /** Every change of the active rung, the start included. */
  rungs: RungChange[];
  /** The Shaka error events of the session, as `code name/severity`. */
  errors: string[];
  info: SessionInfoRecord | null;
  /** The id of the session on the test data service (its request log was available while it lived). */
  sessionId: string | null;
  /** What the service said about the condition of this session (absent for a session that failed before it could be read). */
  applied?: ConditionEvidence;
  startedAt: string;
  durationMs: number;
}
