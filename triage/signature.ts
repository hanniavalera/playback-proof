import { createHash } from 'node:crypto';
import { cutSignature, firstLine, NO_MESSAGE_SIGNATURE, normaliseLine } from '../src/lab/signature.ts';
import { isSpecFile } from './stack.ts';
import { stripAnsi } from './text.ts';
import type { Failure, SignatureParts } from './types.ts';

// The signature of a failure: what it is called so that the same root cause has the same name whatever its ids, timestamps, ports, paths
// and engine. It is made of four stable parts and nothing else (docs/TRIAGE.md, ADR-160 to ADR-162):
//
//   message    the first line of the error message, normalised by the lab's one error signature (src/lab/signature.ts: numbers, ids,
//              timestamps, urls, paths), then three steps that only triage needs: the words the three engines use for the same network
//              failure are one phrase, a rung id (`v360`) is `<rung>`, and a list of identical items is its first item and `…`
//   assertion  the matcher that failed (`toBeLessThanOrEqual`), `test-timeout`, or `thrown`: the message of a lab assertion has its own
//              words, but the matcher says what kind of thing was checked
//   location   `file:function` of the helper that threw, no line number (a line moves with every edit, and the signature names a cause, not
//              a revision). A spec's own body names the test, not the cause, so it is left out: the same cause seen from ten specs is one
//              signature. When the message has no words of its own (`expect(received).toBe(expected)`, `Test timeout of 45000ms
//              exceeded.`) the spec file IS added, because without it unrelated failures would be one cluster
//   shaka      the critical Shaka error the player reported, if any: its code (the same symptom with a 1001 and with a 4001 is two causes), or
//              `media` for any error of the media category, because the engines word the same corrupt bytes with different codes (a real
//              run: 3015 in WebKit, 3016 in Chromium)

/** What the three engines call the same network failure. Chromium's words are the ones the lab has seen; see docs/TRIAGE.md for the rest. */
const ENGINE_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /net::ERR_CONNECTION_REFUSED(?: at \S+)?|NS_ERROR_CONNECTION_REFUSED|Could not connect to the server\.?/g,
    'connection refused',
  ],
  [
    /net::ERR_CONNECTION_RESET(?: at \S+)?|net::ERR_EMPTY_RESPONSE(?: at \S+)?|NS_ERROR_NET_RESET|The network connection was lost\.?/g,
    'connection reset',
  ],
];

/**
 * The engine a test ran in is not part of its cause, and some lab messages name it (the environment check says `chromium 156 in
 * local-darwin-arm64 could not play ...`): the same failure in two engines must be one cluster listing both, so the names of Playwright's
 * projects are `<engine>` and the id of the environment is `<env>`. Seen on a real run: the check failed in two engines for one cause and
 * made two clusters.
 */
const ENGINE_NAME = /\b(?:chromium-cpu4x|chromium|firefox|webkit)\b/gi;
const ENVIRONMENT_ID = /\b[a-z][a-z0-9]*-(?:darwin|linux|win32)-[a-z0-9]+\b/g;

/**
 * The lab's fault messages quote the whole rule as JSON before the sentence that says what happened (`the fault rule f1 {"type":"status",
 * "match":{...},"times":3,...} named 0 of the 3 requests it was waited for within 15000 ms: the player never asked for ...`). The rule is in
 * the evidence; in the signature it is 150 characters that push the words that tell one cause from another past the cut. A real run merged
 * two causes there: a fault never felt because the origin was down, and a fault felt and not recovered.
 */
const FAULT_RULE_JSON = /(\bthe fault rule \S+ )\{.*\}( named\b)/;

/** The lab's own rung ids (`v240`, `v360`, `v720`): engines start on different rungs, and one cause must not split by the rung it hit. */
const RUNG = /\bv\d{3,4}\b/g;

/** A fault rule id (`f1`, `f12`): the service numbers the rules of a session in order, so the same rule is `f1` in one test and `f2` in another. */
const RULE_ID = /\bf\d{1,3}\b/g;

/** Shaka's error category for the media pipeline (`shaka.util.Error.Category.MEDIA`): the browser's own append and decode errors. */
const MEDIA_CATEGORY = 3;

/** A line that is only an error class (`Error:`, `TypeError:`): the message continues on the next line. */
const BARE_CLASS = /^\s*[A-Za-z]*Error:?\s*$/;

