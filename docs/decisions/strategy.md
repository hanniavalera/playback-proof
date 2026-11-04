# Test strategy decisions (ADR-020 to ADR-027)

The decisions behind [TEST_STRATEGY.md](../../TEST_STRATEGY.md), written so each one can be defended in a review: what the situation was, what was chosen, what was rejected and why, what it costs, and how I would defend it. They were taken in Phase 1, before any component existed, so **every number they quote is either computed from the catalog and the policy constants of [`src/shared/criteria.ts`](../../src/shared/criteria.ts) or stated as an assumption; none of it is measured.** Phase 3, 4 and 7 replace estimates with measurements, and where that changes a decision this file is amended with the evidence. Earlier decisions: [ADR-001 to ADR-005](../DESIGN_DECISIONS.md).

## ADR-020: Risk-based tiering: likelihood x impact, merge at 15, release at 8

**Context.** A merge gate has to be fast enough that authors wait for it and strong enough to stop the changes that hurt members. Running every test on every pull request does not fit: at the design estimates the whole browser suite of one engine is about nine minutes of wall-clock, and the soak and the experiments are not even in it. Tiering by feature area ("all of VOD, then all of live") ignores that a seek race and a volume button are different risks. Tiering by test duration optimises time, not risk. There is no failure history yet to tier by.

**Decision.**

1. Every scenario gets a **likelihood** (1 to 5) and an **impact** (1 to 5), each level with a one-sentence definition (TEST_STRATEGY.md section 4.1). Impact includes reach (how many sessions) and the lab's own validity: a wrong metrics hook is scored at its real cost, because a gate that cannot fail is a silent hole.
2. **Score = L x I.** A test in the browser or performance lane gates a **merge from 15**, a **release from 8**; below 8 the scenario is exploratory and is not in the catalog, so nothing pretends to test it.
3. **Cost overrides the score in two lanes.** A unit test costs milliseconds and always gates the merge. A readiness run or an experiment needs minutes of wall-clock and a quiet machine and can only gate a release, however high its risk; the cheaper rows of the same risk gate the merge.
4. **The rule is enforced**: `npm run docs:check` computes the tier of every catalog row from its score and lane and fails on a disagreement, and checks that the ranked list of areas in the document agrees with the catalog (ADR-025).
5. **Scores change with evidence**: a product failure raises the likelihood of its area, an escape raises it and promotes the test, a long clean run may lower the likelihood, evidence of absence never lowers an impact.

**Why 15.** Threshold against the Phase 1 catalog, with the estimator of the docs check (merge job of one engine on the design-target runner, 480 s budget):

| Threshold | Browser tests in the merge job | Estimated wall-clock | Headroom | What it means |
| --- | --- | --- | --- | --- |
| 20 | 4 | 216 s | 264 s | Only the likely blockers. Starting a title is out. |
| 16 | 10 | 272 s | 208 s | Starting a title and the low-end class are out: possible blockers do not gate. |
| **15** | **15** | **304 s** | **176 s (37%)** | Every possible blocker (3 x 5) and every likely interruption (4 x 4). |
| 12 | 30 | 454 s | 26 s (5%) | Possible interruptions and likely degradations join; the job is at the ceiling with no room for growth or a slow runner. |
| 9 | 35 | 496 s | over budget | |
| 8 | 37 | 516 s | over budget | |

Products of integers from 1 to 5 jump from 12 to 15 to 16, so any threshold from 13 to 15 gives the same gate. 15 is the highest of them, and the one that reads as a policy: **a possible blocker gates a merge; so does a likely interruption; a possible interruption does not.** The budget then excludes everything lower, because 12 leaves 5% headroom against estimates that are themselves uncertain.

**Alternatives considered.** All tests on every pull request (over the budget before the soak is counted). Tiering by area or by feature owner. Tiering by historical failures (no history; it becomes the re-scoring loop). A weighted score that counts impact double (arguably fairer to impact, harder to explain; ties are ranked by impact, which captures the same preference). A failure-mode score with a detectability factor (detectability by other tests is low by design here, and the factor would be a third guess).

