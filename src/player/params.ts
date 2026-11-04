import type { PlayerPageParams } from '../shared/qa.ts';

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
}

export const PARAM_DEFAULTS: ResolvedPlayerParams = {
  manifest: null,
  config: 'A',
  autoplay: true,
  muted: true,
  start: null,
  abr: true,
  hud: false,
};

export interface ParsedParams {
  params: ResolvedPlayerParams;
  /** One sentence per parameter that was present but unusable (and was ignored). */
  problems: string[];
}

const TRUE_WORDS = new Set(['1', 'true']);
const FALSE_WORDS = new Set(['0', 'false']);

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

  return { params, problems };
}
