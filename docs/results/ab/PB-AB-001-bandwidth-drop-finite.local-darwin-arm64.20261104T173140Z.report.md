# PB-AB-001: A/A: configuration A against itself, rebuffering under a bandwidth drop on a finite link (the harness's own check before PB-AB-003)

**Equivalent within the margin: no meaningful difference (keep A)**

> A/A run (PB-AB-001): both arms ran configuration A. This is the harness checking itself: the verdict should be "equivalent within the margin" or "inconclusive", and never "A better" or "B better".

**Validity:** VALID: the experiment was run as pre-registered, on data that pass all 6 gates. The direction of the result does not enter: it drives the decision named for the row.

## Validity: was the experiment run as pre-registered, on data that can be trusted?

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to 3dd42b48f08401bb8447edfe6e1240bb08fc8c012225a445772348d65fdd94bd. The pre-registration file was committed unmodified in bbca833 on 2026-11-04T11:31:36-06:00, before the run started (2026-11-04T17:31:40.319Z). |
| Design followed | PASS | 64 sessions in 1 condition: blocks of two, the arm that goes first alternating, 2 warm-up blocks first, 30 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 64 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 64 finished sessions: the service held exactly the registered rules, and every rule fired on at least 6 requests of the session (27 to 27 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 0 of 60 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 2.7 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |

The lab passes an experiment when it is valid, not by the direction of its result. Whether A is better, B is better, they are equivalent within the margin, or the data cannot tell is the verdict below, and the verdict drives the decision the test catalog names for the row (ship B, do not ship B, keep A).

## Verdict

**Verdict: Equivalent within the margin: no meaningful difference (keep A).** Every primary interval lies inside its margin (Share of sessions with a rebuffer -11.4 pp to +11.4 pp within ±20 pp), so the data show that nothing worth a change is there.

**A/A reading.** The A/A verdict is "equivalent within the margin": the intervals of two copies of configuration A lie inside the practical thresholds, so this harness found no meaningful difference between them.

### The decision rule, applied literally

1. Harm (worse than the threshold with an interval that excludes zero): none.
2. Benefit (adjusted p < 0.05 and the whole interval beyond the threshold in B's favour): none; worse end of the interval not inside the threshold: none.
3. Equivalence (the whole interval inside the margin of plus or minus the threshold): 1 of 1 (rebufferShare).
4. Failed sessions: 0 of 60 failed, guard not tripped.

What each primary metric read:

- Share of sessions with a rebuffer: B minus A is 0 pp (95 % interval -11.4 pp to +11.4 pp), threshold 20 pp, adjusted p = 1.0: equivalent: the whole interval is inside the margin

### Primary metrics (Holm-adjusted over a family of 1)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Share of sessions with a rebuffer | 30 / 30 | 0 of 30 (0.0 %) | 0 of 30 (0.0 %) | 0 pp (95 % CI -11.4 pp to +11.4 pp) | n/a | Fisher's exact, 1.000 | 1.000 | 20 pp |

- Share of sessions with a rebuffer: exact (hypergeometric, two-sided); difference of the shares, Newcombe's hybrid score interval.

### Distribution of each arm (quantiles, from p10 to p90)

### The rung each session started on

| Arm | Sessions by start rung |
| --- | --- |
| A | 720p: 30 |
| B | 720p: 30 |

Both arms started on the same rungs in about the same proportions (A: 720p: 30; B: 720p: 30).

### Sessions, failures and errors

|  | Arm A | Arm B |
| --- | --- | --- |
| Warm-up sessions (recorded, left out) | 2 | 2 |
| Measured sessions attempted | 30 | 30 |
| Failed (reported, never silently dropped) | 0 | 0 |
| Analysed | 30 | 30 |
| Analysed sessions with a recoverable Shaka error | 0 | 0 |

No session failed.


### Secondary metrics (pre-registered, not part of the decision)

Raw p-values, no adjustment: they describe, they decide nothing.

| Metric | n A / n B | A | B | B minus A | Cliff's delta | Test, raw p |
| --- | --- | --- | --- | --- | --- | --- |
| Rebuffer ratio | 30 / 30 | 0 % (p90 0 %) | 0 % (p90 0 %) | 0 pp (95 % CI 0 pp to 0 pp) | 0.00 (negligible) | Mann-Whitney, 1.000 |


## Exploratory (not pre-registered, outside the Holm family)

Nothing in this section was in the plan. It is here so that the data are not hidden, not so that it can be quoted: every p-value is raw, and one comparison in twenty is significant by chance.

### Metrics that were not pre-registered

Recorded in every session and compared here with the same tests, but with raw p-values, no adjustment and no threshold: they describe, they decide nothing, and one in twenty of them will look significant by chance.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Startup time | 30 / 30 | -0.5 ms (CI -1.9 ms to +0.9 ms) | 0.544 |
| Rebuffer count | 30 / 30 | 0 (CI 0 to 0) | 1.000 |
| Rebuffer duration | 30 / 30 | 0 ms (CI 0 ms to 0 ms) | 1.000 |
| Rung switches | 30 / 30 | 0 (CI 0 to 0) | 1.000 |
| Dropped-frame ratio | 30 / 30 | 0 pp (CI 0 pp to 0 pp) | 1.000 |

### Startup within the rung the sessions started on (rung-matched)

Only the rungs that at least 5 sessions of each arm started on can be compared. Which rung a session starts on is decided by the configuration, not by chance, so this is not a randomised comparison.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Startup time of the sessions that started on 720p | 30 / 30 | -0.5 ms (CI -1.9 ms to +0.9 ms) | 0.544 |

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was quiet by its load average. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `bandwidth-drop-finite`: {"type":"throttle","kbps":20000}, {"type":"throttle","kbps":600,"afterMs":8000}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **One A/A run.** It checks the whole procedure once. With a perfect harness one run in twenty is significant by chance: a failure is a reason to repeat it as a new pre-registered run and to read the calibration, not a verdict on its own.

## Design and plan

|  |  |
| --- | --- |
| Experiment | PB-AB-001-bandwidth-drop-finite (aa, catalog row PB-AB-001) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration A: no overrides (Shaka's own defaults) |
| Conditions | `bandwidth-drop-finite`: `{"type":"throttle","kbps":20000}`, `{"type":"throttle","kbps":600,"afterMs":8000}` |
| Sessions | 30 per arm planned, 2 warm-up per arm recorded and left out; observation: first frame and 18 s of media after it, timeout 120000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (5000 resamples, seed 20261112); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/PB-AB-001-bandwidth-drop-finite.json`, sha256 `3dd42b48f08401bb8447edfe6e1240bb08fc8c012225a445772348d65fdd94bd`. The pre-registration file was committed unmodified in bbca833 on 2026-11-04T11:31:36-06:00, before the run started (2026-11-04T17:31:40.319Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T17:31:40.319Z, finished 2026-11-04T17:51:19.896Z; code at commit bbca833 |
| Load average (1 min) | bandwidth-drop-finite: 2.7 before, 3.2 after |
| Command | `npm run ab -- --prereg ab/prereg/PB-AB-001-bandwidth-drop-finite.json --port 4720` |

### The plan, as pre-registered

- Hypothesis (rebufferShare): Both arms run configuration A, so the harness must not find a difference: a primary metric that is significant after Holm's correction, or a verdict of A better or B better, counts as the harness finding a difference that is not there.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| rebufferShare | primary | lower-is-better | 20 pp | One session in five stalling more, or less, often is what a team would change a default for: rebuffering is what viewers feel most. It is the number PB-AB-003 will use unless this pilot says the design cannot detect it, in which case the experiment uses the minimum detectable effect of the pilot, as the strategy requires. | n/a |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: The rule of the experiments, applied to two copies of configuration A: four verdicts (A better, B better, equivalent within the margin, inconclusive). The harness passes this check when no primary metric is significant after Holm's correction and the verdict is neither A better nor B better, and when the A/A calibration of the pool of sessions (2000 random splits) does not show its false-positive rate above alpha.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. The number of sessions is fixed in advance: there is no interim analysis, no extension and no re-run to improve a result. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## A/A calibration (PB-AB-001): the false-positive rate of the harness

A pool of 60 sessions of configuration A was split at random into two arms of 30, 2000 times, and the full pipeline (tests, Holm over the primary family, bootstrap intervals, decision rule) was applied to each split. Every split compares two samples of the same configuration, so every significant one is a false positive.

**PASS: The harness declared 0.00 % (0 of 2000; 95 % interval 0.00 to 0.18 %) of the splits of identical sessions significant: not above the significance level of 5 %, and well below it: it is safe and conservative, so it will under-detect rather than over-claim.**

| | |
| --- | --- |
| Splits declared significant (any primary metric, Holm-adjusted p < 0.05) | 0 of 2000 = 0.00 % |
| Exact binomial interval (95 %) | 0.00 % to 0.18 % |
| Required | the lower end of the interval at or below 5 % |
| Verdicts over the splits | B better 0, A better 0 (both are false alarms between identical sessions), equivalent within the margin 2000, inconclusive 0 |

Share of splits in which the raw p-value of a primary metric was below a level (a valid test has each at most its level):

| Metric | p < 0.01 | p < 0.05 | p < 0.10 | p < 0.25 |
| --- | --- | --- | --- | --- |
| rebufferShare | 0.0 % | 0.0 % | 0.0 % | 0.0 % |

What this checks and what it does not: the statistics, given these sessions. The splits share their sessions, so the interval describes the splits drawn, not the pool; and a random split mixes away the order of the sessions, so a drift of the machine over time is invisible here. The real interleaved A/A run checks the procedure.

## Files

- Raw results: `docs/results/ab/PB-AB-001-bandwidth-drop-finite.local-darwin-arm64.20261104T173140Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/PB-AB-001-bandwidth-drop-finite.local-darwin-arm64.20261104T173140Z.raw.json`.

