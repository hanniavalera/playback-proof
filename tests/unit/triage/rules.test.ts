import { describe, expect, it } from 'vitest';
import { CATEGORY_MEANING, NO_RULE, RULES, classify, ruleByName } from '../../../triage/rules.ts';
import { CATEGORIES } from '../../../triage/types.ts';
import type { Failure } from '../../../triage/types.ts';
import {
  diagnosticsOf,
  environmentCheckFailure,
  event,
  failure,
  hookMediaTimeTimeout,
  hookWaitTimeout,
  metrics,
  notReadyFailure,
  rebufferAssertion,
  requestEntry,
  requestWaitTimeout,
  sessionDetail,
  shakaError,
} from './support.ts';

const rule = (f: Failure): string => classify(f).verdict.rule;
const category = (f: Failure): string => classify(f).verdict.category;

/** A critical Shaka error the way the hook records it, as an error event and in the metrics, so that both digests agree. */
function playerEnded(code: number, codeName: string, categoryNumber: number, severity = 2) {
  const error = shakaError(code, codeName, categoryNumber, severity, 'what happened');
  return {
    events: [event(0, 'load-requested'), event(1, 'buffering-start'), event(2, 'error', error)],
    metrics: metrics({ state: 'error', errors: [error] }),
  };
}

const faultSession = (...rules: Array<Record<string, unknown>>) => sessionDetail(rules);
const refusedLog = (faults: string[], count = 3) => [
  requestEntry(1),
  ...Array.from({ length: count }, (_, i) =>
    requestEntry(i + 2, { status: 503, faults: faults.slice(0, 1) }),
  ),
];

describe('PB-LAB-005 triage rules: the table is well formed', () => {
  it('has unique names, a rationale and a first check for every rule, and only known categories and classes', () => {
    const names = RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const r of RULES) {
      expect(CATEGORIES, r.name).toContain(r.category);
      expect(r.rationale.length, `${r.name} has a rationale`).toBeGreaterThan(30);
      expect(r.firstCheck.length, `${r.name} has a first check`).toBeGreaterThan(30);
      expect(r.name).toMatch(/^[a-z]+(?:-[a-z]+)+$/);
      expect(ruleByName(r.name)).toBe(r);
    }
    expect(ruleByName('no-such-rule')).toBeNull();
  });

  it('explains every category, and has at least one rule for every category but `unknown`', () => {
    for (const name of CATEGORIES) {
      expect(CATEGORY_MEANING[name].length, name).toBeGreaterThan(20);
      if (name !== 'unknown')
        expect(
          RULES.some((r) => r.category === name),
          `a rule of ${name}`,
        ).toBe(true);
    }
    expect(NO_RULE.category).toBe('unknown');
    expect(RULES.map((r) => r.name)).not.toContain(NO_RULE.name);
  });
});