**Consequences.** The judgments are explicit, so a reviewer can disagree with one number on a one-sentence scale instead of with a feeling, and the disagreement changes the gate. Moving the line is a one-constant change and a re-render. One area is above the line without a merge-gate row (long live sessions: its test is a soak and cannot be cheap); the compensating control is a nightly soak, and the price is a window of about a day in which a leak or a drift regression can sit on `main`. The scores are not validated against incidents, because there are none: the re-scoring rule is how they earn that.

**Defending it.** "Show me what 15 does: it keeps every possible blocker and every likely interruption, and moving it to 12 doubles the merge tier and leaves 5% headroom. If you think a scenario is ranked wrong, argue about its two numbers; the docs check makes sure your argument changes what is gated."

## ADR-021: The merge gate: what is in it, its time budget, and why the performance gate belongs in it

**Context.** The resume claim is that suites ran as merge gates and that performance baselines failed merges on regressions. A gate that nobody waits for is bypassed, so it has a time budget. The performance gate is the noisiest part of it: shared runners vary, and a regression is a distribution shift, not an assertion.

**Decision.**

- **Contents.** Static checks, unit tests, the `@merge` browser tests (one job per engine, plus one for the CPU-throttled Chromium project), the performance gate and the flake gate. Triage runs on red builds and never decides a verdict.
- **Budgets.** Static plus unit under 4 minutes. The `@merge` job of one engine under **8 minutes on a 2-core runner with 2 workers**, which is a ceiling of **30 browser tests per engine**: (480 s budget - 90 s setup - 90 s for one failing test and its retry) x 2 workers / 20 s per test. The performance gate under **12 minutes per job**, with 6 more minutes allowed only on a failing build (the re-measure). The jobs of the engines run in parallel, so a pull request waits for the slowest.
- **The budgets are checked, not stated.** The docs check computes every job's estimated wall-clock from the catalog and the expected seconds per area (design estimates, replaced by measured durations in Phase 3) and fails when a job is over its budget or an engine is over the ceiling. The merge tier cannot grow past its budget unnoticed. At the Phase 1 catalog: 15 browser tests per engine, 304 s of 480 s; the performance job that carries both Chromium profiles is the tightest, at 640 s of 720 s.
- **The performance gate is in the merge gate although it is noisy**, because it is the only place where a regression can be attributed to a diff. A startup regression found a day later is a bisect across that day's merges, and one found a week later is archaeology. The noise is handled, not ignored: baselines per environment, median and p90 of N runs, a relative threshold plus an absolute floor, and **a failure must reproduce on a re-measure before it blocks** (ADR-004). An engine and metric pair whose baseline is too unstable to separate a regression from noise is tracked and reported but does not block, and the results say which pairs those are.
- **What is deliberately outside**: release-tier tests, the soak and readiness checks, A/B experiments, the full codec matrix, language-model summaries, and Linux WebKit playback (a documented gap). Each is long, noisy or not actionable per pull request (TEST_STRATEGY.md section 6.4).

**Alternatives considered.** Performance only nightly (a regression then costs a day of bisecting, and "failing merges on regressions" would be untrue). Performance as a non-blocking report (it becomes background noise within weeks). One serial job per pull request instead of one per engine (three times the wait). Buying a bigger runner to fit more tests (a count budget forces the triage that a time budget would let slide). Selecting tests by the files a change touches (needs a dependency map that a media player does not have; deferred, not rejected).

**Consequences.** Four browser jobs per pull request, one of them on a more expensive macOS runner for WebKit. Authors can be blocked by performance noise: mitigated by the re-measure and by being honest about which pairs gate, never by loosening a threshold after the fact. The budget forces a conversation each time a merge-tier test is proposed; the options, in order: make it cheaper (assert on the request log instead of waiting for media time), demote it with an argument, split the job, and only then change the budget, with an ADR. The estimates are design numbers; a measured value that breaks a budget is a finding, not an embarrassment.

**Defending it.** "Eight minutes is arithmetic I can show: 30 tests of ceiling, 15 used. The performance gate is noisy and I do not pretend otherwise: it has to reproduce before it blocks, and the pairs I cannot measure stably are labelled as tracked, not gating."

