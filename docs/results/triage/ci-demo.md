# Failure triage on a red build in GitHub Actions

The seven induced failures of [README.md](README.md) were run on the development machine. This is the same tool in the pipeline it is built for: a pull request that breaks the player page, the five browser legs going red, and the `triage` job of `ci.yml` explaining the red.

## The pull request

Draft pull request #17, "DEMO (do not merge): a policy that blocks scripts", closed without merging. Head commit `8f0a99c`, one change in `src/player/index.html`: the content security policy of the player page says `script-src 'none'` where it said `'self'`, so the page loads and its scripts never run. CI run [41887574166](https://github.com/hanniavalera/playback-proof/actions/runs/41887574166).

| Check | Result |
| --- | --- |
| `static` | pass |
| `unit` | fail |
| `merge-gate`, all five legs (chromium, firefox, chromium-cpu4x, webkit on Linux, webkit on macOS) | fail |
| `perf (chromium)`, `perf (chromium-cpu4x)` | fail (the page does not boot: nothing can be measured) |
| `flake` | pass (the failures are failures, not flakes: the flake gate judges what failed and then passed) |
| **`triage`** | **ran** (`if: failure()`; it is skipped on a green run) and uploaded the artifact `triage` and a summary on the run page. Not a required check, and it exits 0 whatever it finds. |

## What the triage said

The report is [`triage-report.md`](ci-demo/triage-report.md) ([`.json`](ci-demo/triage-report.json)): the report of the `triage` job, made by `npm run gate:triage -- --from artifacts --out reports/triage` over the Playwright reports of the five legs, downloaded as artifacts. The job's own artifact holds the same clusters with the local address and query of the failing page in the messages; the file here was **re-rendered from the same artifacts with `--redact`** (the tool's option for a report that is published), which is the only difference, and which the repository's scan of committed files requires:

> **63 failed in 5 reports became 3 clusters of 1 root cause.**

| # | Failures | Engines | Tests | Category and rule |
| --- | --- | --- | --- | --- |
| 1 | 59 | chromium, chromium-cpu4x, firefox, webkit | PB-ABR-002, PB-LIVE-001 to -004, PB-REC-001, -002, -008, PB-VOD-001, -002, -006, -007 and 2 more | `page-boot-failure` · `page-did-not-boot` |
| 2 | 3 | chromium, firefox, webkit (Linux) | PB-ENV-001 | `page-boot-failure` · `page-did-not-boot` |
| 3 | 1 | webkit (macOS) | PB-ENV-001 | `page-boot-failure` · `page-did-not-boot` |

The three clusters are two wordings of one failure: the tests that open the player time out waiting for the page, and the environment test says it could not play (its message names the machine, `gha-linux-x64` or `gha-macos-arm64`, which is why it forms one cluster per environment). The report rolls them up: **"the player page did not boot: a Content Security Policy blocked its scripts"**, with the evidence the rule found, quoted from the browser console that the failure attachments carry (`Loading the script '.../player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'"`, and the same for `player.js`) and the first thing to check (`curl -I <origin>/player/`, then `npm run build:player`). The model summary was not used: it is optional, and no API key exists in this environment ([../../TRIAGE.md](../../TRIAGE.md)).

## An honest counter-example from the same week

The triage of the regression pull request (#16, [`../perf/paired-sensitivity.md`](../perf/paired-sensitivity.md)) ran because its Firefox leg failed in the setup step, and it found one thing in the other legs: a test that **failed on its first attempt and passed on the retry** (PB-ABR-002 on WebKit on macOS: "rebuffers: expected at most 1, saw 2 totalling 889 ms"). No rule of the table matches a rebuffer-count assertion, and the report says so instead of guessing: category `unknown`, rule `no-rule-matched`, "a person has to read the failure", class Flake, with the advice not to rerun it and to read the trace of the first failed attempt: [`unmatched-flake-pr16-triage-report.md`](ci-demo/unmatched-flake-pr16-triage-report.md). That is a limit of the rule table, not of the clustering (the failure was grouped correctly, as one cluster of one).

## What it shows, and what it does not

- **It shows** the tool working on real CI output: 63 failures across four engines became one root cause with the evidence, without a model and without a key.
- **It does not show** the model summaries (never run against the real service), nor how the rules do on subtle failures (a regression whose message does not carry its cause); the seven induced failures and their unmatched case are in [README.md](README.md).