describe('PB-LAB-005 triage rules: each rule fires on what it names, and not on the near miss', () => {
  it('known-gap: a gap whose confirmation failed, and a gap the message quotes', async () => {
    const eme = await hookWaitTimeout('error', { detail: { codeName: 'MISSING_EME_SUPPORT' } });
    expect(rule(failure({ message: eme }))).toBe('documented-gap-confirmation-failed');
    expect(category(failure({ message: eme }))).toBe('known-gap');
    const other = await hookWaitTimeout('error', { detail: { codeName: 'NO_LICENSE_SERVER_GIVEN' } });
    expect(rule(failure({ message: other }))).toBe('hook-wait-timed-out');

    const quoted =
      'Error: documented gap in docker-linux-arm64: webkit has no Encrypted Media Extensions here (navigator.requestMediaKeySystemAccess does not exist)';
    expect(rule(failure({ message: quoted }))).toBe('documented-gap-in-message');
    expect(rule(failure({ message: 'Error: this is a gap nobody documented' }))).toBe('no-rule-matched');
  });

  it('environment: PB-ENV-001 says the environment changed, in the words the lab writes', () => {
    const verdict = classify(failure({ message: environmentCheckFailure() }));
    expect(verdict.verdict.rule).toBe('environment-check-failed');
    expect(verdict.verdict.evidence[0]).toContain('could not play vod-cmaf over dash');
    expect(verdict.failureClass).toBe('Environment or infrastructure');
    expect(rule(failure({ message: 'Error: the environment variable PB_PORT is not a number' }))).toBe(
      'no-rule-matched',
    );
  });

  it('environment: the service cannot be reached, in the words of the setup, the client and the three engines', () => {
    const messages = [
      'Error: the test data service at http://127.0.0.1:4750 is not answering (fetch failed): start it with `npm run build:player && npm run serve`',
      'Error: POST /api/sessions -> no answer fetch failed',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      'Error: page.goto: NS_ERROR_CONNECTION_REFUSED',
      'Error: page.goto: Could not connect to the server.',
      'Error: connect ECONNREFUSED 127.0.0.1:4750',
    ];
    for (const message of messages) expect(rule(failure({ message })), message).toBe('service-not-reachable');
    expect(rule(failure({ message: 'Error: POST /api/sessions -> 400 stream is not valid' }))).toBe(
      'no-rule-matched',
    );
  });

  it('environment: the service answered and said it cannot serve the specs', () => {
    expect(rule(failure({ message: notReadyFailure() }))).toBe('service-not-ready');
    expect(classify(failure({ message: notReadyFailure() })).verdict.evidence[0]).toContain(
      'missing streams',
    );
    expect(
      rule(failure({ message: 'Error: stream vod-webm is not available (run npm run generate:streams)' })),
    ).toBe('service-not-ready');
    expect(
      rule(failure({ message: 'Error: the service lists vod-cmaf-clearkey without its test key' })),
    ).toBe('no-rule-matched');
  });

  it('environment: a stream file that is not where the run looks, not any ENOENT', () => {
    expect(
      rule(
        failure({
          message: "Error: ENOENT: no such file or directory, open '/x/.cache/streams/vod-cmaf/manifest.mpd'",
        }),
      ),
    ).toBe('stream-files-missing');
    expect(
      rule(failure({ message: "Error: ENOENT: no such file or directory, open '/x/flake/quarantine.json'" })),
    ).toBe('no-rule-matched');
  });

  it('environment: the browser did not launch, or crashed; a closed page is not that', () => {
    for (const message of [
      "Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
      'Error: browserType.launch: Failed to launch the browser process: Could not find profile folder.',
      'Error: page.goto: Page crashed',
    ]) {
      expect(rule(failure({ message })), message).toBe('browser-unavailable');
    }
    expect(
      rule(failure({ message: 'Error: page.evaluate: Target page, context or browser has been closed' })),
    ).toBe('no-rule-matched');
  });

  it('environment: a port that is taken, a machine that ran out of something, a browser Shaka does not support', () => {
    expect(
      rule(failure({ message: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4750' })),
    ).toBe('port-in-use');
    expect(rule(failure({ message: 'Error: ENOSPC: no space left on device, write' }))).toBe(
      'resources-exhausted',
    );
    expect(
      rule(
        failure({
          message:
            'Error: Shaka reports that this browser is not supported (shaka.Player.isBrowserSupported() is false): Mozilla/5.0',
        }),
      ),
    ).toBe('player-reports-browser-unsupported');
  });

  it('environment: an error of the run itself, which no test can be blamed for; the same words in a test are no such thing', () => {
    const message = 'Error: Process from config.webServer was not able to start. Exit code: 1';
    expect(rule(failure({ scope: 'run', id: '(run)', message }))).toBe('run-failed-before-any-test');
    expect(rule(failure({ message }))).toBe('no-rule-matched');
  });

  it('page-boot-failure: a page that did not boot, with the console that says why', () => {
    const message =
      'Error: the player page did not boot (http://127.0.0.1:4650/player/?manifest=%2Fs%2Fabc%2Fm.mpd): Timeout 15000ms exceeded.\nThe browser console said:\n  error: Refused to execute inline script because it violates the following Content Security Policy directive';
    const f = failure({
      message,
      diagnostics: diagnosticsOf({
        console: [
          {
            type: 'error',
            text: "Refused to apply inline style because it violates the following Content Security Policy directive: 'style-src'",
          },
        ],
        attached: ['page-console.json'],
      }),
    });
    const verdict = classify(f);
    expect(verdict.verdict.rule).toBe('page-did-not-boot');
    expect(verdict.verdict.evidence.join('\n')).toContain('Content Security Policy violation');
    expect(verdict.verdict.evidence.join('\n')).toContain('console: ');
  });

  it('page-boot-failure: parameters the page refused, listed', () => {
    const message =
      'Error: the player page could not use its parameters (http://127.0.0.1:4650/player/):\n  - muted="maybe" is not 1/0\n  - start=-3 is not a number of seconds >= 0';
    const verdict = classify(failure({ message }));
    expect(verdict.verdict.rule).toBe('page-refused-parameters');
    expect(verdict.verdict.evidence.join('\n')).toContain('muted="maybe"');
  });

  it('network-fault-not-recovered: a fault fired and the player ended in a critical error; with the fault unfired it is the error alone', () => {
    const ended = playerEnded(1001, 'BAD_HTTP_STATUS', 1);
    const detail = faultSession({
      id: 'f1',
      type: 'status',
      status: 503,
      match: { kind: 'segment', rep: 'v360' },
    });
    const fired = failure({
      message: 'Error: player state (metrics.state) after every rung was refused',
      diagnostics: diagnosticsOf({ ...ended, detail, log: refusedLog(['f1']) }),
    });
    const verdict = classify(fired);
    expect(verdict.verdict.rule).toBe('fault-fired-player-failed');
    expect(verdict.verdict.category).toBe('network-fault-not-recovered');
    expect(verdict.verdict.evidence.join('\n')).toMatch(
      /fault f1 \(status 503 on segment v360\) fired on 3 requests/,
    );
    expect(verdict.verdict.evidence.join('\n')).toContain('BAD_HTTP_STATUS (code 1001, network, critical)');

    const unfired = failure({
      message: fired.error.message,
      diagnostics: diagnosticsOf({ ...ended, detail, log: [requestEntry(1)] }),
    });
    expect(rule(unfired)).toBe('player-critical-error');
  });

  it('origin-error: the origin failed on requests no fault named, and the player noticed; unnoticed or explained by a fault it is not', () => {
    const recoverable = shakaError(1001, 'BAD_HTTP_STATUS', 1, 1);
    const noticed = failure({
      message: "Error: qa.waitFor('firstframe') timed out after 15000 ms",
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested'), event(1, 'error', recoverable)],
        detail: sessionDetail([]),
        log: [requestEntry(1), ...Array.from({ length: 6 }, (_, i) => requestEntry(i + 2, { status: 503 }))],
      }),
    });
    const verdict = classify(noticed);
    expect(verdict.verdict.rule).toBe('origin-failed-without-fault');
    expect(verdict.verdict.evidence.join('\n')).toMatch(
      /6 requests failed at the origin with no fault rule on them/,
    );
    expect(verdict.verdict.evidence.join('\n')).toContain('503 on segment v360');
    expect(verdict.failureClass).toBe('Environment or infrastructure');

    const unnoticed = failure({
      message: noticed.error.message,
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested')],
        log: [requestEntry(1, { status: 404 })],
      }),
    });
    expect(rule(unnoticed)).toBe('hook-wait-timed-out');
  });

  it('decode-or-mse-error: a Shaka media error, with the origin acquitted when it delivered everything', () => {
    const ended = playerEnded(3016, 'VIDEO_ERROR', 3);
    const f = failure({
      message: 'Error: player state (metrics.state): the player is in the error state',
      diagnostics: diagnosticsOf({ ...ended, log: [requestEntry(1), requestEntry(2), requestEntry(3)] }),
    });
    const verdict = classify(f);
    expect(verdict.verdict.rule).toBe('media-error');
    expect(verdict.verdict.evidence.join('\n')).toContain('VIDEO_ERROR (code 3016, media, critical)');
    expect(verdict.verdict.evidence.join('\n')).toContain(
      'the origin delivered every request it was asked for',
    );

    const byText = failure({
      message: 'Error: x',
      diagnostics: diagnosticsOf({
        console: [{ type: 'error', text: 'MediaError 4: Failed to push buffer' }],
        attached: ['page-console.json'],
      }),
    });
    expect(rule(byText)).toBe('media-error');
    expect(
      rule(
        failure({
          message: 'Error: x',
          diagnostics: diagnosticsOf({
            console: [{ type: 'error', text: 'a 404 for favicon.ico' }],
            attached: ['page-console.json'],
          }),
        }),
      ),
    ).toBe('no-rule-matched');
  });

  it('instrument-disagreement: a fault that was never felt, and two readings that say they disagree', () => {
    const message =
      'Error: the fault rule f1 {"type":"status","status":404} named 0 of the 1 request it was waited for within 15000 ms: the player never asked for what the rule matches';
    const never = failure({
      message,
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested'), event(1, 'firstframe')],
        detail: faultSession({
          id: 'f1',
          type: 'status',
          status: 404,
          match: { kind: 'segment', rep: 'v720', number: 99 },
        }),
        log: [requestEntry(1), requestEntry(2)],
      }),
    });
    const verdict = classify(never);
    expect(verdict.verdict.rule).toBe('fault-premise-not-met');
    expect(verdict.verdict.evidence.join('\n')).toContain(
      'fault f1 (status 404 on segment v720 #99) fired on no request',
    );

    const disagree =
      'Error: where the player history (qa.metrics().bitrate.history) and the video segments in the request log disagree';
    expect(rule(failure({ message: disagree }))).toBe('oracles-disagree');
    expect(category(failure({ message: disagree }))).toBe('instrument-disagreement');
  });

  it('test-premise-not-met: the test says its own condition did not hold (a real run: a slow origin left 2 s buffered where a seek needs more)', () => {
    // The wording of PB-VOD-006's premise check, as a real run of a slow origin reported it.
    const message =
      'Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (2.114762 s) when the seek to 7 s is made (metrics.playback.bufferedAheadSec)\n\nExpected: > 3\nReceived: 2.114762';
    const verdict = classify(
      failure({
        message,
        diagnostics: diagnosticsOf({ events: [event(0, 'load-requested'), event(1, 'firstframe')] }),
      }),
    );
    expect(verdict.verdict.rule).toBe('test-premise-not-met');
    expect(verdict.verdict.category).toBe('instrument-disagreement');
    expect(verdict.failureClass).toBe('Needs a person');
    expect(verdict.verdict.evidence[0]).toContain('a premise of the test did not hold');
    expect(verdict.verdict.evidence[0]).toContain('2.114762 s');
    // A near miss: the same quantity asserted without the premise wording is a metric or nothing, not a premise.
    expect(
      rule(
        failure({
          message:
            'Error: seconds buffered ahead of the playhead (2.1 s) (metrics.playback.bufferedAheadSec) expected more than 3',
        }),
      ),
    ).not.toBe('test-premise-not-met');
    // It describes a symptom: no cause, so each such cluster is its own root cause.
    expect(verdict.verdict.cause).toBeNull();
  });

  it('player-error: a critical error that nothing else explains, named by its Shaka category', () => {
    const f = failure({
      message: 'Error: startup time (metrics.startupMs) is null: the first frame was never presented',
      diagnostics: diagnosticsOf(playerEnded(4001, 'DASH_INVALID_XML', 4)),
    });
    const verdict = classify(f);
    expect(verdict.verdict.rule).toBe('player-critical-error');
    expect(verdict.verdict.category).toBe('player-error');
    expect(verdict.verdict.evidence[0]).toContain('DASH_INVALID_XML (code 4001, manifest, critical)');
    expect(
      rule(
        failure({
          message: 'Error: x',
          diagnostics: diagnosticsOf({ metrics: metrics({ state: 'error' }) }),
        }),
      ),
    ).toBe('player-critical-error');
  });

  it('timeout-waiting-for-event: says which event, which media time, which request, or that the whole test ran out', async () => {
    const hook = classify(
      failure({
        message: await hookWaitTimeout('seeked', { timeoutMs: 20_000, detail: { reason: 'abr' } }),
        diagnostics: diagnosticsOf({
          events: [event(0, 'load-requested'), event(1, 'buffering-start')],
          metrics: metrics({ state: 'buffering' }),
        }),
      }),
    );
    expect(hook.verdict.rule).toBe('hook-wait-timed-out');
    expect(hook.verdict.evidence[0]).toBe(
      'waited 20000 ms for the seeked event with detail {"reason":"abr"} and it did not come',
    );
    expect(hook.verdict.evidence.join('\n')).toContain('the timeline has 2 events and ends with “#1 t=');
    expect(hook.verdict.evidence.join('\n')).toContain('player state at the end: buffering');

    const clock = classify(failure({ message: await hookMediaTimeTimeout(7, 5.973) }));
    expect(clock.verdict.rule).toBe('media-clock-wait-timed-out');
    expect(clock.verdict.evidence[0]).toBe(
      'waited 15000 ms for the media clock to reach 7 s; it was at 5.973 s',
    );

    const requests = classify(failure({ message: await requestWaitTimeout() }));
    expect(requests.verdict.rule).toBe('request-log-wait-timed-out');
    expect(requests.verdict.evidence[0]).toBe(
      'waited 15000 ms for a request in the origin’s log and it did not come',
    );

    const call = failure({
      message:
        'Error: page.goto: Timeout 15000ms exceeded.\nCall log:\n  - navigating to "http://127.0.0.1:4731/player/"',
    });
    expect(rule(call)).toBe('page-call-timed-out');
    const whole = classify(failure({ message: 'Error: Test timeout of 45000ms exceeded.' }));
    expect(whole.verdict.rule).toBe('test-timed-out');
    expect(whole.verdict.evidence[0]).toBe('the whole test ran past 45000 ms');
    expect(whole.verdict.evidence).toContain('there is no timeline: the player page was never read');
    expect(whole.failureClass).toBe('Functional regression');
  });

  it('metric-regression: an assertion on a measured quantity, with the player’s own numbers; a state assertion is not one', () => {
    const f = failure({
      message: rebufferAssertion(1, 2),
      diagnostics: diagnosticsOf({ metrics: metrics({ rebuffers: 2, dropped: 13, decoded: 366 }) }),
    });
    const verdict = classify(f);
    expect(verdict.verdict.rule).toBe('metric-assertion-failed');
    expect(verdict.failureClass).toBe('Performance regression');
    expect(verdict.verdict.evidence[0]).toContain('the assertion is on metrics.rebuffer.count');
    expect(verdict.verdict.evidence[1]).toBe(
      'the player’s own numbers: 2 rebuffers totalling 800 ms, 13 of 366 frames dropped, startup 900 ms',
    );
    expect(
      rule(failure({ message: 'Error: player state (metrics.state): the player is in the error state' })),
    ).toBe('no-rule-matched');
  });

  it('no-rule-matched: says so, quotes the line, and sends a person to read it', () => {
    const verdict = classify(failure({ message: 'Error: something nobody wrote a rule for' }));
    expect(verdict.verdict).toStrictEqual({
      rule: 'no-rule-matched',
      category: 'unknown',
      evidence: ['no rule matched “Error: something nobody wrote a rule for”'],
      cause: null,
    });
    expect(verdict.failureClass).toBe('Needs a person');
    expect(classify(failure({ message: '' })).verdict.rule).toBe('no-rule-matched');
  });
});

