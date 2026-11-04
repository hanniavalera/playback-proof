# Failure triage on the real failures of the lab

Seven different root causes were induced on purpose in a scratch copy of the lab and run through the **real specs of the merge tier**, one Playwright run at a time. Their failures were collected, reduced to fixtures ([`tests/fixtures/triage/`](../../../tests/fixtures/triage)), clustered by [`npm run triage`](../../TRIAGE.md) and read. This page says what was done, what came out, and where the clustering was wrong and what was changed because of it. The summarizer (the optional model draft) was **not** run against the live service: it was run against a local mock, and the output of that is labelled as one ([below](#the-model-summary-mock-only)).

**Result.** 7 root causes induced, **31 failed tests**, **12 clusters**, **8 root causes**: each induced cause is its own root cause and none is merged with another; the one that became two is a slow origin, which fails no request (below). The report is [`triage-report.md`](triage-report.md) and [`triage-report.json`](triage-report.json), made from the committed fixtures with `npm run triage -- --from tests/fixtures/triage --out docs/results/triage --redact`.

## What was run

| | |
| --- | --- |
| Machine | Apple M2 Pro, 12 cores, macOS 27.2 (arm64), Node v22.11.0, Playwright 1.64.1; Chromium 156.0.8078.4 and WebKit 27.2 from Playwright. Firefox is a documented gap on this host: its tests are skipped with the reason (3 skips in the CSP run), so no failure here is a Firefox failure. |
| Code | the lab at commit `304ba90` (the triage collector of this branch), in a git worktree of its own, with `node_modules` and `.cache/streams` cloned (APFS) from the repository worktree. The specs, the config and the lab were **not** changed: only what each experiment says below, in the scratch worktree, and reverted after each (`git status` clean). |
| Runs | `npx playwright test --retries=1 --workers=1`, one browser at a time, the service started by the `webServer` of the config on port 4740, the report written next to the others as the Jenkinsfile does (`PLAYWRIGHT_JSON_OUTPUT_FILE=reports/<experiment>/playwright.json`, the same for the HTML report and the flake run file). The machine was shared with other work: `uptime` was recorded before and after each run (below). |
| Reduction | `npx tsx tools/triage-fixture.ts --from <report> --out tests/fixtures/triage/<experiment>`: the failed and skipped tests, the lab's failure attachments as readable files (the request log shortened to the first and last entries and the failed requests when it was long), the checkout written as `/work/playback-proof`, no passed test, no trace, no screenshot. Checked for each of the seven: the fixture clusters **exactly** like the full report it came from (same clusters, signatures, categories, rules, causes and evidence). |

## The seven experiments

| # | Root cause induced | How (the real specs are unchanged) | Tests run | Result of the run |
| --- | --- | --- | --- | --- |
| 1 | the service is not running | a config with no `webServer` (`export default { ...base, webServer: undefined }`) | `--grep @merge`, 3 engines | no test starts: the global setup fails (`GET /health -> no answer ECONNREFUSED`) |
| 2 | a stream file is truncated in the cache | `truncate -s` to half of `v360/3.m4s` of `vod-cmaf` in the cloned cache (172,247 to 86,123 bytes) | `--grep @merge`, chromium | the service refuses to start (it says so in its output: `stream vod-cmaf is missing`), Playwright reports `Process from config.webServer was not able to start. Exit code: 1` |
| 3 | the player page is served with a Content Security Policy that blocks scripts | [`csp-blocks-scripts.patch`](experiments/csp-blocks-scripts.patch): `script-src 'none'` in `src/player/index.html` | PB-VOD-001, PB-VOD-002, PB-ENV-001, all projects | 7 failed (chromium 3, webkit 3, chromium-cpu4x 1), 3 skipped (firefox) |
| 4 | the origin answers 503 to every segment, with no fault rule on it | [`origin-503.patch`](experiments/origin-503.patch): one line in `serveMedia` | PB-VOD-001, 002, 006, PB-REC-001, 002; chromium, webkit | 10 failed |
| 5 | the cache holds corrupted segments (same size, so the service's check passes) | `dd` zeroes 4,000 bytes at offset 836 of `1.m4s` of `v240`, `v360` and `v720` in the cloned cache | PB-VOD-001, 002, 006; chromium, webkit | 6 failed |
| 6 | the player lost its retry and failover policy | [`retry-disabled.patch`](experiments/retry-disabled.patch): `streaming.maxDisabledTime: 0` and `retryParameters.maxAttempts: 1` in configuration A | PB-REC-001, 002, and PB-VOD-001 as a control; chromium, webkit | 4 failed (the recovery specs), the control passed in both |
| 7 | the origin is 2.5 s slower for every media segment (a segment is 2 s) | [`origin-slow.patch`](experiments/origin-slow.patch): 2,500 ms added to the latency of a segment | PB-VOD-006, 007, 012; chromium | 2 failed (006 and 012), 007 passed. **Run twice**: the same two clusters with the same keys |

`uptime` (load averages over 1, 5 and 15 minutes), before and after each run: 1 `4.90 3.16 2.13` then `4.82 3.18 2.14` · 2 `4.76 3.22 2.17` then `4.86 3.26 2.19` · 3 `4.18 3.21 2.20` then `2.52 3.03 2.37` · 4 `2.02 2.81 2.32` then `3.85 3.34 2.70` · 5 `2.70 3.14 2.67` then `3.45 3.20 2.78` · 6 `4.92 3.57 2.92` then `6.85 5.57 3.89` · 7 `5.76 5.45 3.90` then `3.96 4.95 3.82`; second run of 7 `3.15 4.29 4.04` then `2.49 3.91 3.92`. Every cause is induced by what the service sends or what the player is configured to do, never by a duration the machine has to meet, so the outcome does not depend on the load; experiment 7 is the one that comes nearest, which is why it was run twice (and a delay of 2.5 s against a 2 s segment makes the origin slower than the playback whatever the machine does). No rule or signature was changed to fit a timing-dependent result.

## What triage made of them

Each experiment read alone, then all seven read as one directory of artifacts:

| # | Cause | Failed | Clusters (signature) | Category · rule | Root causes | Grouped and separated as expected? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | service down | 1 (run) | 1 | `environment` · `service-not-reachable` | 1 | yes |
| 2 | truncated cache | 1 (run) | 1 | `environment` · `run-failed-before-any-test` | 1 | yes; the cause (a stream file) is in the service's output, not in the report |
| 3 | CSP | 7 | 2: the start specs (5, three engines) and the environment check (2, two engines) | `page-boot-failure` · `page-did-not-boot` (both) | 1 | yes, after two fixes (below): the check had blamed the environment and had split by engine |
| 4 | 503 on every segment | 10 | 3: first-frame timeouts (6), the fault of REC-001 never felt (2), of REC-002 never felt (2) | `origin-error` · `origin-failed-without-fault` (all three, 14 requests failed with no fault rule) | 1 | yes: three symptoms, one root cause |
| 5 | corrupted segments | 6 | 1 (both engines, tests 001, 002, 006) | `decode-or-mse-error` · `media-error` ("the origin delivered every request it was asked for: the bytes themselves are suspect") | 1 | yes, after a fix: Chromium said 3016 and WebKit 3015 |
| 6 | retry and failover disabled | 4 | 2: the media clock of REC-001 (2), the fault of REC-002 (2) | `network-fault-not-recovered` · `fault-fired-player-failed` (both) | 1 | yes: two symptoms, one root cause |
| 7 | slow origin | 2 | 2: a premise that did not hold (VOD-006), a rebuffer count (VOD-012) | `instrument-disagreement` · `test-premise-not-met`, `metric-regression` · `metric-assertion-failed` | 2 | **no, by design**: the cause fails no request and nothing in the evidence ties the two |
| all | seven read as one | **31** | **12** | | **8** | none merged across experiments; each experiment's clusters are the ones it has alone |

## What was wrong, and what changed (each with a test, and none by editing a fixture)

1. **The environment check blamed the environment for a page that did not boot** (3). PB-ENV-001 quotes what the player said; here that was `the player page did not boot` with a Content Security Policy violation in the console. The rule `environment-check-failed` now defers when the quoted cause is a page that did not boot; the page rules take it, and the cause is named.
2. **One cause split by engine** (3). The check's message names the engine and the environment (`chromium 156.0.8078.4 in local-darwin-arm64 could not play ...`). The signature now writes them `<engine>` and `<env>`.
3. **One cause split by engine, again** (5). WebKit reported the corrupt bytes as Shaka 3015 and Chromium as 3016, and the signature carried the critical code. A critical error of the media category is now `{shaka media}`; every other code is kept.
4. **Two causes merged** (found reading experiments 4 and 6 together). The recovery specs quote the whole fault rule as JSON before the sentence that matters, so the cut of the signature at 200 characters fell before the words that tell "the player never asked, because the origin is down" from "the player stopped asking, because it gave up". The JSON of a fault rule is now `{…}` in the signature.
5. **One cause in several clusters** (3, 4, 6). Different specs word one cause differently. Rules that name a cause now also say what exactly is broken (`the origin answered 503 on segment to requests no fault rule named`) and clusters with the same rule and cause are one **root cause**: the headline says `12 clusters of 8 root causes`, the report has a table of the root causes several clusters share, and the JSON has `rootCauses`.
6. **A premise failure was `unknown`** (7). PB-VOD-006 says `premise of the test, not the behaviour under test: ...` when what it needs before it can judge is missing. A rule (`test-premise-not-met`, class `Needs a person`) names it.
7. **The reduced fixtures read as one directory lost their attachments.** The collector looked for an attachment kept as a file only under the directory it was given; it now looks beside the report that names it first.
8. **A real `--list` report was read as 66 skips with no reason** (found on a report of the main checkout, before the experiments). A test with no attempt is now `not run`, which is neither a failure nor a skip.
9. **The mock demo left drafts in the cache that a real run would have served.** The cache key of a draft now includes the endpoint, and a cached draft of a local test double says so.

## The limits that these runs showed

- A **slow origin** is two root causes, a premise and a rebuffer count: it fails no request, and no rule reads the timings of the request log (a threshold would be tuned on timing).
- A **service that refuses to start** is `run-failed-before-any-test`: the report has Playwright's error, and why the service stopped is in its own output, which is in the job log.
- Firefox was not run (a documented gap on this host), so the wording table of a refused connection in Firefox and WebKit is still compared with no failure of the lab.
- The seven runs are seven builds read as one directory to see that causes are not merged: in one real build a test fails once per engine, and these runs fail some tests (PB-REC-001, 002; PB-VOD-001, 002, 006) in several experiments.

## The model summary (mock only)

**No key exists on this machine and the live service was never called.** The two outputs below are of the summarizer against [`tools/triage-mock.ts`](../../../tools/triage-mock.ts), a local test double with the documented request and response shapes, on `127.0.0.1:4731`, with a placeholder key that is not a key (the mock accepts any). Every draft is labelled `NOT the live service`, and says `[MOCK] no model wrote this`.

| File | What it is | Command |
| --- | --- | --- |
| [`summarize-with-mock-output.txt`](summarize-with-mock-output.txt), [`summarize-with-mock/`](summarize-with-mock) | the console and the report of a run with `--summarize` against the mock: 12 requests, one per cluster, 12 drafts, exit 0 | `npx tsx tools/triage-mock.ts --port 4731` in one shell, then `ANTHROPIC_API_KEY=<placeholder> ANTHROPIC_BASE_URL=http://127.0.0.1:4731 npm run triage -- --from tests/fixtures/triage --summarize --max-clusters 12 --redact --out docs/results/triage/summarize-with-mock` |
| [`no-key-output.txt`](no-key-output.txt) | the same run with **no key**: the clusters only, `summaries skipped: ANTHROPIC_API_KEY is not set` on one line, no request, exit 0 | `env -u ANTHROPIC_API_KEY npm run triage -- --from tests/fixtures/triage --summarize --redact` |

**The command to run with a real key** (not run here): `ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-haiku-5-5 npm run triage -- --from reports --summarize`.

## Reproducing and checking

```sh
npm run triage -- --from tests/fixtures/triage --out docs/results/triage --redact   # triage-report.md and .json (only generatedAt differs)
npx vitest run tests/unit/triage/real-failures.test.ts                             # the clusters of each experiment, pinned
npx vitest run tests/unit/triage/committed-files.test.ts                           # no secret, home path, email, host or user name in what is committed
```

To induce a failure again: make a worktree of the commit (`git worktree add --detach <dir> <commit>`), clone `node_modules` and `.cache/streams` into it, apply a patch from [`experiments/`](experiments) with `git apply`, run the specs of the table with `PB_PORT=<a free port in your range>`, and read `reports/<experiment>/playwright.json` with `npm run triage`. The patches apply to `304ba90`; the service-down config and the two cache changes are in the table.
