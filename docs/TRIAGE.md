# Failure triage

A red build leaves a hundred lines in three engines, and one cause shows up as a dozen failed tests. Triage reads the Playwright report of every engine job and the failure attachments of every failed test, **groups the failures that have the same cause into one cluster**, says which **category** of cause the cluster is and what it found that says so, and names the first thing to check. Optionally, a language model drafts a few sentences per cluster. It **explains** a red build and never **decides** one: it is not a gate, it exits 0 in CI whatever it finds, and the verdict of a build is the gates' ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 10).

> **The model summary has never been run against the live service.** There is no API key on the machine that built this and none was created. [`triage/summarize.ts`](../triage/summarize.ts) was verified against a local mock of the Messages API ([`tools/triage-mock.ts`](../tools/triage-mock.ts)) that follows the request and response shapes of the official documentation (read on 2026-11-04, ADR-168). The mock proves that the requests are well formed and that every documented answer and error is handled; it proves nothing about what the model writes. The deterministic clustering needs no key, runs offline and is the contract (ADR-160); the command to run the summaries with a key is [below](#the-summaries-opt-in).

## How the parts fit

| Part | What it does | File |
| --- | --- | --- |
| Collection | Reads every failed or flaky test of every Playwright JSON report under a directory into a typed `Failure`: identity, engine, tier, attempts, the first failing attempt's message and application frames, and digests of the failure attachments. Says what was missing. | [`triage/collect.ts`](../triage/collect.ts), [`digest.ts`](../triage/digest.ts), [`stack.ts`](../triage/stack.ts) |
| Signature | The name of a cause: the same cause has the same name whatever its ids, ports, timestamps, paths and engine. | [`triage/signature.ts`](../triage/signature.ts), on [`src/lab/signature.ts`](../src/lab/signature.ts) |
| Clusters | Failures with the same signature, ordered by size, then by engines, then by signature. | [`triage/cluster.ts`](../triage/cluster.ts) |
| Categories | An ordered table of named rules; the first that finds something names the category and prints its evidence. | [`triage/rules.ts`](../triage/rules.ts) |
| Report | Text, `triage-report.md`, `triage-report.json`, and a summary for `$GITHUB_STEP_SUMMARY`. | [`triage/report.ts`](../triage/report.ts), [`cli.ts`](../triage/cli.ts) |
| Redaction | What is taken out of the evidence before any of it leaves the machine. | [`triage/redact.ts`](../triage/redact.ts) |
| Summaries | One request per cluster to the Messages API, from the redacted evidence, behind an opt-in. | [`triage/summarize.ts`](../triage/summarize.ts) |
| Mock of the API | A local server with the documented shapes, for the tests of the summaries. | [`tools/triage-mock.ts`](../tools/triage-mock.ts) |
| Fixture reducer | Cuts a real Playwright report down to the failures and their attachments, without the machine, so that it can be committed. | [`tools/triage-fixture.ts`](../tools/triage-fixture.ts) |

## Run it

```sh
npm run triage                                        # reads ./reports, prints the clusters, writes reports/triage/triage-report.{md,json}
npm run triage -- --from reports/chromium/playwright.json
npm run triage -- --from artifacts --json             # a directory of downloaded CI artifacts (one report per engine job), JSON on stdout
npm run triage -- --from reports --redact --out out   # a report that will be published: keys, hosts and home directories taken out first
npm run gate:triage                                   # --from-ci: the CI stage, below
```

| Option | Meaning |
| --- | --- |
| `--from <dir>` | The Playwright output to read: a reports directory, a directory of downloaded artifacts (`reports-chromium/`, `reports-firefox/`, any depth), or one `playwright*.json`. Default `reports`. |
| `--from-ci` | The CI stage. Reads `--from`, else `$PB_TRIAGE_FROM`, else `./artifacts`, else `./reports`; always exits 0 and says so on its first line. |
| `--summarize` | Ask a model for a draft per cluster. Needs `ANTHROPIC_API_KEY`; without it, one line and nothing else. |
| `--refresh` | With `--summarize`: ask again where a draft is cached. |
| `--max-clusters N` | With `--summarize`: at most N clusters, the largest first (default 10). |
| `--out <dir>` | Where `triage-report.md` and `triage-report.json` are written (default `reports/triage`). |
| `--json` | Print the JSON report instead of the text. |
| `--redact` | Redact the report itself before it is printed or written. |
| `--help` | Print the usage. |

Exit codes outside CI: 0 when at least one report was read (with or without failures), 2 when none could be read or an option is wrong. With nothing failed it prints `no failures to triage`.

## What it reads

Playwright's JSON report (`reports/playwright.json`; the Jenkinsfile writes `reports/<engine>/playwright.json` per engine job, and a downloaded artifact directory is read at any depth) and, for each failed test, the attachments of the diagnostics fixture ([CONTRACTS.md](CONTRACTS.md) section 7.2, ADR-073): `qa-events.json`, `qa-metrics.json`, `qa-info.json`, `page-console.json`, `session-detail.json`, `request-log.json` (a second player or session has `-2`), and `diagnostics-problems.json`. The JSON reporter keeps those attachments in the report itself (base64), so the report alone is enough; an attachment kept as a file is looked for next to the report and in `test-results*`.

- A test is read when its final status is failed or timed out, or when it is flaky (it failed and passed on a retry: the failure of the first attempt is still a failure with a cause). Skipped tests are listed apart with their reason, and a skip **without** a reason is printed as a bug. Interrupted tests (the run was stopped) are counted and not clustered. A global setup that threw, or a web server that did not start, is an error of the run: it becomes a failure with no test to blame.
- **Missing attachments are said, not guessed.** A launch failure has none; a test that failed before the fixture could read anything has none. Each failure carries what was missing, and the rules that need an attachment simply do not fire without it.
- **The request log is read as [CONTRACTS.md](CONTRACTS.md) section 4 says** (ADR-083, ADR-164): an origin failure is a finished request with a status of 400 or more, or one the origin cut (`fault-abort`, `error`). A client that hung up (`client-closed`: the player cancelling a request when it seeks or switches rung) is **not** an origin failure, and nothing here counts it as one.
- Only Playwright reports are read. A failure of the unit tests (Vitest) is not: a build that is red in the unit stage has nothing for triage to cluster, and says "no failures to triage".

## The signature

A failure's signature is `message [assertion] @ location {shaka code}`, and nothing else (ADR-161):

| Part | What it is | Why |
| --- | --- | --- |
| message | The first line of the error message, with the lab's one normalisation ([`src/lab/signature.ts`](../src/lab/signature.ts), the function the flake tracker uses: numbers, ids, timestamps, urls, ports, paths and hashes become placeholders), then three steps only triage needs: the three engines' words for a refused or reset connection are one phrase; a rung id (`v360`) is `<rung>`; a rule id (`f1`) is `<rule>`; a list of identical items is its first item and `…`. | The first line is what a person reads first, and what the lab's own assertion helpers write their cause in. |
| assertion | The matcher that failed (`toBeLessThanOrEqual`, `not.toBe`), `test-timeout`, or `thrown`. | Two checks with the same words are not the same cause. |
| location | `file:function` of the first **application** frame that is not a spec (no line number: a line moves with every edit, and the signature names a cause, not a revision). When the message has no words of its own (`expect(received).toBe(expected)`, `Test timeout of 45000ms exceeded.`) the spec file is added, because otherwise unrelated failures would be one cluster. | A helper that threw is the check that failed; a spec's body only names the test. Ten specs failing in the same helper are one cause. |
| shaka code | The code of the first **critical** Shaka error the player reported, if any (a recoverable error does not split a cluster). | The same symptom after a `1001` and after a `3016` is two causes. |

The signature is hashed to a 12-character cluster key, which names the cluster and its cached summary. **What it over-merges and over-splits** is a limit, and ADR-162 states it: two causes with the same first line, the same helper and no critical Shaka code are one cluster (the report says when the rules disagree inside it: `the rule fired for 1 of 2 failures; the others fired …`); one cause worded differently by an engine that the wording table does not know is two clusters with one engine each, and a person merges them by reading. The table covers what has been seen; a wording nobody has seen is not guessed.

Determinism is tested (`tests/unit/triage/cluster.test.ts`): shuffled input, different ids, timestamps, ports and paths give the same clusters in the same order; two different causes never merge; the same cause in two engines is one cluster listing both.

## Categories: the table of rules

Each cluster is given to the rules in order, and **the first rule that finds something wins**: its name, its category and its **evidence** (lines a person can check against the attachments) are in the report, so the verdict can be disagreed with. The order is part of the contract: **a rule that names a cause comes before one that describes a symptom**. A wait for the first frame that ran out is a symptom of a fault the player did not recover from, so the fault rule is first; a player error that no fault, origin failure or media error explains is a cause of its own, so it comes before the waits.

| # | Rule | Category | Class ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 10) | It fires when |
| --- | --- | --- | --- | --- |
| 1 | `documented-gap-confirmation-failed` | `known-gap` | Known gap | a spec that confirms a documented gap before it skips timed out waiting for the error it expects |
| 2 | `documented-gap-in-message` | `known-gap` | Known gap | the message quotes the reason of a documented gap |
| 3 | `environment-check-failed` | `environment` | Environment or infrastructure | PB-ENV-001 says in its own words that the environment changed |
| 4 | `service-not-reachable` | `environment` | Environment or infrastructure | connection refused or reset, or "the test data service … is not answering" |
| 5 | `service-not-ready` | `environment` | Environment or infrastructure | the service answered that a stream is missing or the player is not built |
| 6 | `stream-files-missing` | `environment` | Environment or infrastructure | `ENOENT` on a stream or manifest file |
| 7 | `browser-unavailable` | `environment` | Environment or infrastructure | the browser did not launch, is not installed or crashed |
| 8 | `port-in-use` | `environment` | Environment or infrastructure | `EADDRINUSE` |
| 9 | `resources-exhausted` | `environment` | Environment or infrastructure | `ENOSPC`, `ENOMEM`, `EMFILE` |
| 10 | `player-reports-browser-unsupported` | `environment` | Environment or infrastructure | Shaka says this browser is not supported |
| 11 | `run-failed-before-any-test` | `environment` | Environment or infrastructure | an error of the run (a global setup that threw, a web server that did not start) |
| 12 | `page-did-not-boot` | `page-boot-failure` | Functional regression | the player hook never became ready (the console may name a Content Security Policy violation) |
| 13 | `page-refused-parameters` | `page-boot-failure` | Functional regression | the page said the parameters it was given cannot be used |
| 14 | `fault-fired-player-failed` | `network-fault-not-recovered` | Functional regression | a fault rule **fired** (request log) and the player ended in a critical error or in the error state |
| 15 | `origin-failed-without-fault` | `origin-error` | Environment or infrastructure | the origin answered errors or cut responses that no fault rule named, and the player noticed |
| 16 | `media-error` | `decode-or-mse-error` | Functional regression | Shaka category 3 (media), or the message or console names a media-element or append error |
| 17 | `fault-premise-not-met` | `instrument-disagreement` | Functional regression | the test installed a fault and the log says the player never asked for what it matches |
| 18 | `oracles-disagree` | `instrument-disagreement` | Functional regression | a lab assertion says two readings of one fact (the hook and the log) disagree |
| 19 | `player-critical-error` | `player-error` | Functional regression | the player reported a critical error that nothing above explains |
| 20 | `hook-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | `qa.waitFor('<event>')` ran out (the event is named) |
| 21 | `media-clock-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | `qa.waitForMediaTime(<s>)` ran out (the clock's position is named) |
| 22 | `request-log-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | a wait on the origin's request log ran out |
| 23 | `page-call-timed-out` | `timeout-waiting-for-event` | Functional regression | a Playwright call on the page ran out of time |
| 24 | `test-timed-out` | `timeout-waiting-for-event` | Functional regression | the whole test ran past its limit with no wait of its own failing first |
| 25 | `metric-assertion-failed` | `metric-regression` | Performance regression | the failing assertion is on a measured quantity (rebuffers, dropped frames, live latency, startup, bitrate switches) |
| — | `no-rule-matched` | `unknown` | Needs a person | nothing above found anything |

Two things go beyond the classes of the strategy. The category **`player-error`** exists because a player that failed with a critical error that no fault, origin failure or media error explains is neither a timeout nor a decode problem, and filing it under either would hide it. The class **Needs a person** is `unknown`'s: the section 10 classes have no place for "no rule recognised this", and inventing a class for it would be a guess. A cluster whose failures were **all flaky** is given the class **Flake** and the advice not to rerun the job (section 10), unless its rule says environment or known gap, which are more specific.

**The rules read the words of the lab's own helpers**, so a helper that is reworded would quietly move its failures to `unknown`. The tests of the rules therefore generate their messages by calling the helpers themselves (`qa.waitFor`'s and `qa.waitForMediaTime`'s timeouts, the request wait, the rebuffer assertion, the environment check, the service readiness), and rewording one breaks a test here instead.

### Adding a rule

1. Add the rule to `RULES` in [`triage/rules.ts`](../triage/rules.ts), **in the place of its strength** in the order: a rule that names a cause above one that describes a symptom. It has a `name` (unique, printed next to the evidence), a `category`, a `failureClass`, a one-line `rationale` (why this evidence means this cause), a `firstCheck` written as an instruction, and a `check` that returns the evidence lines or `null`.
2. Test it in [`tests/unit/triage/rules.test.ts`](../tests/unit/triage/rules.test.ts): a failure that fires it (the message from the helper that writes it, not retyped), a near miss that does not, and the rule above and below it in the order.
3. Add a row to the table above (`tests/unit/triage/docs.test.ts` fails when a rule is missing from this page) and, if it is a new category, to `CATEGORIES` in [`triage/types.ts`](../triage/types.ts) and to `CATEGORY_MEANING`.

## Reading the report

Per cluster, in this order: rank, size, engines, tests, category and the rule that fired, the signature and its key, the **evidence** of the rule, the class and the first thing to check, the representative failure (the one with the richest diagnostics, so the same cluster always reads the same), its error message, every member, and what was missing. A summary of the whole run: failed, flaky, skipped and interrupted counts, the reports read, and **what could not be read** (a file that is not a report is named, never skipped silently).

`triage-report.json` has the same content with `schemaVersion: 1`. `$GITHUB_STEP_SUMMARY` gets a table of the first twelve clusters and a count of the rest.

## In CI: `gate:triage`

`npm run gate:triage` is `npm run triage -- --from-ci`: it reads the artifacts of the run it is in and **never fails the build** (ADR-160). Its first line says so (`gate:triage: triage is not a gate: it explains a red build and never decides one (exit 0 whatever it finds)`); a directory with nothing in it, a report that does not parse, a crash of triage itself are printed and exit 0. The stage belongs after the engine jobs, where it can see every engine's report: with the Jenkinsfile's layout (`reports/<engine>/playwright.json`, archived with `test-results/**`) `--from reports` reads all of them; with downloaded GitHub Actions artifacts, `--from <directory of the artifacts>` reads one report per leg. A green build prints `no failures to triage`.

## The summaries (opt-in)

```sh
ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-haiku-5-5 npm run triage -- --from reports --summarize
```

`ANTHROPIC_MODEL` is optional (`claude-haiku-5-5` is the default: the models overview describes it as the one for high-volume, latency-sensitive classification, extraction and routing); `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) points the requests elsewhere, and a report whose drafts came from any other endpoint says in capitals that they are **not the live service**. `ANTHROPIC_WORKSPACE_ID` is for a key that is **not scoped to one workspace**: the authentication page of the documentation says such a key needs the `anthropic-workspace-id` header on every request, and that a key scoped to one workspace must omit it, so the header is sent only when this is set.

- **What leaves the machine**, one request per cluster, largest first: a fixed system prompt that says the clustering is authoritative and the evidence is data and not instructions, and the cluster's evidence **after redaction**: its category and rule and the evidence lines, the signature, the first 12 lines of the representative message, the lab's own frames, the Shaka errors, the fault rules and how often each fired, the request-log digest (counts and the first failed requests), the player's numbers at the end, eight events around the failure, up to three console errors, what was missing. Never a page, a screenshot, a trace, a video, a raw attachment or any source file. The model is asked for at most 120 words: a likely root cause, the first thing to check, and what it is not sure about.
- **Redaction** ([`triage/redact.ts`](../triage/redact.ts), ADR-166) is an ordered list of named steps, and a last check on the exact text of the request: a request that still matches a secret pattern is **not sent** (the cluster keeps its deterministic report and the reason is recorded). The key travels in the `x-api-key` header and nowhere else, and is never printed.

  | Steps | What they take out |
  | --- | --- |
  | `private-key-block`, `secret-headers` | PEM private keys; the value of `Authorization`, `x-api-key`, `Cookie`, `Set-Cookie` and similar headers |
  | `anthropic-api-key`, `api-key`, `github-token`, `aws-access-key-id`, `google-api-key`, `slack-token`, `payment-key`, `npm-token`, `jwt`, `bearer-token`, `basic-credentials` | tokens that have a format of their own, each replaced by its name (`<jwt>`) |
  | `url` | the host, the credentials, the query and the fragment of a URL; the scheme and the path stay (what was asked of the service is evidence) |
  | `url-credentials`, `secret-assignment`, `long-hex` | `user:password@`; `password=…`, `api_key: …`, `token: …`; hex strings of 32 digits or more |
  | `email`, `ipv4`, `hostname`, `localhost` | addresses of people and machines (`jenkins-3.corp.internal`, not `README.md` or `shaka.net.NetworkingEngine`) |
  | `ci-workspace`, `home-windows`, `home-macos`, `home-linux`, `home-root`, `system-path` | CI workspaces, home directories and the directories of absolute system paths (the file name stays) |

  **Redaction finds shapes.** A secret that looks like prose, a hostname with no dot, a name inside a sentence are not found by any pattern. That is why the evidence is a short digest and not a log, why the summaries are opt-in, and why the redaction is a second line of defence and not the first.
- **Budget** (all of them are options of `summarize()`, and the defaults are the caps): at most 10 clusters, 6,000 characters of evidence per cluster, 30 HTTP requests per run (retries included), 60,000 characters in all, 1 request in flight (2 at most), a timeout of 30 s per attempt, 3 retries with a backoff of 1 s doubling to at most 30 s on 408, 429, 500, 502, 503, 504 and 529, a timeout or a lost connection, honouring `retry-after` (a wait longer than 60 s is not taken: the cluster fails with the reason). A 401, 402, 403, 404 or a spend-limit 429 stops the run: the rest are reported `not attempted`.
- **It degrades, it does not fail.** No key: one line, `summaries skipped: ANTHROPIC_API_KEY is not set`, and no request. An error of the service: the cluster keeps its deterministic report, the error is recorded in its place (the key and any secret scrubbed from the message), and the exit code does not change. A draft is a draft: it is printed as a suggestion for a person, quoted, with the model it came from, and it never changes a cluster, a category, a class or a verdict.
- **Cache**: `.cache/triage/<cluster key>-<model>-p<prompt version>.json`, so a rerun on the same failures costs nothing and a changed prompt asks again; `--refresh` ignores it.
- **Cost, by arithmetic and not by measurement.** The models overview lists the model from $0.10 per million input tokens and $0.50 per million output tokens. A typical run (a few clusters of 1,000 to 2,000 input tokens and about 300 output tokens each) costs a fraction of a cent. The hard caps above bound a run: 60,000 characters of input is about 20,000 tokens, 30 requests of at most 2,000 output tokens is 60,000, so a run cannot cost more than about three and a half cents at that price, and the arithmetic leaves a margin for the new tokenizer's larger counts. It was not measured: nothing was sent. A real run prints the tokens the service reports for its drafts, so the first run with a key measures it.
- **What the mock proves, and what it cannot** (ADR-168). [`tools/triage-mock.ts`](../tools/triage-mock.ts) rejects a request whose headers, version, content type or fields are not the documented ones (including the sampling parameters the current version removed, a prefilled turn and streaming), and answers success, 400, 401, 429 with `retry-after`, 500, a slow answer, a malformed body and a dropped connection, with the documented error shape. The tests assert the exact request, that the key appears in one header and in no log or report, that no request ever contains the text of a secret pattern, retries, the budget, the cache and the degradation. It cannot show what the real service answers to a prompt, whether the model follows the requested shape, the real rate limits, or a change of the API since 2026-11-04.

## What it cannot tell

- A cluster is a claim about a cause, with its evidence. Two causes that read alike in their first line, the same helper and no critical Shaka code are one cluster; a spelling of one cause that nobody has seen is two (above).
- A **negative test**, one that expects the player to fail (the manifest that is down, PB-REC-006), and that fails on a timing bound while a fault fired and the player ended in an error, reads as `network-fault-not-recovered`: the rule cannot know that the error was expected. The evidence says what fired and a person sees the test's name.
- The words of a connection failure in Firefox and WebKit that the table of wordings does not know split a cluster by engine.
- It reads one build. History across builds is the flake tracker's ([FLAKE.md](FLAKE.md)); a cluster that recurs across builds is not recognised as the same one by anything but its key.
- The first check is the rule's, written once. It does not know your change.

## Files and variables

| | |
| --- | --- |
| [`triage/`](../triage) | the modules above, and `cli.ts` (`npm run triage`, `npm run gate:triage`) |
| `tests/unit/triage/` | the tests, builders that make the lab's own failure messages and attachments (`support.ts`) and fake secrets assembled at run time from fragments (`secrets.ts`) |
| `tools/triage-mock.ts` | `npx tsx tools/triage-mock.ts [--port 4751]`: the mock, on 127.0.0.1 |
| `tools/triage-fixture.ts` | `npx tsx tools/triage-fixture.ts --from reports/playwright.json --out tests/fixtures/triage/<name>` |
| `reports/triage/` | `triage-report.md`, `triage-report.json` |
| `.cache/triage/` | cached drafts |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_WORKSPACE_ID` | the summaries; all optional |
| `PB_TRIAGE_FROM` | where `--from-ci` reads when `--from` is not given |
| `GITHUB_STEP_SUMMARY` | where the job summary is appended, when set |

The decisions behind all of this, with the alternatives that were rejected, are ADR-160 to ADR-169 in [decisions/triage.md](decisions/triage.md).