describe('PB-LAB-005 triage rules: the first rule that finds something wins, and a cause comes before its symptom', () => {
  const ended = playerEnded(1001, 'BAD_HTTP_STATUS', 1);
  const detail = faultSession({ id: 'f1', type: 'status', status: 503 });

  it('a fault that fired and a player that failed explain a timeout: the timeout is the symptom', async () => {
    const message = await hookWaitTimeout('firstframe');
    const symptomOnly = failure({ message });
    const withCause = failure({
      message,
      diagnostics: diagnosticsOf({ ...ended, detail, log: refusedLog(['f1']) }),
    });
    expect(rule(symptomOnly)).toBe('hook-wait-timed-out');
    expect(rule(withCause)).toBe('fault-fired-player-failed');
  });

  it('origin failures nobody injected explain a timeout too, and a media error explains a failed state assertion', async () => {
    const message = await hookWaitTimeout('firstframe');
    const origin = failure({
      message,
      diagnostics: diagnosticsOf({ events: ended.events, detail: sessionDetail([]), log: refusedLog([], 4) }),
    });
    expect(rule(origin)).toBe('origin-failed-without-fault');
    const media = failure({
      message,
      diagnostics: diagnosticsOf(playerEnded(3015, 'MEDIA_SOURCE_OPERATION_THREW', 3)),
    });
    expect(rule(media)).toBe('media-error');
  });

  it('an error the player reported comes before a metric assertion that its failure made fail', () => {
    const f = failure({
      message: rebufferAssertion(0, 1),
      diagnostics: diagnosticsOf({
        ...playerEnded(4001, 'DASH_INVALID_XML', 4),
        metrics: metrics({
          state: 'error',
          rebuffers: 1,
          errors: [shakaError(4001, 'DASH_INVALID_XML', 4, 2)],
        }),
      }),
    });
    expect(rule(f)).toBe('player-critical-error');
  });

  it('a fault that was fired and then not recovered is not read as a fault that was never felt, whatever the message says', () => {
    const message =
      'Error: the fault rule f1 {"type":"status"} named 2 of the 3 requests it was waited for within 15000 ms: the player stopped asking';
    const f = failure({
      message,
      diagnostics: diagnosticsOf({ ...ended, detail, log: refusedLog(['f1'], 2) }),
    });
    expect(rule(f)).toBe('fault-fired-player-failed');
    const quiet = failure({
      message,
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested')],
        detail,
        log: refusedLog(['f1'], 2),
      }),
    });
    expect(rule(quiet)).toBe('fault-premise-not-met');
  });

  it('what the environment says comes before what the diagnostics say: a dead service is not a fault that was not recovered', () => {
    const f = failure({
      message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      diagnostics: diagnosticsOf({ ...ended, detail, log: refusedLog(['f1']) }),
    });
    expect(rule(f)).toBe('service-not-reachable');
  });

  it('PB-ENV-001 defers to the page when the cause it quotes is the page that did not boot (a real run: a CSP that blocked the scripts failed the check in every engine)', () => {
    const quoted = [
      'the player page did not boot (http://127.0.0.1:4740/player/?manifest=%2Fs%2F7f8d99d19e31%2Fvod-cmaf%2Fdash%2Fmanifest.mpd): Timeout 15000ms exceeded.',
      'The browser console said:',
      "  error: Loading the script 'http://127.0.0.1:4740/player/shaka.js' violates the following Content Security Policy directive: \"script-src 'none'\".",
    ].join('\n');
    const f = failure({ message: environmentCheckFailure(quoted) });
    const verdict = classify(f);
    expect(verdict.verdict.rule).toBe('page-did-not-boot');
    expect(verdict.verdict.category).toBe('page-boot-failure');
    expect(verdict.verdict.evidence.join('\n')).toContain('Content Security Policy');
    // The check still names the environment when the page came up and the engine could not play: that is what it is for.
    expect(
      rule(
        failure({ message: environmentCheckFailure("qa.waitFor('firstframe') timed out after 15000 ms") }),
      ),
    ).toBe('environment-check-failed');
    // And when the page did not boot because the service is not there, the service is the cause.
    expect(
      rule(
        failure({
          message: environmentCheckFailure(
            'the player page did not boot (http://x/player/): net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4740/player/',
          ),
        }),
      ),
    ).toBe('service-not-reachable');
  });

  it('a gap comes before everything else', async () => {
    const message = await hookWaitTimeout('error', { detail: { codeName: 'MISSING_EME_SUPPORT' } });
    const f = failure({ message, diagnostics: diagnosticsOf({ ...ended, detail, log: refusedLog(['f1']) }) });
    expect(rule(f)).toBe('documented-gap-confirmation-failed');
  });

  it('is decided by the message and the diagnostics only: not by the engine, the retries, the durations or the ids', async () => {
    const message = await hookWaitTimeout('firstframe');
    const diagnostics = diagnosticsOf({ ...ended, detail, log: refusedLog(['f1']) });
    const one = classify(failure({ message, diagnostics, project: 'chromium', retries: 1, durationMs: 100 }));
    const two = classify(
      failure({
        message,
        diagnostics,
        project: 'webkit',
        retries: 0,
        durationMs: 99999,
        id: 'PB-ABR-006',
        envId: null,
      }),
    );
    expect(two.verdict).toStrictEqual(one.verdict);
  });

  it('keeps the cause of a flaky failure the same: the outcome is not evidence', async () => {
    const message = await hookWaitTimeout('firstframe');
    const flaky = classify(failure({ message, outcome: 'flaky', failedAttempts: 1 }));
    expect(flaky.verdict.rule).toBe('hook-wait-timed-out');
  });
});

