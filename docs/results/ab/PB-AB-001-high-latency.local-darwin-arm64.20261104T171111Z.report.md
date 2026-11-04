# PB-AB-001: A/A: configuration A against itself, startup under high latency (the harness's own check before PB-AB-002)

**Equivalent within the margin: no meaningful difference (keep A)**

> A/A run (PB-AB-001): both arms ran configuration A. This is the harness checking itself: the verdict should be "equivalent within the margin" or "inconclusive", and never "A better" or "B better".

**Validity:** VALID: the experiment was run as pre-registered, on data that pass all 6 gates. The direction of the result does not enter: it drives the decision named for the row.

## Validity: was the experiment run as pre-registered, on data that can be trusted?

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to a9ed36411705b87040b2edb240785745460c4553394c3dea2c3f591aedfc7bcc. The pre-registration file was committed unmodified in 160e4ba on 2026-11-04T11:11:06-06:00, before the run started (2026-11-04T17:11:11.813Z). |
| Design followed | PASS | 64 sessions in 1 condition: blocks of two, the arm that goes first alternating, 2 warm-up blocks first, 30 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 64 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 64 finished sessions: the service held exactly the registered rules, and every rule fired on at least 19 requests of the session (19 to 20 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 0 of 60 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 2.7 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |

The lab passes an experiment when it is valid, not by the direction of its result. Whether A is better, B is better, they are equivalent within the margin, or the data cannot tell is the verdict below, and the verdict drives the decision the test catalog names for the row (ship B, do not ship B, keep A).

## Verdict

**Verdict: Equivalent within the margin: no meaningful difference (keep A).** Every primary interval lies inside its margin (Startup time -63.9 ms to +18.9 ms within ±100 ms), so the data show that nothing worth a change is there.

**A/A reading.** The A/A verdict is "equivalent within the margin": the intervals of two copies of configuration A lie inside the practical thresholds, so this harness found no meaningful difference between them.

### The decision rule, applied literally

1. Harm (worse than the threshold with an interval that excludes zero): none.
2. Benefit (adjusted p < 0.05 and the whole interval beyond the threshold in B's favour): none; worse end of the interval not inside the threshold: none.
3. Equivalence (the whole interval inside the margin of plus or minus the threshold): 1 of 1 (startupMs).
4. Failed sessions: 0 of 60 failed, guard not tripped.

What each primary metric read:

- Startup time: B minus A is -19.6 ms (95 % interval -63.9 ms to +18.9 ms), threshold 100 ms, adjusted p = 0.33: equivalent: the whole interval is inside the margin

### Primary metrics (Holm-adjusted over a family of 1)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Startup time | 30 / 30 | 692 ms (p90 758 ms) | 659 ms (p90 768 ms) | -19.6 ms (95 % CI -63.9 ms to +18.9 ms) | -0.15 (negligible) | Mann-Whitney, 0.333 | 0.333 | 100 ms |

- Startup time: normal approximation with continuity and tie corrections; Hodges-Lehmann shift, seeded percentile bootstrap interval (5000 resamples).

### Distribution of each arm (quantiles, from p10 to p90)

Startup time:

| Arm | p10 | p20 | p30 | p40 | p50 | p60 | p70 | p80 | p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 571 ms | 603 ms | 654 ms | 663 ms | 692 ms | 711 ms | 731 ms | 750 ms | 758 ms |
| B | 599 ms | 604 ms | 619 ms | 635 ms | 659 ms | 677 ms | 692 ms | 722 ms | 768 ms |

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
| Share of sessions with a rebuffer | 30 / 30 | 0 of 30 (0.0 %) | 0 of 30 (0.0 %) | 0 pp (95 % CI -11.4 pp to +11.4 pp) | n/a | Fisher's exact, 1.000 |
| Rebuffer ratio | 30 / 30 | 0 % (p90 0 %) | 0 % (p90 0 %) | 0 pp (95 % CI 0 pp to 0 pp) | 0.00 (negligible) | Mann-Whitney, 1.000 |


## Exploratory (not pre-registered, outside the Holm family)

Nothing in this section was in the plan. It is here so that the data are not hidden, not so that it can be quoted: every p-value is raw, and one comparison in twenty is significant by chance.

### Metrics that were not pre-registered

Recorded in every session and compared here with the same tests, but with raw p-values, no adjustment and no threshold: they describe, they decide nothing, and one in twenty of them will look significant by chance.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Rebuffer count | 30 / 30 | 0 (CI 0 to 0) | 1.000 |
| Rebuffer duration | 30 / 30 | 0 ms (CI 0 ms to 0 ms) | 1.000 |
| Rung switches | 30 / 30 | 0 (CI 0 to 0) | 1.000 |
| Dropped-frame ratio | 30 / 30 | 0 pp (CI 0 pp to 0 pp) | 1.000 |

### Startup within the rung the sessions started on (rung-matched)

Only the rungs that at least 5 sessions of each arm started on can be compared. Which rung a session starts on is decided by the configuration, not by chance, so this is not a randomised comparison.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Startup time of the sessions that started on 720p | 30 / 30 | -19.6 ms (CI -63.9 ms to +18.9 ms) | 0.333 |

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was quiet by its load average. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `high-latency`: {"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **One A/A run.** It checks the whole procedure once. With a perfect harness one run in twenty is significant by chance: a failure is a reason to repeat it as a new pre-registered run and to read the calibration, not a verdict on its own.

## Design and plan

|  |  |
| --- | --- |
| Experiment | PB-AB-001-high-latency (aa, catalog row PB-AB-001) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration A: no overrides (Shaka's own defaults) |
| Conditions | `high-latency`: `{"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}` |
| Sessions | 30 per arm planned, 2 warm-up per arm recorded and left out; observation: first frame and 6 s of media after it, timeout 60000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (5000 resamples, seed 20261111); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/PB-AB-001-high-latency.json`, sha256 `a9ed36411705b87040b2edb240785745460c4553394c3dea2c3f591aedfc7bcc`. The pre-registration file was committed unmodified in 160e4ba on 2026-11-04T11:11:06-06:00, before the run started (2026-11-04T17:11:11.813Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T17:11:11.813Z, finished 2026-11-04T17:18:32.067Z; code at commit 160e4ba |
| Load average (1 min) | high-latency: 2.7 before, 3.0 after |
| Command | `npm run ab -- --prereg ab/prereg/PB-AB-001-high-latency.json --port 4720` |

### The plan, as pre-registered

- Hypothesis (startupMs): Both arms run configuration A, so the harness must not find a difference: a primary metric that is significant after Holm's correction, or a verdict of A better or B better, counts as the harness finding a difference that is not there.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| startupMs | primary | lower-is-better | 100 ms | A tenth of a second is the smallest change in the time to the first frame that a viewer notices on a page load, so a smaller difference is not a reason to change a default. It is the number PB-AB-002 will use unless this pilot says the design cannot detect it. | n/a |
| rebufferShare | secondary | lower-is-better | n/a | n/a | n/a |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: The rule of the experiments, applied to two copies of configuration A: four verdicts (A better, B better, equivalent within the margin, inconclusive). The harness passes this check when no primary metric is significant after Holm's correction and the verdict is neither A better nor B better, and when the A/A calibration of the pool of sessions (2000 random splits) does not show its false-positive rate above alpha.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. The number of sessions is fixed in advance: there is no interim analysis, no extension and no re-run to improve a result. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## A/A calibration (PB-AB-001): the false-positive rate of the harness

A pool of 60 sessions of configuration A was split at random into two arms of 30, 2000 times, and the full pipeline (tests, Holm over the primary family, bootstrap intervals, decision rule) was applied to each split. Every split compares two samples of the same configuration, so every significant one is a false positive.

**PASS: The harness declared 5.00 % (100 of 2000; 95 % interval 4.09 to 6.05 %) of the splits of identical sessions significant: not above the significance level of 5 %.**

| | |
| --- | --- |
| Splits declared significant (any primary metric, Holm-adjusted p < 0.05) | 100 of 2000 = 5.00 % |
| Exact binomial interval (95 %) | 4.09 % to 6.05 % |
| Required | the lower end of the interval at or below 5 % |
| Verdicts over the splits | B better 0, A better 0 (both are false alarms between identical sessions), equivalent within the margin 1998, inconclusive 2 |

Share of splits in which the raw p-value of a primary metric was below a level (a valid test has each at most its level):

| Metric | p < 0.01 | p < 0.05 | p < 0.10 | p < 0.25 |
| --- | --- | --- | --- | --- |
| startupMs | 0.9 % | 5.0 % | 10.0 % | 24.3 % |

What this checks and what it does not: the statistics, given these sessions. The splits share their sessions, so the interval describes the splits drawn, not the pool; and a random split mixes away the order of the sessions, so a drift of the machine over time is invisible here. The real interleaved A/A run checks the procedure.

## Files

- Raw results: `docs/results/ab/PB-AB-001-high-latency.local-darwin-arm64.20261104T171111Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/PB-AB-001-high-latency.local-darwin-arm64.20261104T171111Z.raw.json`.

