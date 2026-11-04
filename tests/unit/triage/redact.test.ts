import { describe, expect, it } from 'vitest';
import {
  containsSecret,
  redact,
  redactSecrets,
  redactValue,
  SECRET_PATTERNS,
  STEPS,
} from '../../../triage/redact.ts';
import { SECRETS } from './secrets.ts';

describe('PB-LAB-005 triage redaction: every secret pattern takes its secret out and leaves the sentence', () => {
  it('has a sample for every pattern of the list, so that a pattern added without a test is a failing test', () => {
    for (const { name } of SECRET_PATTERNS) expect(SECRETS[name], `a sample for ${name}`).toBeDefined();
    expect(Object.keys(SECRETS).sort()).toStrictEqual(SECRET_PATTERNS.map((p) => p.name).sort());
  });

  it.each(Object.entries(SECRETS))('%s', (name, secret) => {
    expect(containsSecret(secret), `the sample is a ${name}`).not.toBeNull();
    const text = `Error: request failed while using ${secret} for the call, then it gave up`;
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(containsSecret(out)).toBeNull();
    expect(out).toContain('Error: request failed');
    expect(out).toContain('then it gave up');
    // The key words of the sentence stay: a person can still see that something was there, and what kind.
    expect(out).toMatch(/<[a-z-]+>/);
  });

  it('names what it found in the placeholder of a token with a format of its own', () => {
    expect(redact(`key ${SECRETS['anthropic-api-key']} end`)).toBe('key <anthropic-api-key> end');
    expect(redact(`pat ${SECRETS['github-token']}.`)).toBe('pat <github-token>.');
    expect(redact(`aws ${SECRETS['aws-access-key-id']}`)).toBe('aws <aws-access-key-id>');
  });

  it('takes the live key out of a line that prints the environment, wherever it is written', () => {
    const key = SECRETS['anthropic-api-key'] as string;
    for (const line of [
      `ANTHROPIC_API_KEY=${key}`,
      `export ANTHROPIC_API_KEY="${key}"`,
      `{"anthropic_api_key": "${key}"}`,
      `x-api-key: ${key}`,
      `Authorization: Bearer ${key}`,
      `curl -H 'x-api-key: ${key}' https://api.example.com/v1/messages`,
      `?api_key=${key}&x=1`,
    ]) {
      const out = redact(line);
      expect(out, line).not.toContain(key);
      expect(out, line).not.toContain(key.slice(10, 30));
    }
  });

  it('redacts a header to its end of line, and a quoted one to its closing quote', () => {
    expect(redact('Cookie: session=abc; theme=dark\nnext line')).toBe('Cookie: <redacted>\nnext line');
    expect(redact('{"authorization": "Bearer abcdefghijklmnopqrstuvwxyz0123456789", "ok": true}')).toBe(
      '{"authorization": <redacted>, "ok": true}',
    );
  });

  it('takes the password out of a URL of any scheme, and keeps the rest of the address readable', () => {
    expect(redact(SECRETS['url-credentials'] as string)).not.toContain('hunter2');
    expect(redact('http://svc:pw1234567@127.0.0.1:4750/api/sessions')).toBe('http://<host>/api/sessions');
  });
});

