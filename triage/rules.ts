import { meaningfulFirstLine } from './signature.ts';
import { oneLine, stripAnsi } from './text.ts';
import type { Category, Failure, FailureClass, RuleVerdict, ShakaErrorDigest } from './types.ts';

// The root-cause categories, as a table of named rules (docs/TRIAGE.md, ADR-163 to ADR-165). A rule looks at one failure, and either says
// what it found (the evidence, as lines a person can check against the attachments) or says nothing. The FIRST rule that finds something
// wins, so the order is part of the contract: the rules that name a cause come before the ones that only describe a symptom (a test that
// timed out waiting for the first frame is a symptom of a fault that the player did not recover from, so the fault comes first).
//
// To add a rule: write it here, in the place of its strength in the order, with the one line that says why this evidence means this
// cause, and give it a test in tests/unit/triage/rules.test.ts (a failure that fires it, a near miss that does not, and the order).

export interface RuleInput {
  failure: Failure;
  /** The whole message, without colour codes. */
  message: string;
  /** Its first line that says something. */
  line: string;
}

export interface Rule {
  /** A short name, unique, that the report prints next to the evidence. */
  name: string;
  category: Category;
  /** The class of TEST_STRATEGY.md section 10 this cause belongs to. */
  failureClass: FailureClass;
  /** One line: why this evidence means this cause. */
  rationale: string;
  /** The first thing to look at, written as an instruction. */
  firstCheck: string;
  /** The evidence lines when the rule fires, `null` when it does not. */
  check(input: RuleInput): string[] | null;
  /**
   * What exactly is broken, when the rule names a cause and not only a symptom: a phrase, or a function of the failure for a rule whose
   * cause has a detail (which statuses, which fault types). Failures that fired the same rule for the same cause are one root cause
   * (docs/TRIAGE.md). A rule that describes a symptom (a wait that ran out, a metric, a premise) has none, and is its own root cause.
   */
  cause?: string | ((input: RuleInput) => string);
}

export const CATEGORY_MEANING: Record<Category, string> = {
  environment:
    'The test could not run as designed: the browser, the service, the streams, a port, or the setup of the run.',
  'page-boot-failure': 'The player page loaded but did not come up (a blocked script, a refused parameter).',
  'origin-error':
    'The origin answered errors that no fault rule explains: the service or its stream cache is broken.',
  'network-fault-not-recovered': 'A fault the test injected fired, and the player ended in a critical error.',
  'decode-or-mse-error':
    'The player reported a media error (Shaka 3xxx: an append, a decode, a video element error).',
  'player-error':
    'The player reported a critical error (a manifest it could not parse, a license, the network) that no fault, origin failure or media error explains.',
  'instrument-disagreement':
    'Two readings of the same thing disagree, or a premise of the test did not hold (the fault it installed was never felt, the buffer it needs was never there): what the test measured says nothing about the behaviour it is about.',
  'timeout-waiting-for-event':
    'A wait ran out (an event, a media time, a request, the whole test) and nothing underneath explains why.',
  'metric-regression':
    'An assertion on a measured quantity failed (rebuffers, dropped frames, latency, startup).',
  'known-gap': 'A documented gap changed: the evidence behind a skip no longer holds.',
  unknown: 'No rule matched. A person has to read the failure.',
};

// ---------------------------------------------------------------------------------------------------------------------
// Helpers shared by the rules

const quote = (text: string): string => `“${oneLine(text, 220)}”`;

/** The first line of the message that matches, or null. */
function lineMatching(message: string, pattern: RegExp): string | null {
  for (const line of message.split(/\r?\n/)) {
    if (pattern.test(line)) return line.trim();
  }
  return null;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: 'network',
  2: 'text',
  3: 'media',
  4: 'manifest',
  5: 'streaming',
  6: 'DRM',
  7: 'player',
  8: 'cast',
  9: 'storage',
  10: 'ads',
};