**Update (Phase 4, ADR-113 in [ci.md](ci.md)).** Linux WebKit is no longer outside the gate: after the experiment recorded in ADR-072 it runs there as an experimental, required job, so a pull request has five browser jobs, not four (one on a macOS runner). The budgets above stand.

## ADR-022: Flake policy: record every retry, gate on the rate, quarantine with an owner and an expiry

**Context.** A flaky test is a standing decision to ignore red. CI retries once (`playwright.config.ts`), which keeps a pipeline moving and, left alone, hides the problem. Media tests are timing-sensitive by nature, so some flake is certain.

**Decision.**

1. **A retried pass is not a pass.** Every attempt is recorded; flake rate per test = passed-after-retry / executions (docs/METRICS.md).
2. **Gate on the rate, with arithmetic.** Over a window of 30 executions, a test above 5% (that is, two flaky outcomes; one is 3.3%) must be fixed or quarantined, and the flake gate stays red until one has happened. Chosen from the binomial: a test that really flakes 1% of the time is condemned in 3.6% of windows, one at 5% in 45%, at 10% in 82%, at 20% in 99%: the worst offenders go first, healthy tests are left alone. A test needs 20 executions before it is judged. The **suite** has its own budget of 2% per engine job: at 1% per test, a merge job of about 15 tests needs a retry in 14% of builds, at 2% in 26%; it fails when flakiness is spread across tests, which points at the environment.
3. **Quarantine** is a committed entry with an owner, a reason (with the evidence that the failure is non-deterministic), a start date and an expiry within 14 days, or **7 days for a merge-tier test**. A quarantined test **still runs in a non-blocking job** and returns after a clean window. It is **never silently deleted**: retiring a test removes its catalog row in a pull request that says why, and the id is never reused.
4. **A quarantined merge-tier test must be fixed or replaced by its expiry**, and there are no renewals. "Replaced" means a cheaper, deterministic test of the same risk, typically one that asserts on the request log instead of on timing. When the expiry passes, the gate fails.
5. **Nobody reruns a red job until it is green.** Rerunning is for infrastructure failures, and reruns the job, not the test.

**Alternatives considered.** Unlimited automatic retries (hides everything). Disabling flaky tests (a silent deletion of coverage). A dashboard with no consequence (nobody acts on it). A per-pull-request rule, "fail if this pull request's tests flaked" (blames the author for a shared cost, and cannot see a test that flakes 5% of the time over many pull requests). A 1% trigger (one flaky outcome in 30 runs, which a healthy 1% test produces in 26% of windows).

**Consequences.** The gate can block a pull request for flakiness that is not its own. That is deliberate: the cost is shared, and the way out is a same-day quarantine with an owner and an expiry. A quarantined merge-tier test is a hole in the gate for up to a week. Tests at 1 to 2% are hard to see in a 30-run window (3.6% and 12% detection per window); the suite budget covers them in aggregate. The numbers come from arithmetic, not from a flake history, and are revised after a month of real history.

**Defending it.** "A flaky test is a decision to ignore red, so I made it expensive to keep one without saying so and cheap to quarantine honestly: an owner, a reason, a date. And the thresholds are not taste: here is the binomial that says why two in thirty."

## ADR-023: Live-readiness criteria are derived from the stream's arithmetic and marked as initial policy

**Context.** A live event has no second chance: nobody can rewatch it, and everyone arrives together. The owner of an event needs go/no-go numbers, and in Phase 1 there is nothing to measure yet. Phases 3 to 6 need the shape of the criteria (which exist, what each measures) to be built to.

