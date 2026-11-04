// The error signature: what a failure is called so that the same cause is the same name. It is the first line of the message with
// everything that changes from run to run (numbers, ids, timestamps, ports, urls, paths) replaced by a placeholder. The flake
// reporter records it for every failed attempt; failure triage (Phase 8) clusters CI failures by it, so there is one function.
//
// It is deliberately blunt. It does not look at the stack, because the first line of a message is what a person reads first and
// the lines below it are mostly values (`Expected: >= 3`, `Received: 2.4`) and timelines. Two causes that read alike in their first
// line are one signature, and the limit is stated rather than hidden: `docs/FLAKE.md`, "What the signature cannot tell".

/** Longer first lines are cut: the history keeps a line per run, and a signature that long is a message, not a name. */
export const SIGNATURE_MAX_LENGTH = 200;

export const NO_MESSAGE_SIGNATURE = 'no error message';

const ESC = String.fromCharCode(27);
/** Colour and cursor sequences: Playwright colours the words of an assertion in a terminal and in a CI log. */
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');

const URL_LIKE = /\b(?:https?|wss?|file):\/\/[^\s)"'\]>}]+/gi;
// A path of two or more segments that does not continue a word (`and/or`, `1/2/3`): the directories go, the file name stays.
const PATH_LIKE = /(?<![\w.<>])(?:[A-Za-z]:)?(?:[\\/][^\s\\/:'"`()<>|,;]+){2,}/g;
const DATE_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ADDRESS = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const HEX_LITERAL = /\b0x[0-9a-f]+\b/gi;
// Eight or more hex digits, at least one of them a letter: a session id (`1a2b3c4d5e6f`), a content hash. All digits is a number.
const HEX_ID = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
// A number that does not belong to a word (`vp09`, `h264`, `mp4a.40.2` keep theirs) or to a catalog id (`PB-VOD-001`).
const NUMBER = /(?<![\w.]|[A-Za-z]-)\d+(?:\.\d+)*/g;

/** The first non-empty line of a message, without colour codes. */
export function firstLine(message: string): string {
  for (const line of message.replace(ANSI, '').split(/\r?\n/)) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

/**
 * One line with everything that changes from run to run replaced by a placeholder, not yet cut to `SIGNATURE_MAX_LENGTH`. It is the
 * step `errorSignature` is made of, exposed so that failure triage (`triage/signature.ts`) can add its own steps on top of the same
 * normalisation (collapsing a list, naming what the three engines word differently) before it cuts: one normalisation, not two.
 */
export function normaliseLine(line: string): string {
  return line
    .replace(URL_LIKE, '<url>')
    .replace(PATH_LIKE, (path) => `<path>/${path.split(/[\\/]/).pop() ?? ''}`)
    .replace(DATE_TIME, '<ts>')
    .replace(CLOCK, '<ts>')
    .replace(UUID, '<id>')
    .replace(ADDRESS, '<addr>')
    .replace(HEX_LITERAL, '<hex>')
    .replace(HEX_ID, '<id>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cut that makes a signature a name and not a message: `SIGNATURE_MAX_LENGTH` characters, the last one `…` when it was cut. */
export function cutSignature(normalised: string): string {
  return normalised.length > SIGNATURE_MAX_LENGTH
    ? `${normalised.slice(0, SIGNATURE_MAX_LENGTH - 1)}…`
    : normalised;
}

/**
 * The signature of an error message. Equal causes give equal signatures whatever their ids, numbers, timestamps, ports and paths;
 * different causes give different ones as long as their first lines differ in words. Applying it to a signature changes nothing.
 */
export function errorSignature(message: string | null | undefined): string {
  const line = firstLine(message ?? '');
  if (line === '') return NO_MESSAGE_SIGNATURE;
  return cutSignature(normaliseLine(line));
}

/** What Playwright's `TestError` gives: a message, or only a stack, or the value that was thrown when it was not an Error. */
export interface ErrorLike {
  message?: string | undefined;
  stack?: string | undefined;
  value?: string | undefined;
}

/** The signature of an error object: its message, else the head of its stack, else the thrown value. */
export function signatureOfError(error: ErrorLike | null | undefined): string {
  if (!error) return NO_MESSAGE_SIGNATURE;
  return errorSignature(error.message || error.stack || error.value);
}