function describeError(error: ShakaErrorDigest): string {
  const name = error.codeName ?? 'error';
  const kind =
    error.code === 0
      ? 'of the page itself'
      : `${CATEGORY_NAMES[error.category] ?? `category ${error.category}`}`;
  return `${name} (code ${error.code}, ${kind}, ${error.severity >= 2 ? 'critical' : 'recoverable'})`;
}

const lastEvent = (failure: Failure): string | null => failure.diagnostics.events.around.at(-1) ?? null;

/** Where the timeline stood: its last events and the state, for a wait that ran out. */
function whereItStood(failure: Failure): string[] {
  const { events, metrics } = failure.diagnostics;
  const lines: string[] = [];
  if (events.total > 0)
    lines.push(`the timeline has ${events.total} events and ends with ${quote(lastEvent(failure) ?? '')}`);
  else lines.push('there is no timeline: the player page was never read');
  if (metrics.state !== null) lines.push(`player state at the end: ${metrics.state}`);
  return lines;
}

function describeFailedRequests(failure: Failure): string {
  const log = failure.diagnostics.requestLog;
  if (!log) return '';
  const byKind = new Map<string, number>();
  for (const request of log.failed) {
    const what = [request.kind, request.rep, request.number === null ? null : `#${request.number}`]
      .filter((part) => part !== null)
      .join(' ');
    const answer = request.abortReason ? `cut (${request.abortReason})` : String(request.status);
    byKind.set(`${answer} on ${what}`, (byKind.get(`${answer} on ${what}`) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([text, count]) => (count > 1 ? `${text} ×${count}` : text)).join(', ');
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------------
// The rules, in order

const SERVICE_UNREACHABLE =
  /the test data service at \S+ is not answering|(?:GET|POST|PUT|DELETE|HEAD) \/\S* -> no answer|ECONNREFUSED|net::ERR_CONNECTION_REFUSED|NS_ERROR_CONNECTION_REFUSED|Could not connect to the server|net::ERR_CONNECTION_RESET|net::ERR_EMPTY_RESPONSE|NS_ERROR_NET_RESET|\bfetch failed\b/;
const SERVICE_NOT_READY =
  /cannot serve the specs|reports missing streams|has no player page|is not available \(run npm run generate:streams\)|is missing: run npm run generate:streams|run `?npm run (?:generate:streams|build:player)/;
const STREAM_FILES = /ENOENT[^\n]*(?:\.cache[\\/]|streams?[\\/]|\.mpd|\.m3u8|\.m4s|\.mp4|\.webm)/;
const BROWSER_UNAVAILABLE =
  /browserType\.launch|Executable doesn't exist|Failed to launch the browser process|Could not find profile folder|npx playwright install|Host system is missing dependencies|Page crashed|Target crashed|Browser closed unexpectedly|browser has crashed/i;
const MEDIA_TEXT =
  /MediaError|MEDIA_ERR_|Failed to push buffer|MEDIA_SOURCE_OPERATION|VIDEO_ERROR|QuotaExceededError|SourceBuffer|appendBuffer/;
const METRIC_PATH = /\((metrics\.(?:rebuffer|frames|live|startupMs|startup|bitrate\.switches)[\w.]*)\)/;

export const RULES: readonly Rule[] = [
  {
    name: 'documented-gap-confirmation-failed',
    cause: 'a documented gap no longer fails the way it was documented',
    category: 'known-gap',
    failureClass: 'Known gap',
    rationale:
      'A spec confirms a documented gap before it skips (ADR-105); when the confirmation fails the engine no longer fails the documented way.',
    firstCheck:
      'Read the timeline of the failed confirmation: if the engine plays now, the gap closed. Re-probe the environment (`npm run codec-matrix`, `tools/eme-probe.ts`) and change the evidence in one commit.',
    check: ({ message, failure }) => {
      const line = lineMatching(message, /waitFor\('error'\).*MISSING_EME_SUPPORT/);
      return line
        ? [`the confirmation of a documented gap timed out: ${quote(line)}`, ...whereItStood(failure)]
        : null;
    },
  },
  {
    name: 'documented-gap-in-message',
    cause: 'a documented gap',
    category: 'known-gap',
    failureClass: 'Known gap',
    rationale:
      'The failure quotes the reason of a documented gap, which is what a skip carries: the gap and the failure are the same event.',
    firstCheck:
      'Read the gap reason: it names the environment and the evidence (docs/CODEC_MATRIX.md). Nothing to fix in the pull request; re-probe when the engine was upgraded.',
    check: ({ message }) => {
      const line = lineMatching(message, /\bdocumented gap in [\w.-]+/);
      return line ? [`the message quotes a documented gap: ${quote(line)}`] : null;
    },
  },
  {
    name: 'environment-check-failed',
    cause: 'the engine no longer plays what the committed matrix says it plays',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'PB-ENV-001 exists to say "the environment changed" before a pile of playback failures says something misleading, and its message says so in words.',
    firstCheck:
      'Do not retry the specs. Re-run `npm run codec-matrix` in this environment, read docs/CODEC_MATRIX.md, and compare the engine version with the evidence.',
    check: ({ message, line }) => {
      // The check wraps what the player said. When the page itself never came up, nothing was learned about the engine: the page is what
      // failed, and the rules of the page say so (a real run: a Content Security Policy that blocked the scripts failed this check in
      // every engine, and the check blamed the environment).
      if (/What the player said: the player page (?:did not boot|could not use its parameters)/.test(message))
        return null;
      const found = lineMatching(
        message,
        /no documented gap covers it|this is an environment failure, not a playback regression|a failure of the experiment, not a change of the environment/,
      );
      if (!found) return null;
      const evidence = lineMatching(message, /^Committed evidence/);
      return [`the environment check failed: ${quote(line)}`, ...(evidence ? [quote(evidence)] : [])];
    },
  },
  {
    name: 'service-not-reachable',
    cause: 'the test data service cannot be reached',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'Nothing could talk to the test data service: every test needs it, so this is the environment, not a test.',
    firstCheck:
      'Is the service running on the port the run used (`curl <origin>/health`)? Start it with `npm run build:player && npm run serve`, and read its own log.',
    check: ({ message }) => {
      const line = lineMatching(message, SERVICE_UNREACHABLE);
      return line ? [`the service could not be reached: ${quote(line)}`] : null;
    },
  },
  {
    name: 'service-not-ready',
    cause: 'the test data service is not ready: a stream or the player build is missing',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'The service answered, and said it cannot serve the specs: a stream is missing or the player is not built.',
    firstCheck:
      'Run the command the message names (`npm run generate:streams`, `npm run build:player`) and start the service again.',
    check: ({ message }) => {
      const line = lineMatching(message, SERVICE_NOT_READY);
      return line ? [`the service is not ready: ${quote(line)}`] : null;
    },
  },
  {
    name: 'stream-files-missing',
    cause: 'stream files are not where the run looks for them',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'A read of a stream or manifest file failed with ENOENT: the generated streams are not where the run looks for them.',
    firstCheck:
      'Is the stream cache complete (`npm run verify:streams`)? Is `PB_CACHE_DIR` the directory the generator wrote?',
    check: ({ message }) => {
      const line = lineMatching(message, STREAM_FILES);
      return line ? [`a stream file is missing: ${quote(line)}`] : null;
    },
  },
  {
    name: 'browser-unavailable',
    cause: 'the browser did not launch or crashed',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'The browser did not launch, is not installed, or crashed: no playback result can come from it.',
    firstCheck:
      'The job log of the engine: is the browser installed (`npx playwright install`) and are its system libraries there? In the Playwright image: is it the version the lockfile pins?',
    check: ({ message }) => {
      const line = lineMatching(message, BROWSER_UNAVAILABLE);
      return line ? [`the browser is not available: ${quote(line)}`] : null;
    },
  },
  {
    name: 'port-in-use',
    cause: 'a port is taken by another process',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'A server could not bind its port: another process (a service left from an earlier run) holds it.',
    firstCheck:
      'Which process holds the port (`lsof -i :<port>`)? Stop it, or give this run its own `PB_PORT`.',
    check: ({ message }) => {
      const line = lineMatching(message, /EADDRINUSE|address already in use|port \d+ is already in use/i);
      return line ? [`a port is taken: ${quote(line)}`] : null;
    },
  },
  {
    name: 'resources-exhausted',
    cause: 'the machine ran out of disk, memory or file handles',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'The machine ran out of disk, memory or file handles: the failure says nothing about the player.',
    firstCheck: 'Free the resource named (`df -h`, memory of the runner, `ulimit -n`) and rerun the job.',
    check: ({ message }) => {
      const line = lineMatching(
        message,
        /\bENOSPC\b|\bENOMEM\b|\bEMFILE\b|no space left on device|too many open files|out of memory/i,
      );
      return line ? [`the machine ran out of a resource: ${quote(line)}`] : null;
    },
  },
  {
    name: 'player-reports-browser-unsupported',
    cause: 'the player does not support this browser build',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale: 'Shaka says this browser cannot run it: the engine build changed, not the player under test.',
    firstCheck:
      'The user agent in the message against the engine version of the committed evidence (`npm run codec-matrix`).',
    check: ({ message }) => {
      const line = lineMatching(
        message,
        /Shaka reports that this browser is not supported|isBrowserSupported\(\) is false/,
      );
      return line ? [`the player does not support this browser: ${quote(line)}`] : null;
    },
  },
  {
    name: 'run-failed-before-any-test',
    cause: 'the run failed before any test: a global setup threw or the web server did not start',
    category: 'environment',
    failureClass: 'Environment or infrastructure',
    rationale:
      'Playwright itself reported an error of the run (a global setup that threw, a web server that did not start): no test ran.',
    firstCheck:
      'The job log above the first test: the global setup (`tests/e2e/support/global-setup.ts`) and the `webServer` of playwright.config.ts print what is wrong.',
    check: ({ failure, line, message }) =>
      failure.scope === 'run'
        ? [
            `an error of the run, with no test to blame: ${quote(line)}`,
            ...(/config\.webServer/.test(message)
              ? [
                  'the web server of the config is the test data service: it refuses to start when a stream file is missing or damaged (`npm run verify:streams`) or its port is taken, and says which in its own output, which is in the job log and not in this report',
                ]
              : []),
          ]
        : null,
  },
  {
    name: 'page-did-not-boot',
    cause: ({ message, failure }) =>
      [message, ...failure.diagnostics.console.samples].some((text) =>
        /Content Security Policy|Refused to (?:execute|load|apply|connect)/i.test(text),
      )
        ? 'the player page did not boot: a Content Security Policy blocked its scripts'
        : 'the player page did not boot',
    category: 'page-boot-failure',
    failureClass: 'Functional regression',
    rationale:
      'The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.',
    firstCheck:
      'The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.',
    check: ({ message, failure, line }) => {
      if (!/the player page did not boot/.test(message)) return null;
      const samples = failure.diagnostics.console.samples;
      const csp = [message, ...samples].some((text) =>
        /Content Security Policy|Refused to (?:execute|load|apply|connect)/i.test(text),
      );
      return [
        `the page did not boot: ${quote(line)}`,
        ...(csp ? ['the console names a Content Security Policy violation'] : []),
        ...samples.map((sample) => `console: ${quote(sample)}`),
      ];
    },
  },
  {
    name: 'page-refused-parameters',
    cause: 'the player page refused the parameters it was given',
    category: 'page-boot-failure',
    failureClass: 'Functional regression',
    rationale:
      'The page told the test that a parameter it passed cannot be used: a typo or a changed contract of the page, caught on purpose.',
    firstCheck: 'The parameters listed in the message against `PlayerPageParams` in src/shared/qa.ts.',
    check: ({ message }) => {
      if (!/the player page could not use its parameters/.test(message)) return null;
      const problems = message
        .split(/\r?\n/)
        .filter((line) => /^\s+- /.test(line))
        .map((line) => line.replace(/^\s+- /, ''));
      return [
        'the page could not use the parameters it was given',
        ...problems.slice(0, 3).map((problem) => quote(problem)),
      ];
    },
  },
  {
    name: 'fault-fired-player-failed',
    cause: ({ failure }) => {
      const types = [
        ...new Set(
          failure.diagnostics.faults
            .filter((fault) => fault.fired > 0)
            .map((fault) => fault.type ?? 'unknown'),
        ),
      ].sort();
      return `a fault of type ${types.join(' and ')} fired and the player did not recover`;
    },
    category: 'network-fault-not-recovered',
    failureClass: 'Functional regression',
    rationale:
      'The request log shows a fault rule firing and the player then reported a critical error: the failure is the recovery, not the fault.',
    firstCheck:
      'In request-log.json, the first request the fault hit; then in qa-events.json what the player did next: retry, fail over to another rung, or give up. `session-detail.json` has the rule to reproduce it.',
    check: ({ failure }) => {
      const { faults, primaryError, metrics } = failure.diagnostics;
      const fired = faults.filter((fault) => fault.fired > 0);
      if (fired.length === 0 || (primaryError === null && metrics.state !== 'error')) return null;
      return [
        ...fired.map(
          (fault) =>
            `fault ${fault.id}${fault.description ? ` (${fault.description})` : ''} fired on ${plural(fault.fired, 'request')}`,
        ),
        primaryError
          ? `the player reported a critical error: ${describeError(primaryError)}`
          : 'the player ended in the error state',
        ...(metrics.state === 'error' && primaryError ? ['player state at the end: error'] : []),
      ];
    },
  },
  {
    name: 'origin-failed-without-fault',
    cause: ({ failure }) => {
      const answers = [
        ...new Set(
          (failure.diagnostics.requestLog?.failed ?? [])
            .filter((request) => request.faults.length === 0)
            .map(
              (request) =>
                `${request.abortReason ? `a cut (${request.abortReason})` : request.status} on ${request.kind}`,
            ),
        ),
      ].sort();
      return `the origin answered ${answers.join(' and ')} to requests no fault rule named`;
    },
    category: 'origin-error',
    failureClass: 'Environment or infrastructure',
    rationale:
      'The origin answered errors or cut responses on requests no fault rule named, and the player noticed: the service or its stream cache is at fault.',
    firstCheck:
      'The failed requests in request-log.json: ask the service for the same path (`curl -i <origin><path>`), run `npm run verify:streams`, and read the service log (`PB_LOG=1`).',
    check: ({ failure }) => {
      const { requestLog, shakaErrors, metrics } = failure.diagnostics;
      if (!requestLog || requestLog.originFailuresWithoutFault === 0) return null;
      if (shakaErrors.length === 0 && metrics.state !== 'error') return null;
      const noticed = shakaErrors[0];
      return [
        `${plural(requestLog.originFailuresWithoutFault, 'request')} failed at the origin with no fault rule on ${requestLog.originFailuresWithoutFault === 1 ? 'it' : 'them'} (${requestLog.originFailures} failed in all, ${requestLog.segments} segment requests in the log)`,
        `the first failures: ${describeFailedRequests(failure)}`,
        ...(noticed
          ? [`the player noticed: ${describeError(noticed)}`]
          : ['the player ended in the error state']),
      ];
    },
  },
  {
    name: 'media-error',
    cause: 'the bytes arrived and the browser could not append or decode them',
    category: 'decode-or-mse-error',
    failureClass: 'Functional regression',
    rationale:
      'Shaka category 3 (media) or a media-element error: the bytes arrived and the browser could not append or decode them.',
    firstCheck:
      'The error in qa-events.json (code and data), then the segment that was being appended: `npm run verify:streams`, and try the same stream in another engine.',
    check: ({ failure, message }) => {
      const media = failure.diagnostics.shakaErrors.filter((error) => error.category === 3);
      const consoleText = failure.diagnostics.console.samples.join('\n');
      const textual = lineMatching(`${message}\n${consoleText}`, MEDIA_TEXT);
      if (media.length === 0 && textual === null) return null;
      const log = failure.diagnostics.requestLog;
      return [
        ...media.slice(0, 3).map((error) => `the player reported a media error: ${describeError(error)}`),
        ...(media.length === 0 && textual
          ? [`the message or the console names a media error: ${quote(textual)}`]
          : []),
        ...(log && log.originFailures === 0 && log.entries > 0
          ? [
              `the origin delivered every request it was asked for (${plural(log.entries, 'request')}, none failed): the bytes themselves are suspect`,
            ]
          : []),
      ];
    },
  },
  {
    name: 'fault-premise-not-met',
    category: 'instrument-disagreement',
    failureClass: 'Functional regression',
    rationale:
      'The test installed a fault and the request log says the player did not ask for what it matches: the premise failed, so what the player did says nothing about recovery.',
    firstCheck:
      'The requests of the session in request-log.json against the rule in session-detail.json: which rung and segment did the player ask for, and why not the one the rule names (the ABR chose another rung, the player stopped earlier)?',
    check: ({ failure, message }) => {
      const line = lineMatching(
        message,
        /the player never asked for what the rule matches|named \d+ of the \d+ requests?/,
      );
      if (!line) return null;
      const unfired = failure.diagnostics.faults.filter((fault) => fault.fired === 0);
      return [
        `the fault was not felt as the test expected: ${quote(line)}`,
        ...unfired.map(
          (fault) =>
            `fault ${fault.id}${fault.description ? ` (${fault.description})` : ''} fired on no request`,
        ),
      ];
    },
  },
  {
    name: 'test-premise-not-met',
    category: 'instrument-disagreement',
    failureClass: 'Needs a person',
    rationale:
      'The test checked a condition it needs before it can judge anything (its own message says "premise of the test, not the behaviour under test") and the condition did not hold: the behaviour was never exercised.',
    firstCheck:
      'The premise the message names against the player’s numbers (qa-metrics.json) and the request log: a premise that does not hold means the scenario could not be set up (a slow or failing origin, a loaded host). Compare `ttfbMs` and `totalMs` of the segments in request-log.json with the length of a segment.',
    check: ({ message, failure }) => {
      const line = lineMatching(message, /premise of the test, not the behaviour under test/);
      return line ? [`a premise of the test did not hold: ${quote(line)}`, ...whereItStood(failure)] : null;
    },
  },
  {
    name: 'oracles-disagree',
    category: 'instrument-disagreement',
    failureClass: 'Functional regression',
    rationale:
      'The lab compares two readings of the same fact (the hook and the request log) and its own message says they disagree: one instrument is wrong.',
    firstCheck:
      'Decide which reading is wrong: the hook’s account (qa-events.json, qa-metrics.json) against the origin’s account (request-log.json). A disagreement is a defect of the lab or of the player, never noise.',
    check: ({ message }) => {
      const line = lineMatching(
        message,
        /\bdisagree\b|against its own (?:history|log)|the hook (?:recorded|and the log)/i,
      );
      return line ? [`two instruments disagree: ${quote(line)}`] : null;
    },
  },
  {
    name: 'player-critical-error',
    cause: ({ failure }) => {
      const error = failure.diagnostics.primaryError;
      return error
        ? `the player reported ${error.codeName ?? 'error'} (code ${error.code})`
        : 'the player ended in the error state';
    },
    category: 'player-error',
    failureClass: 'Functional regression',
    rationale:
      'The player reported a critical error that no fault, no origin failure and no media error explains: it is the cause of what the test saw.',
    firstCheck:
      'The error in qa-events.json: its code, its category and its data (the URI and the status), and the manifest it was loading.',
    check: ({ failure }) => {
      const { primaryError, metrics } = failure.diagnostics;
      if (primaryError === null)
        return metrics.state === 'error'
          ? ['the player ended in the error state with no error recorded']
          : null;
      return [
        `the player reported a critical error: ${describeError(primaryError)}: ${quote(primaryError.message)}`,
      ];
    },
  },
  {
    name: 'hook-wait-timed-out',
    category: 'timeout-waiting-for-event',
    failureClass: 'Functional regression',
    rationale:
      'A wait on the player’s timeline ran out, and the diagnostics show no error, fault or origin failure underneath: the event never came.',
    firstCheck:
      'The timeline in qa-events.json: what happened last before the wait, whether the player was loading, buffering or paused, and what request-log.json says it asked for.',
    check: ({ message, failure }) => {
      const match =
        /qa\.waitFor\((['"])([\w-]+)\1\) timed out after (\d+) ms(?: \(looking from index \d+(?:, with a predicate)?(?:, with detail (\{[^)]*\}))?\))?/.exec(
          message,
        );
      if (!match) return null;
      return [
        `waited ${match[3]} ms for the ${match[2]} event${match[4] ? ` with detail ${match[4]}` : ''} and it did not come`,
        ...whereItStood(failure),
      ];
    },
  },
  {
    name: 'media-clock-wait-timed-out',
    category: 'timeout-waiting-for-event',
    failureClass: 'Functional regression',
    rationale:
      'A wait for the media clock to reach a time ran out: the player stopped advancing, and nothing underneath explains it.',
    firstCheck:
      'Did the clock stop at a segment boundary (a buffered range ending), after a rebuffer, or never start? `qa-events.json` and the `playback` part of qa-metrics.json say.',
    check: ({ message, failure }) => {
      const match =
        /qa\.waitForMediaTime\(([\d.]+)\) timed out after (\d+) ms: the media clock is at ([\d.]+) s/.exec(
          message,
        );
      if (!match) return null;
      return [
        `waited ${match[2]} ms for the media clock to reach ${match[1]} s; it was at ${match[3]} s`,
        ...whereItStood(failure),
      ];
    },
  },
  {
    name: 'request-log-wait-timed-out',
    category: 'timeout-waiting-for-event',
    failureClass: 'Functional regression',
    rationale:
      'A wait on the origin’s request log ran out: the player never asked for what the test waited for.',
    firstCheck:
      'The last requests listed in the message and in request-log.json: what did the player ask for instead, and why did it stop?',
    check: ({ message }) => {
      const match = /waited (\d+) ms for (a request|\d+ requests) of session \S+ matching/.exec(message);
      return match ? [`waited ${match[1]} ms for ${match[2]} in the origin’s log and it did not come`] : null;
    },
  },
  {
    name: 'page-call-timed-out',
    category: 'timeout-waiting-for-event',
    failureClass: 'Functional regression',
    rationale:
      'A call on the page (a navigation, a wait for a function) ran out of time: the page did not answer.',
    firstCheck:
      'Is the page loading at all (`curl -I <origin>/player/`)? Is the machine loaded (a timeout that many tests share points at the host)?',
    check: ({ message }) => {
      const line = lineMatching(
        message,
        /^(?:Error: )?(?:page|locator|frame|browserContext|browser|request|response)\.\w+: Timeout \d+ms exceeded/,
      );
      return line ? [`a call on the page ran out of time: ${quote(line)}`] : null;
    },
  },
  {
    name: 'test-timed-out',
    category: 'timeout-waiting-for-event',
    failureClass: 'Functional regression',
    rationale:
      'The whole test ran past its limit with no wait of its own failing first: something hung outside the waits, or the host was too slow.',
    firstCheck:
      'Where the timeline stopped (qa-events.json) and how many tests timed out together: many at once point at the host, one at a scenario longer than its limit.',
    check: ({ message, failure }) => {
      const match = /^(?:Error: )?Test timeout of (\d+)ms exceeded/m.exec(message);
      return match ? [`the whole test ran past ${match[1]} ms`, ...whereItStood(failure)] : null;
    },
  },
  {
    name: 'metric-assertion-failed',
    category: 'metric-regression',
    failureClass: 'Performance regression',
    rationale:
      'The failing assertion is about a measured quantity (rebuffers, dropped frames, latency, startup) and nothing underneath explains it as an error.',
    firstCheck:
      'The metric against METRICS.md and its tolerance in the spec; then the same run’s qa-metrics.json and the timeline around the value. Compare with the performance baseline before blaming the player.',
    check: ({ failure, line }) => {
      const metric = METRIC_PATH.exec(line)?.[1];
      if (!metric) return null;
      const { rebuffers, frames, liveLatencyMs, startupMs } = failure.diagnostics.metrics;
      const numbers = [
        ...(rebuffers
          ? [`${plural(rebuffers.count, 'rebuffer')} totalling ${Math.round(rebuffers.totalMs)} ms`]
          : []),
        ...(frames ? [`${frames.dropped} of ${frames.decoded} frames dropped`] : []),
        ...(liveLatencyMs !== null ? [`live latency ${Math.round(liveLatencyMs)} ms`] : []),
        ...(startupMs !== null ? [`startup ${Math.round(startupMs)} ms`] : []),
      ];
      return [
        `the assertion is on ${metric}: ${quote(line)}`,
        ...(numbers.length > 0 ? [`the player’s own numbers: ${numbers.join(', ')}`] : []),
      ];
    },
  },
];

/** The rule that stands for "nothing matched": it is not in the table, so that a rule can never be added after it. */
export const NO_RULE: Pick<Rule, 'name' | 'category' | 'failureClass' | 'rationale' | 'firstCheck'> = {
  name: 'no-rule-matched',
  category: 'unknown',
  failureClass: 'Needs a person',
  rationale: 'No rule of the table recognised this failure: the message and the attachments have to be read.',
  firstCheck:
    'The message, the stack and the attachments of the representative failure; if it recurs, add a rule for it (docs/TRIAGE.md).',
};

export interface Classified {
  verdict: RuleVerdict;
  rationale: string;
  firstCheck: string;
  failureClass: FailureClass;
}

export function ruleByName(name: string): Rule | null {
  return RULES.find((rule) => rule.name === name) ?? null;
}

/** The first rule of the table that finds something in this failure, or the rule that stands for "no rule matched". */
export function classify(failure: Failure): Classified {
  const message = stripAnsi(failure.error.message);
  const input: RuleInput = { failure, message, line: meaningfulFirstLine(message) };
  for (const rule of RULES) {
    const evidence = rule.check(input);
    if (evidence !== null) {
      return {
        verdict: {
          rule: rule.name,
          category: rule.category,
          evidence,
          cause: typeof rule.cause === 'function' ? rule.cause(input) : (rule.cause ?? null),
        },
        rationale: rule.rationale,
        firstCheck: rule.firstCheck,
        failureClass: rule.failureClass,
      };
    }
  }
  return {
    verdict: {
      rule: NO_RULE.name,
      category: NO_RULE.category,
      evidence: [`no rule matched ${quote(input.line)}`],
      cause: null,
    },
    rationale: NO_RULE.rationale,
    firstCheck: NO_RULE.firstCheck,
    failureClass: NO_RULE.failureClass,
  };
}
