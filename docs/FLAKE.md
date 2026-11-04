# Flake tracking

A flaky test is one that fails and then passes on a retry with nobody having changed anything. It is the most expensive kind of test: it costs the time of a failing test and teaches the team to ignore red. This lab **records** every retried pass, **counts** it against the test and against the suite, **fails the merge** when the count passes the policy's limits, and **bounds** the damage with a quarantine that has an owner and an expiry. The policy (as set in `criteria.ts` when this was written: a window of 30, 20 runs before a verdict, 5 % per test, 2 % per engine job, an invalid-run budget of 40 %, quarantine for at most 14 days, 7 for a merge-tier test) is decided in [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 7.2 and lives in [`src/shared/criteria.ts`](../src/shared/criteria.ts); this page is the mechanism, and [the decisions](decisions/flake.md) (ADR-130 to ADR-139, and ADR-135a) are the arguments for it.

**The definition** is in [METRICS.md](METRICS.md): flake rate = runs in which the test failed and then passed on a retry / runs in which it executed. A test that fails every attempt is a **failure**, not a flake: it already failed the browser job, and the flake gate does not judge it.

> **What has been measured.** The mechanism was built and tested on fixtures, then run for real on GitHub's runners: 30 repetitions of the `@merge` tier in each Linux engine gave **no flaky outcome in 450 executions per engine**, and on the macOS runner (WebKit) one test, PB-ABR-002, failed its first attempt in 7 of 60 repetitions; the cause was traced to Shaka's dropped-frame protection and the attempts it ruins are now counted as invalid runs (ADR-106). Every number, with its machine, commit and command, is in [results/flake](results/flake/README.md). The numbers in the examples below are fixture data built by the test helpers, and are labelled so; none of them is a measurement of the lab.

## How the parts fit

| Part | What it does | Command or file |
| --- | --- | --- |
| Reporter | Records every attempt of every test of a Playwright invocation: outcome, engine, tier, retries, error signature, quarantine flag. | [`flake/reporter.ts`](../flake/reporter.ts), listed in `playwright.config.ts`; writes `reports/flake/run.json` |
| Quarantine-aware merge run | The `@merge` tests except the quarantined ones, and then the quarantined ones apart, non-blocking. | `tsx tools/gate-merge.ts --project=chromium` (what the `gate:merge` script runs once `package.json` points at it, ADR-138) |
| Gate | Judges this build's runs against the history and the quarantine list; exit 1 with the decision each failure drives. | `npm run flake:gate` ([`flake/gate.ts`](../flake/gate.ts)) |
| History | The runs of an environment, JSON lines, the last 200. A file locally, the orphan branch `ci-data` in CI. | `flake/history/<env>.jsonl`; `ci-data:history/<env>.jsonl` |
| Report | Per test and per engine job: runs, flaky, failed, rate, verdict, last failure; the invalid runs against their budget; the quarantine; the skips. | `npm run flake:report` (stdout, `$GITHUB_STEP_SUMMARY`, `reports/flake/report.md` and `.json`) |
| Collector | Repeats an invocation N times and records each repetition: how the real data of the suite is gathered. | `tsx tools/flake-collect.ts --project chromium --runs 30 --grep @merge` |
| Quarantine list | Who is quarantined, why, until when. | [`flake/quarantine.json`](../flake/quarantine.json) (starts empty) |

The error signature that the reporter gives each failed attempt (the first line of the message with its numbers, ids, timestamps, urls and paths normalised, so that the same cause reads the same) is [`src/lab/signature.ts`](../src/lab/signature.ts): failure triage reuses it.

## What the gate fails on

`npm run flake:gate` reads the runs just recorded (every `run*.json` under `reports/flake`, at any depth, so that a job that downloaded the files of several engine jobs works), adds them in memory to the history of their environment, and judges what this build ran.