describe('PB-LAB-005 triage rules: the cause behind a rule, which is what makes clusters one root cause', () => {
  const noticed = (
    log: ReturnType<typeof requestEntry>[],
    message = "Error: qa.waitFor('firstframe') timed out after 15000 ms",
  ) =>
    failure({
      message,
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested'), event(1, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 1))],
        detail: sessionDetail([]),
        log,
      }),
    });
  const cause = (f: Failure): string | null => classify(f).verdict.cause;

  it('names an origin that failed by what it answered and to what, not by how many requests or which rung', () => {
    const many = noticed([
      requestEntry(1),
      ...Array.from({ length: 9 }, (_, i) => requestEntry(i + 2, { status: 503 })),
    ]);
    const few = noticed(
      [requestEntry(1, { status: 503, rep: 'v720' }), requestEntry(2, { status: 503, rep: 'a-aac' })],
      'Error: the fault rule f1 {"type":"status"} named 0 of the 3 requests it was waited for within 15000 ms: the player never asked for what the rule matches',
    );
    expect(cause(many)).toBe('the origin answered 503 on segment to requests no fault rule named');
    expect(cause(few)).toBe(cause(many));
    const init = noticed([requestEntry(1, { status: 404, kind: 'init', rep: 'v360' })]);
    expect(cause(init)).toBe('the origin answered 404 on init to requests no fault rule named');
    expect(cause(init)).not.toBe(cause(many));
    const cut = noticed([requestEntry(1, { status: 200, aborted: true, abortReason: 'error' })]);
    expect(cause(cut)).toBe('the origin answered a cut (error) on segment to requests no fault rule named');
  });

  it('names a recovery that failed by the kinds of fault that fired, not by the test or the rule ids', () => {
    const ended = playerEnded(1001, 'BAD_HTTP_STATUS', 1);
    const recovery = (type: string, id = 'f1') =>
      failure({
        message: 'Error: qa.waitForMediaTime(7) timed out after 15000 ms: the media clock is at 5.974 s.',
        diagnostics: diagnosticsOf({
          ...ended,
          detail: faultSession({ id, type, status: 404 }),
          log: refusedLog([id], 1),
        }),
      });
    expect(rule(recovery('status'))).toBe('fault-fired-player-failed');
    expect(cause(recovery('status'))).toBe('a fault of type status fired and the player did not recover');
    expect(cause(recovery('status', 'f2'))).toBe(cause(recovery('status')));
    expect(cause(recovery('abort'))).toBe('a fault of type abort fired and the player did not recover');
  });

  it('names a page that did not boot by whether a Content Security Policy blocked it', () => {
    const boot = (console: string[]) =>
      failure({
        message: 'Error: the player page did not boot (http://x/player/): Timeout 15000ms exceeded.',
        diagnostics: diagnosticsOf({
          console: console.map((text) => ({ type: 'error', text })),
        }),
      });
    expect(
      cause(
        boot([
          "Loading the script 'http://x/player/player.js' violates the following Content Security Policy directive",
        ]),
      ),
    ).toBe('the player page did not boot: a Content Security Policy blocked its scripts');
    expect(cause(boot([]))).toBe('the player page did not boot');
  });

  it('names a media error and a critical player error', () => {
    const media = (code: number, name: string) =>
      failure({
        message: 'Error: player state (metrics.state): the player is in the error state',
        diagnostics: diagnosticsOf(playerEnded(code, name, 3)),
      });
    // The engines say the same corrupt bytes with different codes: one cause.
    expect(cause(media(3015, 'MEDIA_SOURCE_OPERATION_THREW'))).toBe(cause(media(3016, 'VIDEO_ERROR')));
    const manifest = failure({
      message: 'Error: startup time (metrics.startupMs) is null: the first frame was never presented',
      diagnostics: diagnosticsOf(playerEnded(4001, 'DASH_INVALID_XML', 4)),
    });
    expect(rule(manifest)).toBe('player-critical-error');
    expect(cause(manifest)).toBe('the player reported DASH_INVALID_XML (code 4001)');
  });

  it('gives a cause to every rule that names one, and to no rule that only describes a symptom', () => {
    const symptoms = RULES.filter((r) => r.cause === undefined).map((r) => r.name);
    expect(symptoms).toStrictEqual([
      'fault-premise-not-met',
      'test-premise-not-met',
      'oracles-disagree',
      'hook-wait-timed-out',
      'media-clock-wait-timed-out',
      'request-log-wait-timed-out',
      'page-call-timed-out',
      'test-timed-out',
      'metric-assertion-failed',
    ]);
    for (const r of RULES.filter((one) => typeof one.cause === 'string')) {
      expect(r.cause, r.name).toMatch(/^[a-z].{15,}$/);
    }
    expect(classify(failure({ message: 'Error: nobody wrote a rule for this' })).verdict.cause).toBeNull();
  });
});

describe('PB-LAB-005 triage rules: the evidence is readable', () => {
  it('quotes lines without colour codes or runs of whitespace', () => {
    const verdict = classify(
      failure({
        message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED    at   http://127.0.0.1:4731/player/',
      }),
    );
    expect(verdict.verdict.evidence[0]).toBe(
      'the service could not be reached: “Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/”',
    );
  });

  it('has a first check that tells a person what to do, for every rule that can fire', () => {
    for (const r of RULES) expect(r.firstCheck).toMatch(/[.?]$/);
  });
});
