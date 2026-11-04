import type { ClearKeyParam, PlayerPageParams } from '../shared/qa.ts';

// Query parameters of the player page (`PlayerPageParams`, built by `playerUrl` in src/shared/urls.ts). Parsing is lenient
// about unknown parameters (other tools add cache busters) and strict about known ones: a value the page cannot use is
// reported, so a typo such as `muted=yes` cannot silently change what a test measures.

export type ConfigId = NonNullable<PlayerPageParams['config']>;

/** `PlayerPageParams` with every default applied. */
export interface ResolvedPlayerParams {
  manifest: string | null;
  config: ConfigId;
  autoplay: boolean;
  muted: boolean;
  start: number | null;
  abr: boolean;
  hud: boolean;
  clearKey: ClearKeyParam | null;
}

export const PARAM_DEFAULTS: ResolvedPlayerParams = {
  manifest: null,
  config: 'A',
  autoplay: true,
  muted: true,
  start: null,
  abr: true,
  hud: false,
  clearKey: null,
};

export interface ParsedParams {
  params: ResolvedPlayerParams;
  /** One sentence per parameter that was present but unusable (and was ignored). */
  problems: string[];
}

const TRUE_WORDS = new Set(['1', 'true']);
const FALSE_WORDS = new Set(['0', 'false']);
const HEX_DIGITS = /^[0-9a-f]*$/i;
const KEY_HEX_LENGTH = 32;

/**
 * `<key id>:<key>`, 16 bytes each as 32 hex digits, or the reason it cannot be used. A reason never repeats the value it refused: a
 * mistyped real key must not end up in an error event or a report.
 */
function readClearKey(raw: string): ClearKeyParam | string {
  const parts = raw.split(':');
  if (parts.length !== 2)
    return `clearKey must be <key id>:<key>, separated by one colon (found ${parts.length} part${parts.length === 1 ? '' : 's'}): no key is configured`;
  const [keyId = '', key = ''] = parts;
  for (const [name, value] of [
    ['key id', keyId],
    ['key', key],
  ] as const) {
    if (value.length !== KEY_HEX_LENGTH || !HEX_DIGITS.test(value))
      return `the ${name} of clearKey must be ${KEY_HEX_LENGTH} hex digits (it has ${value.length} characters${HEX_DIGITS.test(value) ? '' : ', not all of them hex digits'}): no key is configured`;
  }
  return { keyId: keyId.toLowerCase(), key: key.toLowerCase() };
}

/** What Shaka's `drm.clearKeys` holds for a pair (a map from key id to key, both hex): nothing without one. Configured before the load. */
export function clearKeyPatch(pair: ClearKeyParam | null): { drm?: { clearKeys: Record<string, string> } } {
  return pair ? { drm: { clearKeys: { [pair.keyId]: pair.key } } } : {};
}

/**
 * The query string without `clearKey` (`''` when nothing else is left), or null when it had none. The page puts this back into the
 * address bar once it has read the pair: a browser repeats the page's URL in some of its own console messages (Firefox does, in its
 * warning about `requestMediaKeySystemAccess`), and the key is public but stays out of logs.
 */
export function withoutClearKey(search: string): string | null {
  const query = new URLSearchParams(search);
  if (!query.has('clearKey')) return null;
  query.delete('clearKey');
  const rest = query.toString();
  return rest === '' ? '' : `?${rest}`;
}

export function parsePlayerParams(search: string | URLSearchParams): ParsedParams {
  const query = typeof search === 'string' ? new URLSearchParams(search) : search;
  const params: ResolvedPlayerParams = { ...PARAM_DEFAULTS };
  const problems: string[] = [];

  const flag = (name: 'autoplay' | 'muted' | 'abr' | 'hud'): void => {
    const raw = query.get(name);
    if (raw === null) return;
    const word = raw.toLowerCase();
    if (TRUE_WORDS.has(word)) params[name] = true;
    else if (FALSE_WORDS.has(word)) params[name] = false;
    else
      problems.push(
        `${name}=${JSON.stringify(raw)} is not 1/0 (or true/false): using ${PARAM_DEFAULTS[name]}`,
      );
  };
  flag('autoplay');
  flag('muted');
  flag('abr');
  flag('hud');

  const manifest = query.get('manifest');
  if (manifest !== null) {
    if (manifest.trim() === '') problems.push('manifest is empty: the page stays idle until qa.load(uri)');
    else params.manifest = manifest;
  }

  const config = query.get('config');
  if (config !== null) {
    const id = config.toUpperCase();
    if (id === 'A' || id === 'B') params.config = id;
    else problems.push(`config=${JSON.stringify(config)} is not A or B: using ${PARAM_DEFAULTS.config}`);
  }

  const start = query.get('start');
  if (start !== null) {
    // Number('') is 0, which would silently mean "start at 0": an empty value is a mistake, not a position.
    const seconds = start.trim() === '' ? Number.NaN : Number(start);
    if (Number.isFinite(seconds) && seconds >= 0) params.start = seconds;
    else
      problems.push(
        `start=${JSON.stringify(start)} is not a number of seconds >= 0: starting at the default position`,
      );
  }

  const clearKey = query.get('clearKey');
  if (clearKey !== null) {
    const pair = readClearKey(clearKey);
    if (typeof pair === 'string') problems.push(pair);
    else params.clearKey = pair;
  }

  return { params, problems };
}