| Exit 1 when | What to do (the gate prints it, with the numbers) |
| --- | --- |
| A test is above the quarantine trigger over its window and is not quarantined. | Fix it or quarantine it **today**, with an owner, a reason, the evidence and an expiry: 14 days at most, **7 for a merge-tier test**. Do not rerun the job; read the trace of the first failed attempt, not the green retry. |
| An engine job's suite flake rate is above its budget. | Look at the environment first (flakiness spread over tests points there), then fix or quarantine the tests that contribute most: a quarantined test leaves the suite rate. |
| A test was an invalid run in more than the budget's share of its last scheduled executions on an engine (`over-invalid-budget`). | Fix the machine, or declare the leg a documented gap with evidence, or retire the test on this leg: do not widen the budget. **A quarantine does not clear it.** See [Invalid runs](#invalid-runs). |
| A quarantine entry has expired. | Fix the test and remove the entry, or retire the test (remove its catalog row in a pull request that says why). |
| The quarantine of a **merge-tier** test has expired. | The hole in the merge gate outlived its week: fix the test or replace it with a deterministic one of the same risk, and remove the entry. No renewal. |
| `flake/quarantine.json` is not valid or is missing. | Fix it. An entry with a problem quarantines nothing. |

**Exit 2** means the gate could not judge (no run file, a history it cannot read, run files of several environments, a catalog it cannot parse, a bad argument): an environment problem, not a flaky test. It is **not a verdict on the pull request's own failures**: those already failed the browser job.

A test is judged once it has the minimum number of executions in its window, and an engine job once its window holds that many builds; before that the table shows the rate and says there is no verdict. The invalid-run share has the same minimum, counted in scheduled executions.

## Quarantine a test: a worked example

The gate is red. This is its output on a fixture history of 30 builds of an engine job in which PB-VOD-007 flakes twice (fixture data from the test helpers, run with `npx tsx flake/gate.ts`; not a measurement of the lab), trimmed:

```text
flake gate: FAIL (1 failure)  [cli-check-env, 2026-11-03, 1 run in this build, 30 runs judged]
...
| PB-VOD-007 | webkit | 30 | 2 | 0 | 6.7% | over-trigger | no |

1. [over-trigger] PB-VOD-007 on webkit is above the quarantine trigger: 2 flaky of 30 executions (6.7%), the trigger is 5.0%, ...
   Decision: Fix PB-VOD-007 on webkit today, or quarantine it today. Who: the owner of the VOD playback (VOD) area ...
   an expiry no later than 2026-11-10 (a merge-tier test: at most 7 days). The gate stays red until one of the two has happened.
```

