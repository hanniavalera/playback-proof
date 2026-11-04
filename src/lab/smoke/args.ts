import { parseArgs } from 'node:util';
import { ENGINE_NAMES } from '../probe/cli-args.ts';
import type { EngineName } from '../probe/cli-args.ts';

// Command line of tools/player-smoke.ts, parsed here so it can be unit-tested without starting a browser.

export const SMOKE_SESSIONS = [
  'vod-dash',
  'vod-hls',
  'live-dash',
  'live-hls',
  'actions',
  'recovery',
] as const;
export type SmokeSession = (typeof SMOKE_SESSIONS)[number];

export interface SmokeOptions {
  browsers: EngineName[];
  /** Service to use; undefined: the tool starts one on a port of its own. */
  origin?: string;
  repeat: number;
  /** The page's `muted` parameter. */
  muted: boolean;
  sessions: SmokeSession[];
  config: 'A' | 'B';
  /** Media seconds a session must play after its first frame. */
  mediaSeconds: number;
  /** Safety-net deadline of one wait, ms. Never a measurement. */
  timeoutMs: number;
  /** Result file (JSON). */
  out?: string;
  /** Pick the stream flavour from the committed codec matrix of this environment (default), or always use the defaults. */
  useCapabilities: boolean;
  help: boolean;
}

export class SmokeUsageError extends Error {
  override name = 'SmokeUsageError';
}

export const SMOKE_USAGE = `npx tsx tools/player-smoke.ts [options]      (npm run player:smoke -- [options])

Plays real sessions in real browsers through the player page and window.__qa, and prints what the hook measured.
Each session runs in its own browser process. Exit code 1 when any session fails.

  --browsers chromium,webkit   engines (default: chromium,webkit on macOS, all three elsewhere: Playwright's Firefox does not
                               start on macOS, run it with: npm run docker:pw -- npx tsx tools/player-smoke.ts --browsers firefox)
  --sessions a,b               ${SMOKE_SESSIONS.join(', ')} (default: all)
                                 vod-dash vod-hls live-dash live-hls: play a few media seconds, check what the hook reports
                                 actions:  pause and resume, a seek inside the buffer and one outside it, pin a rung, frame rate
                                 recovery: a segment that answers 404 once (the service's transient-404 profile)
  --repeat N                   run the whole matrix N times (default 1)
  --muted 0|1                  the page's muted parameter (default 1)
  --config A|B                 the player configuration (default A)
  --media-seconds S            media seconds to play after the first frame (default 3)
  --timeout MS                 safety-net deadline of each wait (default 20000)
  --origin URL                 use this service (default: start one on PB_PORT, 4640 when unset)
  --out FILE                   write the results as JSON
  --no-capabilities            do not choose streams from the committed codec matrix: always vod-cmaf and live-cmaf (the
                               Linux WebKit experiment needs this, the matrix marks that engine unsupported there)
  --help
`;

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new SmokeUsageError(`${flag} must be a positive integer, got "${value}"`);
  return Number(value);
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function parseSmokeArgs(argv: readonly string[], platform: string = process.platform): SmokeOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      allowNegative: true,
      options: {
        browsers: { type: 'string' },
        sessions: { type: 'string' },
        repeat: { type: 'string' },
        muted: { type: 'string' },
        config: { type: 'string' },
        'media-seconds': { type: 'string' },
        timeout: { type: 'string' },
        origin: { type: 'string' },
        out: { type: 'string' },
        capabilities: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new SmokeUsageError(error instanceof Error ? error.message : String(error));
  }

  const defaultBrowsers = ENGINE_NAMES.filter((name) => !(platform === 'darwin' && name === 'firefox'));
  const browsers = values.browsers === undefined ? [...defaultBrowsers] : list(values.browsers);
  if (browsers.length === 0) throw new SmokeUsageError('--browsers is empty');
  for (const name of browsers) {
    if (!(ENGINE_NAMES as readonly string[]).includes(name)) {
      throw new SmokeUsageError(`unknown browser "${name}" (expected ${ENGINE_NAMES.join(', ')})`);
    }
  }

  const sessions = values.sessions === undefined ? [...SMOKE_SESSIONS] : list(values.sessions);
  if (sessions.length === 0) throw new SmokeUsageError('--sessions is empty');
  for (const name of sessions) {
    if (!(SMOKE_SESSIONS as readonly string[]).includes(name)) {
      throw new SmokeUsageError(`unknown session "${name}" (expected ${SMOKE_SESSIONS.join(', ')})`);
    }
  }

  const muted = values.muted ?? '1';
  if (muted !== '0' && muted !== '1') throw new SmokeUsageError(`--muted must be 0 or 1, got "${muted}"`);

  const config = values.config ?? 'A';
  if (config !== 'A' && config !== 'B') throw new SmokeUsageError(`--config must be A or B, got "${config}"`);

  let mediaSeconds = 3;
  if (values['media-seconds'] !== undefined) {
    mediaSeconds = Number(values['media-seconds']);
    if (!Number.isFinite(mediaSeconds) || mediaSeconds <= 0) {
      throw new SmokeUsageError(`--media-seconds must be a number > 0, got "${values['media-seconds']}"`);
    }
  }

  return {
    browsers: [...new Set(browsers)] as EngineName[],
    ...(values.origin === undefined ? {} : { origin: values.origin }),
    repeat: values.repeat === undefined ? 1 : positiveInteger(values.repeat, '--repeat'),
    muted: muted === '1',
    sessions: [...new Set(sessions)] as SmokeSession[],
    config,
    mediaSeconds,
    timeoutMs: values.timeout === undefined ? 20_000 : positiveInteger(values.timeout, '--timeout'),
    ...(values.out === undefined ? {} : { out: values.out }),
    useCapabilities: values.capabilities ?? true,
    help: values.help ?? false,
  };
}
