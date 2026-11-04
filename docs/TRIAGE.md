# Failure triage

A red build leaves a hundred lines in three engines, and one cause shows up as a dozen failed tests. Triage reads the Playwright report of every engine job and the failure attachments of every failed test, **groups the failures that have the same cause into one cluster**, says which **category** of cause the cluster is and what it found that says so, and names the first thing to check. Optionally, a language model drafts a few sentences per cluster. It **explains** a red build and never **decides** one: it is not a gate, it exits 0 in CI whatever it finds, and the verdict of a build is the gates' ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 10).

> **The model summary has never been run against the live service.** There is no API key on the machine that built this and none was created. [`triage/summarize.ts`](../triage/summarize.ts) was verified against a local mock of the Messages API ([`tools/triage-mock.ts`](../tools/triage-mock.ts)) that follows the request and response shapes of the official documentation (read on 2026-11-04, ADR-168). The mock proves that the requests are well formed and that every documented answer and error is handled; it proves nothing about what the model writes. The deterministic clustering needs no key, runs offline and is the contract (ADR-160); the command to run the summaries with a key is [below](#the-summaries-opt-in).

## How the parts fit

| Part | What it does | File |
| --- | --- | --- |
| Collection | Reads every failed or flaky test of every Playwright JSON report under a directory into a typed `Failure`: identity, engine, tier, attempts, the first failing attempt's message and application frames, and digests of the failure attachments. Says what was missing. | [`triage/collect.ts`](../triage/collect.ts), [`digest.ts`](../triage/digest.ts), [`stack.ts`](../triage/stack.ts) |
| Signature | The name of a cause: the same cause has the same name whatever its ids, ports, timestamps, paths and engine. | [`triage/signature.ts`](../triage/signature.ts), on [`src/lab/signature.ts`](../src/lab/signature.ts) |
| Clusters | Failures with the same signature, ordered by size, then by engines, then by signature; then the clusters that are one **root cause** (below) are rolled up. | [`triage/cluster.ts`](../triage/cluster.ts) |
| Categories | An ordered table of named rules; the first that finds something names the category, says what exactly is broken when it names a cause, and prints its evidence. | [`triage/rules.ts`](../triage/rules.ts) |
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

Exit codes: **0 whatever it finds and whatever it cannot read** (failures, none, nothing to read, a report that does not parse, a crash of its own: each is printed, and none changes the exit code), and **2 only for a bad command line** (an unknown option, a missing value, `--max-clusters 0`), in CI too. Triage is not a gate. With nothing failed it prints `no failures to triage`.

## What it reads

Playwright's JSON report (`reports/playwright.json`; the Jenkinsfile writes `reports/<engine>/playwright.json` per engine job, and a downloaded artifact directory is read at any depth) and, for each failed test, the attachments of the diagnostics fixture ([CONTRACTS.md](CONTRACTS.md) section 7.2, ADR-073): `qa-events.json`, `qa-metrics.json`, `qa-info.json`, `page-console.json`, `session-detail.json`, `request-log.json` (a second player or session has `-2`), and `diagnostics-problems.json`. The JSON reporter keeps those attachments in the report itself (base64), so the report alone is enough; an attachment kept as a file is looked for next to the report and in `test-results*`.

- A test is read when its final status is failed or timed out, or when it is flaky (it failed and passed on a retry: the failure of the first attempt is still a failure with a cause). Skipped tests are listed apart with their reason, and a skip **without** a reason is printed as a bug. Interrupted tests (the run was stopped) are counted and not clustered. A test with **no attempt at all** (the report is of a listing, `playwright test --list`, or the run was stopped before it started) is counted as **not run**: neither a failure nor a skip, so it is never flagged as a skip with no reason. A global setup that threw, or a web server that did not start, is an error of the run: it becomes a failure with no test to blame.
- **Missing attachments are said, not guessed.** A launch failure has none; a test that failed before the fixture could read anything has none. Each failure carries what was missing, and the rules that need an attachment simply do not fire without it.
- **The request log is read as [CONTRACTS.md](CONTRACTS.md) section 4 says** (ADR-083, ADR-164): an origin failure is a finished request with a status of 400 or more, or one the origin cut (`fault-abort`, `error`). A client that hung up (`client-closed`: the player cancelling a request when it seeks or switches rung) is **not** an origin failure, and nothing here counts it as one.
- Only Playwright reports are read. A failure of the unit tests (Vitest) is not: a build that is red in the unit stage has nothing for triage to cluster, and says "no failures to triage".

## The signature

A failure's signature is `message [assertion] @ location {shaka code}`, and nothing else (ADR-161):

| Part | What it is | Why |
| --- | --- | --- |
| message | The first line of the error message, with the lab's one normalisation ([`src/lab/signature.ts`](../src/lab/signature.ts), the function the flake tracker uses: numbers, ids, timestamps, urls, ports, paths and hashes become placeholders), then the steps only triage needs: the three engines' words for a refused or reset connection are one phrase; the name of an engine (`chromium`, `firefox`, `webkit`, `chromium-cpu4x`) is `<engine>` and the id of the environment (`local-darwin-arm64`) is `<env>`; a rung id (`v360`) is `<rung>`; a rule id (`f1`) is `<rule>`; the JSON of a fault rule that a fault message quotes is `{…}`; a list of identical items is its first item and `…`. | The first line is what a person reads first, and what the lab's own assertion helpers write their cause in. The engine is not part of a cause, and the quoted rule would push the words that matter past the cut. |
| assertion | The matcher that failed (`toBeLessThanOrEqual`, `not.toBe`), `test-timeout`, or `thrown`. | Two checks with the same words are not the same cause. |
| location | `file:function` of the first **application** frame that is not a spec (no line number: a line moves with every edit, and the signature names a cause, not a revision). When the message has no words of its own (`expect(received).toBe(expected)`, `Test timeout of 45000ms exceeded.`) the spec file is added, because otherwise unrelated failures would be one cluster. | A helper that threw is the check that failed; a spec's body only names the test. Ten specs failing in the same helper are one cause. |
| shaka | The first **critical** Shaka error the player reported, if any: its code, or `media` for any error of the media category (a recoverable error does not split a cluster). | The same symptom after a `1001` and after a `4001` is two causes; but the engines word the same corrupt bytes with different media codes (a real run: 3015 in WebKit, 3016 in Chromium), and one cause must not split by engine. |

The signature is hashed to a 12-character cluster key, which names the cluster and its cached summary. **What it over-merges and over-splits** is a limit, and ADR-162 states it: two causes with the same first line, the same helper and no critical Shaka code are one cluster (the report says when the rules disagree inside it: `the rule fired for 1 of 2 failures; the others fired …`); one cause worded differently by an engine that the wording table does not know is two clusters with one engine each, and a person merges them by reading. The table covers a refused and a reset connection in the words of the three engines' own error names (`net::ERR_CONNECTION_REFUSED`, `NS_ERROR_CONNECTION_REFUSED`, `Could not connect to the server`), and none of the three has yet been compared with a failure of this lab in that engine; a wording nobody has seen is not guessed.

Determinism is tested (`tests/unit/triage/cluster.test.ts`): shuffled input, different ids, timestamps, ports and paths give the same clusters in the same order; two different causes never merge; the same cause in two engines is one cluster listing both.

## Categories: the table of rules

Each cluster is given to the rules in order, and **the first rule that finds something wins**: its name, its category and its **evidence** (lines a person can check against the attachments) are in the report, so the verdict can be disagreed with. The order is part of the contract: **a rule that names a cause comes before one that describes a symptom**. A wait for the first frame that ran out is a symptom of a fault the player did not recover from, so the fault rule is first; a player error that no fault, origin failure or media error explains is a cause of its own, so it comes before the waits.

| # | Rule | Category | Class ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 10) | It fires when |
| --- | --- | --- | --- | --- |
| 1 | `documented-gap-confirmation-failed` | `known-gap` | Known gap | a spec that confirms a documented gap before it skips timed out waiting for the error it expects |
| 2 | `documented-gap-in-message` | `known-gap` | Known gap | the message quotes the reason of a documented gap |
| 3 | `environment-check-failed` | `environment` | Environment or infrastructure | PB-ENV-001 says in its own words that the environment changed, unless what it quotes from the player is a page that did not boot (then the page is the cause: rule 12) |
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
| 18 | `test-premise-not-met` | `instrument-disagreement` | Needs a person | the test's own message says a premise it needs did not hold (`premise of the test, not the behaviour under test`) |
| 19 | `oracles-disagree` | `instrument-disagreement` | Functional regression | a lab assertion says two readings of one fact (the hook and the log) disagree |
| 20 | `player-critical-error` | `player-error` | Functional regression | the player reported a critical error that nothing above explains |
| 21 | `hook-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | `qa.waitFor('<event>')` ran out (the event is named) |
| 22 | `media-clock-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | `qa.waitForMediaTime(<s>)` ran out (the clock's position is named) |
| 23 | `request-log-wait-timed-out` | `timeout-waiting-for-event` | Functional regression | a wait on the origin's request log ran out |
| 24 | `page-call-timed-out` | `timeout-waiting-for-event` | Functional regression | a Playwright call on the page ran out of time |
| 25 | `test-timed-out` | `timeout-waiting-for-event` | Functional regression | the whole test ran past its limit with no wait of its own failing first |
| 26 | `metric-assertion-failed` | `metric-regression` | Performance regression | the failing assertion is on a measured quantity (rebuffers, dropped frames, live latency, startup, bitrate switches) |
| — | `no-rule-matched` | `unknown` | Needs a person | nothing above found anything |

Two things go beyond the classes of the strategy. The category **`player-error`** exists because a player that failed with a critical error that no fault, origin failure or media error explains is neither a timeout nor a decode problem, and filing it under either would hide it. The class **Needs a person** is `unknown`'s: the section 10 classes have no place for "no rule recognised this", and inventing a class for it would be a guess. A cluster whose failures were **all flaky** is given the class **Flake** and the advice not to rerun the job (section 10), unless its rule says environment or known gap, which are more specific.

### Root causes: clusters that are one cause

A cluster is one signature, which is the words of one failure. One cause is worded differently by every test it breaks: an origin that answers 503 to every segment is a first frame that never came in a start spec, and a fault the player never saw in a recovery spec (a real run: three signatures for one cause, see [results/triage](results/triage/README.md)). So every rule that **names a cause** (not a symptom) also says what exactly is broken in a phrase (`the origin answered 503 on segment to requests no fault rule named`, `a fault of type status fired and the player did not recover`, `the player page did not boot: a Content Security Policy blocked its scripts`), computed from the evidence and not from the words of the test. **Clusters that fired the same rule for the same cause are one root cause**, and the report says so: `5 clusters of 3 root causes` in the headline, a table of the root causes that several clusters share, and on each of those clusters which others it shares one with. A rule that only describes a symptom (a wait that ran out, a premise, a metric, an oracle disagreement) has no cause, and its cluster is its own root cause: a slow origin, which fails no request, is therefore two root causes (a premise that did not hold and a rebuffer count), because nothing in the evidence ties them. `triage-report.json` has every root cause (`rootCauses`) and the key of the one each cluster belongs to (`clusters[].rootCause`).

**The rules read the words of the lab's own helpers**, so a helper that is reworded would quietly move its failures to `unknown`. The tests of the rules therefore generate their messages by calling the helpers themselves (`qa.waitFor`'s and `qa.waitForMediaTime`'s timeouts, the request wait, the rebuffer assertion, the environment check, the service readiness), and rewording one breaks a test here instead.

### Adding a rule

1. Add the rule to `RULES` in [`triage/rules.ts`](../triage/rules.ts), **in the place of its strength** in the order: a rule that names a cause above one that describes a symptom. It has a `name` (unique, printed next to the evidence), a `category`, a `failureClass`, a one-line `rationale` (why this evidence means this cause), a `firstCheck` written as an instruction, and a `check` that returns the evidence lines or `null`.
2. Test it in [`tests/unit/triage/rules.test.ts`](../tests/unit/triage/rules.test.ts): a failure that fires it (the message from the helper that writes it, not retyped), a near miss that does not, and the rule above and below it in the order.
3. Add a row to the table above (`tests/unit/triage/docs.test.ts` fails when a rule is missing from this page) and, if it is a new category, to `CATEGORIES` in [`triage/types.ts`](../triage/types.ts) and to `CATEGORY_MEANING`.

## Reading the report

Per cluster, in this order: rank, size, engines, tests, category and the rule that fired, the signature and its key, the **evidence** of the rule, the class and the first thing to check, the representative failure (the one with the richest diagnostics, so the same cluster always reads the same), its error message, every member, and what was missing. A summary of the whole run: failed, flaky, skipped, interrupted and not-run counts, the number of clusters and, when several clusters are one cause, of **root causes** (`12 clusters of 8 root causes`), the reports read, and **what could not be read** (a file that is not a report is named, never skipped silently).

`triage-report.json` has the same content with `schemaVersion: 1`. `$GITHUB_STEP_SUMMARY` gets a table of the first twelve clusters and a count of the rest.

## The real failures it was run on

Seven different causes were induced on purpose in a scratch copy of the lab and run through the **real merge-tier specs** (Chromium and WebKit; Firefox is a documented gap on the host that ran them). Nothing here is a hand-written message: the fixtures in [`tests/fixtures/triage/`](../tests/fixtures/triage) are the reports of those runs, reduced and redacted, and [`results/triage/`](results/triage/README.md) has the whole experiment (what was run, the patches, `uptime` before and after every run, the report).

| # | Cause induced | Failed | Clusters | Category · rule | Root causes |
| --- | --- | --- | --- | --- | --- |
| 1 | the service is down | 1 (the run) | 1 | `environment` · `service-not-reachable` | 1 |
| 2 | a stream file in the cache is truncated | 1 (the run) | 1 | `environment` · `run-failed-before-any-test` | 1 |
| 3 | the page is served with `script-src 'none'` | 7 | 2 | `page-boot-failure` · `page-did-not-boot` | 1 |
| 4 | the origin answers 503 to every segment | 10 | 3 | `origin-error` · `origin-failed-without-fault` | 1 |
| 5 | segments with corrupted bytes of the right size | 6 | 1 | `decode-or-mse-error` · `media-error` | 1 |
| 6 | the player's retry and failover policy is off | 4 | 2 | `network-fault-not-recovered` · `fault-fired-player-failed` | 1 |
| 7 | the origin is 2.5 s slower for every segment | 2 | 2 | `instrument-disagreement` · `test-premise-not-met`; `metric-regression` · `metric-assertion-failed` | 2 |

Read together as one directory of artifacts (what a CI stage does), **31 failed tests became 12 clusters of 8 root causes**, and no cause was merged with another. The runs were not kind to the first version of the rules, and each correction has a test and none was made by editing a fixture: the environment check blamed the environment for a page that did not boot; the same cause was two clusters when the message named the engine, and when two engines gave the same corrupt bytes two Shaka codes (3015, 3016); two causes read together were one cluster because a quoted fault rule pushed the telling words past the cut of the signature; one cause was three clusters because every spec words it differently (hence root causes); a failed premise was `unknown`. The one that stays two root causes is a slow origin, and the limit is in [What it cannot tell](#what-it-cannot-tell). The experiments' own table is in [results/triage](results/triage/README.md).

## In CI: `gate:triage`

**The command** is `npm run gate:triage`, which is `npm run triage -- --from-ci`. It is a stage for a red build: it never decides one. Put it after the engine jobs, run it on failure (it also works on a green build and prints `no failures to triage`), and do not wrap it in anything that ignores errors: it does not fail.

```yaml
# GitHub Actions: the last step of an engine job, or the only step of a job that needs the engine jobs
- name: Triage the failures
  if: failure()
  run: npm run gate:triage            # reads ./artifacts (the downloaded artifacts of the engine jobs), else ./reports
- uses: actions/upload-artifact@v7
  if: failure()
  with:
    name: triage
    path: reports/triage/
```

```groovy
// Jenkins: in the `post { always { ... } }` of an engine branch (reports/<engine>/...), or in a last stage that has gathered the branches' reports
sh 'npm run gate:triage -- --from reports --out reports/triage'
```

**What it reads.** Only Playwright's JSON reports and, beside them, the flake run files: `playwright*.json` at any depth under the directory it is given (a report per engine job is the normal case) and `flake/run*.json` for the id of the environment. The failure attachments of the diagnostics fixture are inside the JSON report (base64), so nothing else is needed. It does **not** read traces, screenshots, videos, the HTML report, the job log or the service's own output (see the limits below: a service that refuses to start says why in its output, not in a report).

| Path | On a GitHub Actions runner | Under Jenkins | Read |
| --- | --- | --- | --- |
| `reports/playwright.json` | written by the config of the repository | not used: each engine branch writes `reports/<engine>/playwright.json` (`PLAYWRIGHT_JSON_OUTPUT_FILE`), in its own agent's workspace | yes |
| `reports/quarantined/playwright.json` | written by `gate:merge` for the quarantined tests | the same, per branch | yes (its failures are flagged as quarantined by the path) |
| `reports/flake/run.json`, `reports/flake/run-quarantined.json` | written by the flake reporter | the same, per branch | yes, for the environment id |
| `reports/html/`, `reports/<engine>/html/` | the HTML report | the same | no |
| `test-results/**` (traces, screenshots, `error-context.md`) | Playwright's output directory | archived with the reports (`archiveArtifacts`) | no |
| `artifacts/<job>/...` | where `actions/download-artifact` puts the artifacts of the engine jobs, when a job gathers them | where a last stage puts the branches' archived reports (`unstash`, `copyArtifacts`) | yes: this is the default input of `--from-ci` |

The Jenkins branches run on separate agents, each with its own workspace, so the clusters across engines need the reports of the branches in one directory before the last stage runs triage: without it, run it in each branch and read one engine at a time. On GitHub Actions the same applies to jobs: a step at the end of an engine job sees only its own report, a job that downloads the artifacts of all of them sees every engine (and then the same cause in three engines is one cluster).

**What it writes.** `reports/triage/triage-report.md` and `reports/triage/triage-report.json` (`--out` changes the directory): upload `reports/triage/` as an artifact, or let it go with the `reports/**` that is archived already. On GitHub Actions it also **appends a summary to `$GITHUB_STEP_SUMMARY`** (the variable is set by the runner and needs nothing passed): a table of the first twelve clusters, the headline, and a pointer to the files. It prints the clusters on stdout, and on the first line says that it is not a gate.

**Its exit code** is **0 whatever it finds and whatever it cannot read**: failures, no failures, a directory with nothing in it, a report that does not parse, a crash of its own (`triage could not run: ...` on stderr) are printed and none changes the exit code, so it can never be the reason a build is red. It is **2 only for a bad command line** (an unknown option, a missing value). The unit tests pin both: a build with no report, a build whose report is not JSON and a crash all exit 0 (`tests/unit/triage/cli.test.ts`).

## The summaries (opt-in)

```sh
ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-haiku-5-5 npm run triage -- --from reports --summarize
```

`ANTHROPIC_MODEL` is optional (`claude-haiku-5-5` is the default: the models overview describes it as the one for high-volume, latency-sensitive classification, extraction and routing); `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) points the requests elsewhere, and a report whose drafts came from any other endpoint says in capitals that they are **not the live service**. `ANTHROPIC_WORKSPACE_ID` is for a key that is **not scoped to one workspace**: the authentication page of the documentation says such a key needs the `anthropic-workspace-id` header on every request, and that a key scoped to one workspace must omit it, so the header is sent only when this is set. **The key is sent in the `x-api-key` header, with the `anthropic-version` header the documentation recommends (`2026-10-21`).** The documentation calls `x-api-key` a legacy fallback of `Authorization: Bearer`, still supported, and this repository keeps it: a change to bearer authentication would be untestable here, because no key exists on the machine that built this and the summarizer is verified against the local mock only.

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
- **Cache**: `.cache/triage/<cluster key>-<model>-<endpoint hash>-p<prompt version>.json`, so a rerun on the same failures costs nothing, a changed prompt asks again, and a draft is only ever found by the endpoint that wrote it (a draft of the local mock is never served to a run that asks the real service; a cached draft of a non-live endpoint is labelled as such in the report); `--refresh` ignores it.
- **Cost, by arithmetic and not by measurement.** The models overview lists the model from $0.10 per million input tokens and $0.50 per million output tokens. A typical run (a few clusters of 1,000 to 2,000 input tokens and about 300 output tokens each) costs a fraction of a cent. The hard caps above bound a run: 60,000 characters of input is about 20,000 tokens, 30 requests of at most 2,000 output tokens is 60,000, so a run cannot cost more than about three and a half cents at that price, and the arithmetic leaves a margin for the new tokenizer's larger counts. It was not measured: nothing was sent. A real run prints the tokens the service reports for its drafts, so the first run with a key measures it.
- **What the mock proves, and what it cannot** (ADR-168). [`tools/triage-mock.ts`](../tools/triage-mock.ts) rejects a request whose headers, version, content type or fields are not the documented ones (including the sampling parameters the current version removed, a prefilled turn and streaming), and answers success, 400, 401, 429 with `retry-after`, 500, a slow answer, a malformed body and a dropped connection, with the documented error shape. The tests assert the exact request, that the key appears in one header and in no log or report, that no request ever contains the text of a secret pattern, retries, the budget, the cache and the degradation. It cannot show what the real service answers to a prompt, whether the model follows the requested shape, the real rate limits, or a change of the API since 2026-11-04.
- **The demo is of the mock.** [`results/triage/`](results/triage/README.md#the-model-summary-mock-only) has the console and the report of a `--summarize` run against the mock on 127.0.0.1 (12 drafts, each labelled `NOT the live service` and `[MOCK] no model wrote this`), and the output of the same command with no key (the clusters only, `summaries skipped: ANTHROPIC_API_KEY is not set`, exit 0). Neither says anything about the quality of a model's summary.

## What it cannot tell

- A cluster is a claim about a cause, with its evidence. Two causes that read alike in their first line, the same helper and no critical Shaka code are one cluster; a spelling of one cause that nobody has seen is two (above).
- A **negative test**, one that expects the player to fail (the manifest that is down, PB-REC-006), and that fails on a timing bound while a fault fired and the player ended in an error, reads as `network-fault-not-recovered`: the rule cannot know that the error was expected. The evidence says what fired and a person sees the test's name.
- The words of a connection failure in Firefox and WebKit that the table of wordings does not know split a cluster by engine.
- **A slow origin is not a cause to triage**: it fails no request, and no rule reads the timings of the request log (a threshold would be tuned on timing, which varies with the machine). In a real run of an origin that held every segment back 2.5 s, the two failing tests became two root causes, a premise that did not hold (`test-premise-not-met`) and a rebuffer count (`metric-regression`), and the evidence of neither names the origin.
- **A service that refuses to start** (a truncated or missing stream file, a port in use) shows as `run-failed-before-any-test`: Playwright's error says that the web server did not start, and why is in the output of the service, which is in the job log and not in any report.
- **The class of a premise failure is `Needs a person`**: a test that says its own condition did not hold has told nothing about the behaviour it is about, and whether the host, the origin or the player is at fault is not in the failure.
- It reads one build. History across builds is the flake tracker's ([FLAKE.md](FLAKE.md)); a cluster that recurs across builds is not recognised as the same one by anything but its key.
- The first check is the rule's, written once. It does not know your change.

## Files and variables

| | |
| --- | --- |
| [`triage/`](../triage) | the modules above, and `cli.ts` (`npm run triage`, `npm run gate:triage`) |
| `tests/unit/triage/` | the tests, builders that make the lab's own failure messages and attachments (`support.ts`) and fake secrets assembled at run time from fragments (`secrets.ts`) |
| `tools/triage-mock.ts` | `npx tsx tools/triage-mock.ts [--port 4751]`: the mock, on 127.0.0.1 |
| `tools/triage-fixture.ts` | `npx tsx tools/triage-fixture.ts --from reports/playwright.json --out tests/fixtures/triage/<name>` |
| `tests/fixtures/triage/` | seven real failed runs of the lab, reduced and redacted (below), read by `real-failures.test.ts` |
| [`results/triage/`](results/triage/README.md) | the experiments, the report made from the fixtures (`triage-report.md`, `triage-report.json`), the patches that induced four of the causes, the mock demo of the summaries (labelled as a mock) and the output with no key |
| `reports/triage/` | `triage-report.md`, `triage-report.json` |
| `.cache/triage/` | cached drafts |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_WORKSPACE_ID` | the summaries; all optional |
| `PB_TRIAGE_FROM` | where `--from-ci` reads when `--from` is not given |
| `GITHUB_STEP_SUMMARY` | where the job summary is appended, when set |

The decisions behind all of this, with the alternatives that were rejected, are ADR-160 to ADR-169 in [decisions/triage.md](decisions/triage.md).