If the test cannot be fixed today, add an entry to [`flake/quarantine.json`](../flake/quarantine.json) in the pull request that is blocked:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "PB-VOD-007",
      "project": "webkit",
      "reason": "failed and passed on the same commit in runs 18 and 19; the first attempt times out waiting for the seeked event",
      "owner": "@hanniavalera",
      "since": "2026-11-03",
      "expires": "2026-11-10",
      "evidence": "https://github.com/hanniavalera/playback-proof/issues/7"
    }
  ]
}
```

- `id` is a row of the catalog. `project` is optional: without it every engine the test runs in is quarantined. `since` is today (UTC) and may not be in the future. `expires` is within 7 days of `since` for a merge-tier test, 14 for a release-tier one, and the entry is in force through the end of that day. **A key the tool does not know is an error** (a misspelt `project` would otherwise quarantine every engine).
- The quarantined test **still runs**, in the second, non-blocking invocation of `gate:merge`; its results are recorded as quarantined. It leaves the suite rate, which turns a gate that was red on the suite budget green, and it stays in its own window.
- The gate notes when the test has had a full clean window (30 executions with nothing flaky or failed): that is when its owner removes the entry and the test returns to the gate. Nothing deletes a test: retiring one is removing its row from the catalog, with a reason, and its id is never reused.
- On the expiry day plus one the gate fails. There is no renewal for a merge-tier test; the tool cannot tell a renewal from a new quarantine, so the age limit and the review of the pull request hold that line.

## Where the history lives, and why a branch

In CI the history is the orphan branch **`ci-data`**, which holds `history/<envId>.jsonl` and no code. `flake:gate --store git --record --push` on a build of `main` fetches the branch, adds the runs, and pushes a commit made as the CI identity it is given (`--git-identity "Name <email>"`); if another job pushed first, the push is refused, so it fetches again, applies the same append on the new tip and pushes again, and it never forces. A pull request runs `flake:gate --store git` (it reads the history and judges, and writes nothing). Locally, and for the collector, the history is `flake/history/<envId>.jsonl`, git-ignored, and a Jenkins agent can point `PB_FLAKE_HISTORY_DIR` at a volume.

| Where | Why not |
| --- | --- |
| A workflow artifact | Immutable and per run; reading the earlier runs means listing and downloading them one by one with a token, and nothing can be appended. |
| The Actions cache | Immutable per key and evicted when unused: a history that can disappear is not a history. |
| A database or an object store | Infrastructure to run, credentials to keep, an outage in the gate, and a reviewer who clones the repository cannot read the data. |
| A file committed to `main` | A commit per build in the code history, a protected `main` refuses the push, and it races with merges. |
| **An orphan branch** | Plain text (`git show origin/ci-data:history/gha-linux-x64.jsonl`), survives the job, takes concurrent writers, needs nothing new. Its price: a commit per recorded build. |

Both CI systems call the same script ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 6.1, stage `gate:flake`; the jobs are in [CI.md](CI.md) and the decisions in ADR-170 to ADR-174, [decisions/ci-flake.md](decisions/ci-flake.md)). The jobs that run the browser tests upload `reports/` (the run files are in it); on GitHub the `flake` job downloads each artifact into `reports/flake/<artifact>/` and runs the gate once per environment, and judges every build, and a separate job, `flake-record`, records the builds of `main` (the one job with `contents: write`: a pull request's run has a read token, and a fork's could not have more). The nightly records its runs too. Jenkins stashes the run files of its engines, and its `Flake` stage judges them and records the builds of `main` in a file on a volume.

## What is excluded from the rates

- **Executions without a retry.** With `retries: 0` (the local default of this repository) a flaky test shows as a failure, so those executions cannot show a flake: they are in no rate, they are counted apart and the report says how many. The collector always passes `--retries 1`.
- **Skipped tests**, and tests a stopped run never finished. A skip carries its reason (the documented gap that caused it, or, for an invalid run, the numbers that say why the attempt could not evaluate its claim: docs/CONTRACTS.md section 7.3); the report lists them with the number of runs in which each was skipped, the collector prints them, and the report flags a skip without a reason. The share of invalid runs is not left to a reader: it is budgeted ([Invalid runs](#invalid-runs)).
- **Quarantined executions, in the suite rate** (they are reported next to it). In a test's own window they stay, so that "one full clean window" means something.
- **Other environments.** A history is per environment (`detectEnvId()`); numbers are never compared across them.
- **Pull requests that are not recorded.** The gate judges a pull request's run on top of the history, but, as the commands are meant to be called, only a build of `main` records (`--record --push`).

## Invalid runs

**What it is.** A spec can end an attempt as an *invalid run*: the attempt shows, from its own measurement, that it cannot evaluate its claim, and it skips itself with `testInfo.skip(true, reason)`. The reason starts with `invalid run:`, a constant (`INVALID_RUN_PREFIX` in [`src/shared/criteria.ts`](../src/shared/criteria.ts)) that the spec that writes the reason and the tracker that reads it both import, so they cannot drift; the numbers that say why follow. The cases today are PB-ABR-002 and PB-ABR-006, and PB-ABR-001: on a loaded machine Shaka's dropped-frame protection forces the player off the rung the link carries (a climb above it) or off the top rung of a link that carries it (a downshift), and the attempt cannot tell that from a player that flaps ([ADR-106](decisions/e2e-abr.md), and its amendment 3: on the GitHub macOS runner most attempts of PB-ABR-001 end that way). An invalid run is not a pass, not a failure, not a flake and **not a documented gap**: a gap says, with the evidence in [`src/lab/gaps.ts`](../src/lab/gaps.ts), that an engine and OS pair cannot play something, and its reason starts with `documented gap in`.

**Why it is budgeted.** On the GitHub macOS runner (3 vCPU, WebKit), PB-ABR-002 could not evaluate its claim in 12.5 % to 25 % of its attempts in four collections of 40 repetitions (5, 6, 8 and 10 of 40), and no change of the test removed the cause: the share varies with the machine. A test that is skipped as invalid in most of its runs protects nothing and would look green, so its share is judged the way the flake rate is, and a degraded environment turns the gate red.

**The budget** ([`FLAKE_POLICY.invalidRunBudgetRate`](../src/shared/criteria.ts): 40 %, an assumption whose only evidence is that one runner). Per test and engine, over the last 30 *scheduled executions* (the runs that ran to a verdict, retried or not, and the invalid runs; a documented-gap skip and an interrupted test are neither), judged from 20 of them: **above 40 % the gate fails** with `over-invalid-budget` (12 of 30 is exactly 40 % and passes, 13 does not). A leg that really ends 25 % of its attempts as invalid runs is over it in 2.2 % of full windows, and one that ends half of them in 82 % (the arithmetic is in `criteria.ts`). On the two collections whose records are the fixtures of `tests/unit/flake` (8 of 40 and 6 of 40) the gate would have passed every build, and the highest share it judged was 20 % and 25 %. It judges the tests that the build scheduled (ran, or ended as invalid runs), each on its own engine; below 20 scheduled executions it prints the share and says there is no verdict yet. A share under the budget is not a clean bill: a leg at 39 % evaluates its claim in 6 attempts of 10, and the gate is green.

**What the gate prints** (a fixture history from the test helpers, run with `npx tsx`: not a measurement of the lab), trimmed:

```text
Invalid runs of the tests of this build (the last 30 scheduled executions each, judged from 20, budget 40.0%; 0 with none are not listed)
| test | engine | invalid | scheduled | share | budget | verdict | quarantine |
| PB-ABR-002 | webkit | 13 | 30 | 43.3% | 40.0% | over-invalid-budget | no |