/** The first line of a message that says something: a bare `Error:` is joined with the line after it. */
export function meaningfulFirstLine(message: string): string {
  const lines = stripAnsi(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const first = lines[0] ?? '';
  if (BARE_CLASS.test(first) && lines[1] !== undefined) return `${first.replace(/:$/, '')}: ${lines[1]}`;
  return first;
}

/**
 * Runs of identical `; `-separated items become the item and `…`: "saw 2" and "saw 3" rebuffers are one assertion failing. The first item
 * carries the head of the sentence (`...saw <n> totalling <n> ms: at media time <n> s for <n> ms`), so it is compared by what follows its
 * last `: `.
 */
export function collapseRepeats(text: string): string {
  const items = text.split('; ');
  if (items.length < 2) return text;
  const head = items[0] as string;
  const cut = head.lastIndexOf(': ');
  const prefix = cut >= 0 ? head.slice(0, cut + 2) : '';
  const list = [cut >= 0 ? head.slice(cut + 2) : head, ...items.slice(1)];
  const out: string[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[i]) j += 1;
    out.push(list[i] as string);
    if (j > i) out.push('…');
    i = j + 1;
  }
  return `${prefix}${out.join('; ')}`;
}

/** The message part of a signature. */
export function messageSignature(message: string | null | undefined): string {
  const line = meaningfulFirstLine(message ?? '');
  if (line === '') return NO_MESSAGE_SIGNATURE;
  const neutral = ENGINE_WORDING.reduce((text, [pattern, phrase]) => text.replace(pattern, phrase), line)
    .replace(FAULT_RULE_JSON, '$1{…}$2')
    .replace(ENVIRONMENT_ID, '<env>')
    .replace(ENGINE_NAME, '<engine>');
  return cutSignature(
    collapseRepeats(normaliseLine(neutral).replace(RUNG, '<rung>').replace(RULE_ID, '<rule>')),
  );
}

const MATCHER = /\bexpect\((?:received|[^)]*)\)\s*\.\s*(not\.)?([A-Za-z]\w*)\(/;
const TEST_TIMEOUT = /^(?:Error: )?Test timeout of \d+ms exceeded/;

/** What kind of check failed: the matcher of an `expect` (`not.toBe`), `test-timeout`, or `thrown` for everything else. */
export function assertionKind(message: string): string {
  const text = stripAnsi(message);
  if (TEST_TIMEOUT.test(meaningfulFirstLine(text))) return 'test-timeout';
  const matcher = MATCHER.exec(text);
  if (matcher) return `${matcher[1] ?? ''}${matcher[2]}`;
  return 'thrown';
}

/** A message with no words of its own: its signature would also name every unrelated failure of the same kind. */
export function isGeneric(signatureMessage: string, assertion: string): boolean {
  if (signatureMessage === NO_MESSAGE_SIGNATURE || assertion === 'test-timeout') return true;
  return (
    /^(?:Error: )?expect\(/.test(signatureMessage) ||
    /^(?:Error: )?Timeout <n>ms exceeded\.?$/.test(signatureMessage)
  );
}

/** The location part: a helper that threw is the check that failed; a spec body is only the test, unless the message says nothing. */
export function locationOf(failure: Pick<Failure, 'file' | 'error'>, generic: boolean): string | null {
  const top = failure.error.frames[0];
  if (top && !isSpecFile(top.file)) return top.fn ? `${top.file}:${top.fn}` : top.file;
  if (generic && failure.file !== '') return failure.file;
  return null;
}

export function signatureParts(
  failure: Pick<Failure, 'scope' | 'file' | 'error' | 'diagnostics'>,
): SignatureParts {
  const message = messageSignature(failure.error.message);
  const assertion = assertionKind(failure.error.message);
  const generic = isGeneric(message, assertion);
  const primary = failure.diagnostics.primaryError;
  const code = primary?.code ?? 0;
  return {
    message,
    assertion,
    location: failure.scope === 'run' ? null : locationOf(failure, generic),
    shaka: code > 0 ? (primary?.category === MEDIA_CATEGORY ? 'media' : String(code)) : null,
  };
}

/** The one-line form of the parts: `<message> [<assertion>] @ <location> {shaka <code>}`. */
export function formatSignature(parts: SignatureParts): string {
  return [
    parts.message,
    `[${parts.assertion}]`,
    ...(parts.location === null ? [] : [`@ ${parts.location}`]),
    ...(parts.shaka === null ? [] : [`{shaka ${parts.shaka}}`]),
  ].join(' ');
}

/** A short, stable name for a signature (the cluster key and the name of its cache file): 12 hex digits of its SHA-256. */
export function signatureKey(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 12);
}

export interface FailureSignature {
  parts: SignatureParts;
  signature: string;
  key: string;
}

export function failureSignature(
  failure: Pick<Failure, 'scope' | 'file' | 'error' | 'diagnostics'>,
): FailureSignature {
  const parts = signatureParts(failure);
  const signature = formatSignature(parts);
  return { parts, signature, key: signatureKey(signature) };
}

/** The first line of the message as a person reads it, for a table cell: not normalised. */
export function readableFirstLine(message: string): string {
  const line = meaningfulFirstLine(message);
  return line === '' ? firstLine(message) || NO_MESSAGE_SIGNATURE : line;
}
