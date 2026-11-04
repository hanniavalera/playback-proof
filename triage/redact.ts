// Redaction: what is taken out of the evidence before any of it leaves this machine for a language model (docs/TRIAGE.md, ADR-166).
// It is the second line of defence. The first is that nothing leaves at all unless a person asked (`--summarize`) and that the evidence is
// a short digest (a representative message, a few events, the codes), never a page, a trace or a log. The third is the check just before
// a request is sent (`containsSecret`): a request that still carries the text of a secret is not sent.
//
// Patterns find what has a SHAPE: an API key, a token, a password assignment, a URL's query, a home directory, an email, an address. A
// hostname with no dot, a secret that looks like prose, a name inside a sentence are not found by any pattern: the limits are written in
// docs/TRIAGE.md and are the reason the evidence is small.

export interface SecretPattern {
  name: string;
  /** Without the `g` flag: a pattern is tested with it, and made global where it replaces. */
  pattern: RegExp;
}

/**
 * What an outgoing request must never contain, tested on the exact text that is sent. The key of the run is one of them by construction
 * (`sk-ant-...`); the others are what a failure message or a console line could carry. The tests plant each kind and look for it on the wire.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'payment-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { name: 'basic-credentials', pattern: /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/])/ },
  { name: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    name: 'secret-assignment',
    pattern:
      /\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s,;&"'<>]{6,})/i,
  },
  { name: 'long-hex', pattern: /\b[0-9a-f]{32,}\b/i },
];

/** The name of the first secret pattern that matches `text`, or null. */
export function containsSecret(text: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

const globally = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

// The tokens that have a format of their own are replaced by their name; the others have a step of their own below.
const NAMED_TOKENS = new Set([
  'anthropic-api-key',
  'api-key',
  'github-token',
  'aws-access-key-id',
  'google-api-key',
  'slack-token',
  'payment-key',
  'npm-token',
  'jwt',
  'bearer-token',
  'basic-credentials',
]);

const TLDS = 'com|net|org|io|dev|app|cloud|internal|local|lan|corp|intranet|home|localdomain|edu|gov|int';

// A URL is read as scheme, authority, path, query, fragment. A part is made of ordinary characters or of the placeholder an earlier step
// left in it (`<anthropic-api-key>`), so that redacting a second time reads the same URL and changes nothing.
const PLACEHOLDER = '<[a-z-]+>';
const URL_PART = (stop: string): string => `(?:${PLACEHOLDER}|[^\\s${stop}'"\`)\\]}<>])*`;
const URL_PATTERN = new RegExp(
  `\\b((?:https?|wss?|ftp):\\/\\/)(${URL_PART('/?#')})(${URL_PART('?#')})(\\?${URL_PART('#')})?(#${URL_PART('')})?`,
  'gi',
);

interface Step {
  /** What it takes out. Named so that a test can say which step broke. */
  name: string;
  apply(text: string): string;
}

const replacing = (name: string, pattern: RegExp, replacement: string): Step => ({
  name,
  apply: (text) => text.replace(pattern, replacement),
});

/**
 * The steps, in order. The order is part of the behaviour: secrets go before anything that could split them (a URL's query holds tokens),
 * URLs before hostnames and addresses (the host of a URL is replaced with its path kept), CI workspaces before home directories (a runner's
 * workspace lives under a home).
 */
export const STEPS: readonly Step[] = [
  replacing(
    'private-key-block',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '<private-key>',
  ),
  replacing(
    'secret-headers',
    /\b(authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie|proxy-authorization)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    '$1$2<redacted>',
  ),
  ...SECRET_PATTERNS.filter(({ name }) => NAMED_TOKENS.has(name)).map(({ name, pattern }) =>
    replacing(name, globally(pattern), `<${name}>`),
  ),
  {
    // The scheme and the path stay (what was asked of the service is evidence); the host, the credentials, the query and the fragment go.
    name: 'url',
    apply: (text) =>
      text.replace(
        URL_PATTERN,
        (_whole, scheme: string, _authority: string, path: string, query?: string, fragment?: string) =>
          `${scheme}<host>${path}${query ? '?<query>' : ''}${fragment ? '#<fragment>' : ''}`,
      ),
  },
  replacing('url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<credentials>@'),
  replacing(
    'secret-assignment',
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;&"'<>]{4,})/gi,
    '$1<redacted>',
  ),
  replacing('long-hex', /\b[0-9a-f]{32,}\b/gi, '<hex>'),
  replacing('email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>'),
  replacing('ipv4', /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'),
  // A name with at least one dot that ends in a TLD of the list: `jenkins-3.corp.internal`, `runner.example.com`. Not `README.md`, not
  // `a.json`, not `shaka.net.NetworkingEngine` (Shaka's own namespaces are in the messages of its errors).
  replacing(
    'hostname',
    new RegExp(
      String.raw`\b(?!shaka\.)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:${TLDS})\b`,
      'gi',
    ),
    '<host>',
  ),
  replacing('localhost', /\blocalhost\b/gi, '<host>'),
  replacing(
    'ci-workspace',
    /(?:\/home\/runner\/work\/[^\s/]+\/[^\s/]+|\/github\/workspace|\/home\/jenkins\/agent\/workspace\/[^\s/]+|\/var\/lib\/jenkins\/workspace\/[^\s/]+)(?=\/|\\|\b)/g,
    '<workspace>',
  ),
  replacing('home-windows', /[A-Za-z]:\\Users\\[^\\\s'"`]+/g, '<home>'),
  replacing('home-macos', /\/Users\/[^\s/'"`]+/g, '<home>'),
  replacing('home-linux', /\/home\/[^\s/'"`]+/g, '<home>'),
  replacing('home-root', /(?<![\w/.-])\/root(?=\/|\b)/g, '<home>'),
  {
    // Absolute paths of a machine (not the path of a URL, which starts with the lab's own segments): the directories go, the file name stays.
    name: 'system-path',
    apply: (text) =>
      text.replace(
        /(?<![\w<>.:/-])\/(?:var|tmp|opt|usr|etc|mnt|srv|private|Volumes|Applications|builds|snap|nix|run|media)\/[^\s'"`<>()]+/g,
        (path) => `<path>/${path.split('/').pop() ?? ''}`,
      ),
  },
];

/**
 * The text with its secrets, and what identifies a machine or a person, taken out, each replaced by a name in angle brackets so that a
 * reader (a person, a model) can still see that something was there. Applying it twice changes nothing more.
 */
export function redact(text: string): string {
  return STEPS.reduce((out, step) => step.apply(out), text);
}

/** The same value with every string (and every key) redacted: the evidence of a cluster is a JSON-safe object, and it goes through here whole. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [redact(key), redactValue(item)]),
    ) as T;
  }
  return value;
}