1. [over-invalid-budget] PB-ABR-002 on webkit was an invalid run in 13 of 30 of its last scheduled executions (43.3%), the budget is 40.0%: the claim is no longer evaluated on this leg. Last invalid run: forced climb to 360p 3.3 s after the step down, 13 of 1104 frames dropped (run ..., 2026-10-01, commit ...).
   Decision: Fix the machine (load, decode), or declare the leg a documented gap with evidence (src/lab/gaps.ts), or retire the test on this leg: do not widen the budget to make it green. Who: the owner of the Adaptive bitrate (ABR) area. By when: before this merge; ...
```

The same numbers are in `reports/flake/gate.json` (`invalidRuns`, with the last reason) and in `npm run flake:report` (the section "Invalid runs": N of M, share, budget, verdict, the last reason).

**What to do.** Read the reasons: they carry the numbers of the attempts. Then one of three, in a pull request that says why:

- **Fix the machine** (load, decode). The old invalid runs stay in the window until newer executions push them out, so the gate turns green only after at most 18 valid executions of the leg (a full window holds 12 within the budget), fewer when the invalid runs were spread through it.
- **Declare the leg a documented gap**, with the evidence, in `src/lab/gaps.ts`. The leg's next run skips with a `documented gap in` reason, which is not a scheduled execution, so the build that carries the change no longer judges the leg. The old invalid runs stay in the history: a leg that comes back from a gap is judged on them.
- **Retire the test on this leg**: stop scheduling it there; retiring it altogether is removing its row from the catalog, with a reason ([TEST_STRATEGY.md](../TEST_STRATEGY.md) section 9).

**Do not widen the budget to make it green**: it is policy, revised with evidence. **A quarantine does not clear it**: it is about flakiness, and a quarantined test that is skipped still evaluates nothing. The executions it ran as quarantined count in the window like any other, the gate says that the quarantine does not cover the overrun, and the report shows the entry next to it. What the rule can hide and can wrongly fail is in [ADR-135a](decisions/flake.md).

## What the rate cannot tell

- A rate is a count over a window, not a probability. 30 executions cannot tell a test that flakes 1 % of the time from one that never does, and a test at 5 % is caught in 45 % of windows (the arithmetic is in `criteria.ts`). The suite budget catches what the per-test trigger cannot see: flakiness spread thin.
- It sees only what one retry hides: a lower bound. A test that fails twice by bad luck is a failure.
- It does not say that the test is at fault. A flaky outcome of a player test may be an intermittent defect of the player, and the history mixes commits: the report gives the commit and the signature of the last failure for that reason.
- The policy numbers are still the initial policy, and the collections gave no reason to revise them: 450 clean executions per Linux engine argue for no change of the trigger, and the one flaky test that the macOS runner showed (7 of 60 first attempts) is over the 5 % trigger by itself. They are placed by judgment and the arithmetic above, not derived from a model of the causes, and the history of CI (`ci-data`) is what will say whether they are right: on the day of writing it holds a handful of runs.

## Collecting the data

```sh
npm run serve                                   # once, on PB_PORT: the repetitions reuse the service
npx tsx tools/flake-collect.ts --project chromium --runs 30 --grep @merge
npm run flake:report
```

Each repetition is one Playwright invocation with one retry and the flake reporter on its command line; its run file (`reports/flake/collect/run-<n>.json`) is appended to `flake/history/<envId>.jsonl` before the next one starts, so a crash keeps what was gathered, and the output directory of every repetition is kept, so that a failed attempt keeps its trace. Take the numbers from `flake:report` and quote the machine, the date, the commit and the command with them (METRICS.md: a number carries its environment). On GitHub's runners the same command is the task `flake-collect` of `measure.yml` ([CI.md](CI.md), "Measurements on GitHub runners"); the collections made so far, with their numbers, are in [results/flake](results/flake/README.md).

## Files and variables

| Name | What it is |
| --- | --- |
| `reports/flake/run.json` | The record of one Playwright invocation (the reporter's output). `run-quarantined.json` is the second invocation of `gate:merge`. |
| `reports/flake/gate.json`, `report.json`, `report.md` | The gate's decision, and the report, as files. |
| `flake/history/<envId>.jsonl` | The file store. |
| `flake/quarantine.json` | The quarantine list. |
| `PB_FLAKE_RUN_FILE`, `PB_RUN_ID` | Where the reporter writes; the build a run belongs to (a wrapper sets them to keep invocations apart). Parallel stages that share one workspace (a Jenkins `parallel` block on one agent) must give each engine its own `PB_FLAKE_RUN_FILE`, for example `reports/flake/<project>/run.json`, or they overwrite one another. |
| `PB_FLAKE_QUARANTINE` | The quarantine list the reporter reads (default `flake/quarantine.json` next to the configuration). |
| `PB_FLAKE_STORE`, `PB_FLAKE_HISTORY_DIR`, `PB_FLAKE_GIT_REMOTE`, `PB_FLAKE_GIT_BRANCH`, `PB_FLAKE_GIT_IDENTITY` | The same as the command-line options of the gate and the report (`--help` lists them). |
| `PB_ENV_ID` | The environment id, when `detectEnvId()` is not what you want. |