**Decision.** The criteria live in `src/shared/criteria.ts`, rendered into the strategy by the docs check, and each number is one of three things, labelled as such in the table: a **fact** (copied from a configuration or a contract), **arithmetic** (computed from the stream's constants, so it follows if they change: 2 s segments, a 15-segment window, a 6 s presentation delay, a 2 s update period), or an **assumption** (a judgment, with its reasoning). Examples: latency target 6 s is the presentation delay; the p95 limit is the target plus one segment because the stream is GOP-aligned and a position is only defined to within one; recovery from a 10 s origin stall is allowed the outage plus two segments (one manifest refresh and one fetch). The 5-minute soak covers 10 DVR windows and 12 source loops, the 30-minute soak 60 and 75. **All of them are initial policy.** Phase 7 measures and revises them, and the rule is that a limit the default configuration cannot meet is a finding, not a number to relax.

**Alternatives considered.** Adopting numbers from industry rules of thumb (no source I can verify, so it would be borrowed authority). Waiting for measurements before writing any criterion (it blocks the phases that build to the shape). Setting limits at whatever passes (circular). Qualitative criteria only ("latency should be low"), which cannot gate anything.

**Consequences.** The numbers will change in Phase 7, and the document says so. Several are loose on purpose (start within 5 s on localhost fails only a broken join; the performance gate catches small regressions). Heap growth is measured in Chromium only. A 30-minute soak extrapolates to a multi-hour event.

**Defending it.** "Every number says where it comes from, and which ones are guesses. I would rather show a guess labelled as a guess than a measured-looking number that is not."

## ADR-024: What the lab refuses to claim

**Context.** The lab runs on localhost with software decoding and synthetic content, in engines that are not the consumer browsers, and without devices, a CDN or commercial DRM. It is easy to let a README imply more than that.

**Decision.** The strategy lists, next to what the lab tests, the questions it cannot answer and what would answer them: production quality of experience, a real CDN, real devices, commercial DRM, perceptual quality, captions, ads, picture-in-picture and accessibility. Specific rules follow from it. Lab numbers compare builds and configurations under identical conditions; they are never presented as production quality of experience and never compared across environments. The 4x CPU throttle is called a simulation of main-thread slowness, in Chromium only, not a device. Playwright's WebKit is called a WebKit build, not Safari. Language-model triage summaries are not claimed to work against the real service while no key is configured here. Every measured number in a document carries its environment, date and commit.

**Alternatives considered.** Describing coverage by the list of browsers and devices (implies device coverage the lab does not have). Presenting performance numbers as "player performance" (they are laboratory comparisons). Leaving the gaps out of the front page (the reader finds them later, with less goodwill).

**Consequences.** The lab looks smaller than a claim of "full device coverage" would, but every statement is true. The README must carry the same labels, and a reviewer who clones the repository can verify each one.

**Defending it.** "The value of a test lab is how much you can trust what it says. I put the questions it cannot answer on the same page as the ones it can."

## ADR-025: The catalog is the list of record, and tooling keeps the document true

**Context.** Strategy documents rot: the table of tests drifts from the specs, the thresholds quoted in prose from the code, the budget from the catalog. Phase 3 and later implement exactly the catalog, so it has to be data.

**Decision.** The catalog is a Markdown table between `BEGIN`/`END` markers, parsed strictly by `tools/catalog.ts`: exact columns in order, id `PB-AREA-NNN` unique, area agreeing with the id, risk that multiplies out, allowed tiers, engines and lanes that agree with each other, no empty cell. On top of it `npm run docs:check` verifies that every tier follows the tiering rule, that the **risk ranking** agrees with the catalog (ordered by score, every cited risk the catalog's, every gate what its rows are, every row in exactly one area), that the **merge tier fits its budget**, that every **generated block** is up to date (thresholds, area legend, budgets, merge budget, flake policy, live criteria and fault profiles are rendered from code; `--write` rewrites them, `--print` shows them), and that every test id cited anywhere in the documentation exists and is cited with the catalog's risk. From Phase 3 it also compares the catalog with the specs (ids, tags and engines). Ids are never renumbered or reused.

**Alternatives considered.** Prose (cannot be checked). A JSON or YAML catalog with the document generated from it (more robust to parse, but the table is what reviewers read and edit, and a generated document hides the judgment from the diff). A spreadsheet or an issue tracker (not versioned with the code). Hand-maintained numbers in the prose (stale within a phase).

**Consequences.** Editing is stricter: a message names the line, the id and the rule, and adding a row means choosing a score and finding its place in the ranking, which is the point. Parsing Markdown is more fragile than parsing JSON, which strictness and the tests of the checker itself (PB-LAB-006) compensate for. The parser and `expandEngines` are a dependency of Phase 3.

**Defending it.** "A document of numbers is only as good as the tool that refuses it when it is wrong, so the document is a data file that happens to read well."

## ADR-026: Fault profiles are named data, selected by segment number, and tied to the stream and the player

**Context.** The recovery, adaptation and experiment tests need the same conditions in every engine and every run (ADR-002 applies faults in the service). Without names, each spec would restate its own rules with its own semantics, and nothing would document what a condition is for.

**Decision.** Profiles are named `FaultRule[]` in `src/shared/profiles.ts`, each with its purpose and the catalog ids that use it, rendered into the strategy; `profile(name)` returns a fresh copy; the two live conditions are factories (`originStall(atNumber, ms)`, `staleManifest(ms, afterMs?)`) because a stall depends on the live segment number, which only the session knows. **Rules select requests by segment number rather than by time** wherever the scenario allows, so "the third video segment fails" is the same in a fast and a slow run; only the bandwidth drop uses time, because a weakening link is the point. The numbers are tied to evidence the unit tests check: the throttles to the stream ladder (1500 kbps carries 360p with its audio, not 720p; 600 kbps carries 240p only), the failure counts and the slow-segment delay to the **retry policy and connection timeout of the pinned Shaka Player 5.3.3**, read from the installed package (one 404 is absorbed by the two default attempts; three 503s in a row exhaust them and force the failure path; an 8 s delay is under the 10 s connection timeout, so the request is late, not failed).

**Alternatives considered.** Rules written inline in each spec (inconsistent, undocumented). CDP network emulation (Chromium only: ADR-002). Time windows for every fault (the same rule hits different requests in different runs). A rule DSL (a language to maintain for twelve conditions).

**Consequences.** Five more profiles than the seven the minimum required (one for each recovery row that needed its own condition), each used by a catalog row. A Shaka upgrade that changes a retry default fails a unit test, which is the intent: the profile's expectation is reviewed, not silently invalidated. A configuration B with other retry settings can still be tested with the same profiles; the assertions are outcomes (playback continues, at most one rebuffer), not the player's internals. Profiles describe lab conditions, not production ones.

**Defending it.** "A condition is data with a name and a reason, and the reason is checked: the throttle numbers against the ladder, the failure counts against the library's actual retry policy."

## ADR-027: Experiments are pre-registered, start with an A/A run, and use non-parametric statistics

**Context.** The lab compares two player configurations on startup and rebuffering. Startup times are right-skewed, the rebuffer ratio is zero for many sessions, machine load drifts, and a wrong verdict ships a worse configuration to everyone.

**Decision.** Metrics, conditions, sample size (never fewer than thirty sessions per arm, set from the A/A variance), the practical-significance threshold and the decision rule are fixed in a pre-registration file before any data is collected. Sessions are **interleaved** (A, B, A, B...) in fresh contexts, warm-up sessions are discarded. An **A/A run** comes first and gates the rest: the share of "significant" results between identical configurations must be close to the significance level (0.05), otherwise no verdict is published. The test is **Mann-Whitney U** with the **Hodges-Lehmann shift**, a seeded bootstrap 95% **confidence interval** and **Cliff's delta**; Fisher's exact test for the share of sessions with a rebuffer; p-values of the two primary metrics are **Holm**-adjusted. **Rule:** ship B only if it is better on at least one primary metric (adjusted p below the level and the interval entirely beyond the practical threshold) and not worse on the other; worse beyond the threshold with an interval that excludes zero means do not ship; **anything else is inconclusive and means keep A**.

**Alternatives considered.** A t-test (assumes a shape the data does not have). Comparing means (the tail is the problem). Running B once after A (drift is confounded with the effect). Peeking and stopping when significant (inflates false positives). No A/A (no knowledge of the harness's false-positive rate). Bonferroni (valid but less powerful than Holm for the same guarantee).

**Consequences.** More sessions than a casual comparison, and "inconclusive" is a normal outcome that the report quantifies (how many more sessions a decision needs). The experiment runs in one engine (Chromium) and says so. The practical threshold is chosen per experiment, which is a judgment that the pre-registration makes visible.

**Defending it.** "The harness's false-positive rate is what every verdict rests on, so I measure it first with an A/A run, and I decide what difference matters before I see the data."