describe('PB-LAB-005 triage redaction: what identifies a machine or a person', () => {
  it('keeps the path of a URL, which is what was asked of the service, and removes its host, query and fragment', () => {
    expect(
      redact(
        'the player page did not boot (http://127.0.0.1:4731/player/?manifest=%2Fs%2Fabc%2Fm.mpd&token=xyz#start): Timeout 15000ms exceeded.',
      ),
    ).toBe(
      'the player page did not boot (http://<host>/player/?<query>#<fragment>): Timeout 15000ms exceeded.',
    );
    expect(redact('GET https://cdn.example.com/s/1a2b3c4d5e6f/vod-cmaf/dash/manifest.mpd -> 503')).toBe(
      'GET https://<host>/s/1a2b3c4d5e6f/vod-cmaf/dash/manifest.mpd -> 503',
    );
    expect(redact('ws://localhost:9222/devtools/browser/abc and file:///Users/me/pb/a.html')).toBe(
      'ws://<host>/devtools/browser/abc and file://<home>/pb/a.html',
    );
  });

  it('keeps the punctuation that follows a host in a sentence (a real report put a comma after the endpoint of a draft)', () => {
    expect(redact('endpoint http://127.0.0.1:4731, NOT the live service')).toBe(
      'endpoint http://<host>, NOT the live service',
    );
    expect(redact('hosts http://a.example.com; http://b.example.com, and done')).toBe(
      'hosts http://<host>; http://<host>, and done',
    );
    // Said twice, it says the same.
    const once = redact('endpoint http://127.0.0.1:4731, NOT the live service');
    expect(redact(once)).toBe(once);
  });

  it('leaves a URL that has no query or fragment with just its host replaced, and a URL in prose with its full stop', () => {
    expect(redact('see https://example.com/docs.')).toBe('see https://<host>/docs.');
    expect(redact('GET http://127.0.0.1:4750/health -> 200')).toBe('GET http://<host>/health -> 200');
  });

  it('removes home directories of the three systems, CI workspaces, and the directories of other absolute paths', () => {
    expect(redact("open '/Users/someone/repos/playback-proof/.cache/streams/vod-cmaf/manifest.mpd'")).toBe(
      "open '<home>/repos/playback-proof/.cache/streams/vod-cmaf/manifest.mpd'",
    );
    expect(redact('/home/alice/work/x.ts and /root/.cache/ms-playwright/chromium')).toBe(
      '<home>/work/x.ts and <home>/.cache/ms-playwright/chromium',
    );
    expect(redact('C:\\Users\\Bob\\repos\\pb\\tests\\a.ts')).toBe('<home>\\repos\\pb\\tests\\a.ts');
    expect(redact('at /home/runner/work/playback-proof/playback-proof/tests/e2e/a.spec.ts:12:3')).toBe(
      'at <workspace>/tests/e2e/a.spec.ts:12:3',
    );
    expect(redact('/home/jenkins/agent/workspace/playback-proof@2/reports/chromium/playwright.json')).toBe(
      '<workspace>/reports/chromium/playwright.json',
    );
    expect(redact('ENOENT /var/folders/ab/cd1234/T/pw-run-9/trace.zip, and /opt/ci/build-77/out.log')).toBe(
      'ENOENT <path>/trace.zip, and <path>/out.log',
    );
  });

  it('removes emails, addresses and hostnames, and keeps the words around them', () => {
    expect(redact('contact someone@example.com or ops-team+pb@corp.internal')).toBe(
      'contact <email> or <email>',
    );
    expect(redact('connect ECONNREFUSED 127.0.0.1:4731 and 10.20.30.40')).toBe(
      'connect ECONNREFUSED <ip>:4731 and <ip>',
    );
    expect(redact('agent jenkins-3.build.corp.internal and runner.example.com and localhost')).toBe(
      'agent <host> and <host> and <host>',
    );
  });

  it('does not touch what is evidence: repo paths, file names, event names, error codes, catalog ids, Shaka namespaces, numbers', () => {
    for (const text of [
      "qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      'tests/e2e/rec/faults.ts:waitForFault @ tests/e2e/recovery.spec.ts',
      'PB-VOD-001 PB-ABR-006 v360 #3 f1 status 503 on segment',
      'BAD_HTTP_STATUS (code 1001, network, critical) and VIDEO_ERROR (3016)',
      'request-log.json qa-events.json README.md playwright.config.ts manifest.mpd 00001.m4s',
      'shaka.net.NetworkingEngine.RequestType.SEGMENT and shaka.util.Error',
      'rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 382 ms: at media time 8.01 s for 24 ms',
      'chromium 156.0.8078.4 in local-darwin-arm64 could not play vod-cmaf over dash',
      'the media clock is at 5.973 s and 13 of 366 frames were dropped (3.6 %)',
    ]) {
      expect(redact(text), text).toBe(text);
    }
  });

  it('is applied once: redacting what was redacted changes nothing', () => {
    const corpus = [
      `ANTHROPIC_API_KEY=${SECRETS['anthropic-api-key']} at http://127.0.0.1:4731/player/?x=1 from /Users/me/pb/a.ts by me@example.com`,
      'Cookie: a=b\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'GET https://runner.example.com/s/abc/manifest.mpd#frag 10.0.0.1 /var/tmp/x/y.log C:\\Users\\Al\\x.ts',
    ];
    for (const text of corpus) {
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
  });
});

describe('PB-LAB-005 triage redaction: the steps and the values', () => {
  it('has named steps, each of which takes out something of its own', () => {
    const names = STEPS.map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
    // One sample per step that the step alone changes: a step whose pattern was emptied, or never matches, fails here.
    const samples: Record<string, string> = {
      'private-key-block': SECRETS['private-key'] as string,
      'secret-headers': 'Authorization: abc',
      'anthropic-api-key': SECRETS['anthropic-api-key'] as string,
      'api-key': SECRETS['api-key'] as string,
      'github-token': SECRETS['github-token'] as string,
      'aws-access-key-id': SECRETS['aws-access-key-id'] as string,
      'google-api-key': SECRETS['google-api-key'] as string,
      'slack-token': SECRETS['slack-token'] as string,
      'payment-key': SECRETS['payment-key'] as string,
      'npm-token': SECRETS['npm-token'] as string,
      jwt: SECRETS.jwt as string,
      'bearer-token': SECRETS['bearer-token'] as string,
      'basic-credentials': SECRETS['basic-credentials'] as string,
      'url-credentials': 'ftp://user:secretpw@host/x',
      'secret-assignment': 'password=correct-horse-battery',
      url: 'http://127.0.0.1:4731/a?b=c',
      'long-hex': SECRETS['long-hex'] as string,
      email: 'me@example.com',
      ipv4: '10.0.0.1',
      hostname: 'build.corp.internal',
      localhost: 'localhost',
      'ci-workspace': '/home/runner/work/pb/pb/x.ts',
      'home-windows': 'C:\\Users\\me\\x',
      'home-macos': '/Users/me/x',
      'home-linux': '/home/me/x',
      'home-root': '/root/x',
      'system-path': '/var/folders/a/b/c.zip',
    };
    expect(Object.keys(samples).sort()).toStrictEqual([...names].sort());
    for (const step of STEPS) {
      expect(step.apply(samples[step.name] as string), step.name).not.toBe(samples[step.name]);
    }
  });

  it('redacts every string and every key of a JSON-safe value, and leaves the rest alone', () => {
    const value = {
      '/Users/me/pb/key': ['at http://127.0.0.1:4731/x?token=abc', 12, null, true],
      nested: { message: `leaked ${SECRETS['github-token']}`, count: 3 },
    };
    expect(redactValue(value)).toStrictEqual({
      '<home>/pb/key': ['at http://<host>/x?<query>', 12, null, true],
      nested: { message: 'leaked <github-token>', count: 3 },
    });
    expect(redactValue(7)).toBe(7);
    expect(redactValue(undefined)).toBeUndefined();
  });

  it('has a secrets-only form for a line the person who runs the tool reads on their own screen: the host stays, the key goes', () => {
    const line = `could not reach http://127.0.0.1:4751/v1/messages (key ${SECRETS['anthropic-api-key']}) from /Users/me/pb`;
    expect(redactSecrets(line)).toBe(
      'could not reach http://127.0.0.1:4751/v1/messages (key <anthropic-api-key>) from /Users/me/pb',
    );
    expect(redact(line)).toBe(
      'could not reach http://<host>/v1/messages (key <anthropic-api-key>) from <home>/pb',
    );
  });

  it('finds nothing in text that has no secret, and names the first pattern that fits when there is one', () => {
    expect(containsSecret("qa.waitFor('seeked') timed out after 15000 ms")).toBeNull();
    expect(containsSecret('a 12 character name: abcdef012345')).toBeNull();
    expect(containsSecret(`x ${SECRETS['jwt']} y`)).toBe('jwt');
    expect(containsSecret(`x ${SECRETS['anthropic-api-key']} y`)).toBe('anthropic-api-key');
  });
});
