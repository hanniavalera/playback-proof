# PB-AB-002: Startup time of configuration B against configuration A under high latency (Chromium, local-darwin-arm64)

**Equivalent within the margin: no meaningful difference (keep A)**

> Pre-registered A/B experiment: the verdict below is the decision rule applied to the pre-registered metrics. The lab passes it when it is valid (see Validity), whatever the direction of the result: the direction drives the decision.

**Validity:** VALID: the experiment was run as pre-registered, on data that pass all 7 gates. The direction of the result does not enter: it drives the decision named for the row.

## Validity: was the experiment run as pre-registered, on data that can be trusted?

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to 3dd355840318b3cd10088fba57026999f6041d17f6f6430d509f0fdd6a5bd293. The pre-registration file was committed unmodified in e6adbf9 on 2026-11-04T11:23:14-06:00, before the run started (2026-11-04T17:23:19.123Z). |
| Design followed | PASS | 64 sessions in 1 condition: blocks of two, the arm that goes first alternating, 2 warm-up blocks first, 30 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 64 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 64 finished sessions: the service held exactly the registered rules, and every rule fired on at least 19 requests of the session (19 to 33 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 0 of 60 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 3.3 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |
| A/A check passed (PB-AB-001) | PASS | docs/results/ab/PB-AB-001-high-latency.local-darwin-arm64.20261104T171111Z.report.json: the real interleaved A/A and its calibration passed for high-latency on chromium in local-darwin-arm64. |

The lab passes an experiment when it is valid, not by the direction of its result. Whether A is better, B is better, they are equivalent within the margin, or the data cannot tell is the verdict below, and the verdict drives the decision the test catalog names for the row (ship B, do not ship B, keep A).

## Verdict

**Verdict: Equivalent within the margin: no meaningful difference (keep A).** Every primary interval lies inside its margin (Startup time -19.2 ms to +51.8 ms within ±100 ms), so the data show that nothing worth a change is there.

### The decision rule, applied literally

1. Harm (worse than the threshold with an interval that excludes zero): none.
2. Benefit (adjusted p < 0.05 and the whole interval beyond the threshold in B's favour): none; worse end of the interval not inside the threshold: none.
3. Equivalence (the whole interval inside the margin of plus or minus the threshold): 1 of 1 (startupMs).
4. Failed sessions: 0 of 60 failed, guard not tripped.

What each primary metric read:

- Startup time: B minus A is +15 ms (95 % interval -19.2 ms to +51.8 ms), threshold 100 ms, adjusted p = 0.39: equivalent: the whole interval is inside the margin

### Primary metrics (Holm-adjusted over a family of 1)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Startup time | 30 / 30 | 660 ms (p90 779 ms) | 683 ms (p90 771 ms) | +15 ms (95 % CI -19.2 ms to +51.8 ms) | 0.13 (negligible) | Mann-Whitney, 0.387 | 0.387 | 100 ms |

- Startup time: normal approximation with continuity and tie corrections; Hodges-Lehmann shift, seeded percentile bootstrap interval (5000 resamples).

### Distribution of each arm (quantiles, from p10 to p90)

Startup time:

| Arm | p10 | p20 | p30 | p40 | p50 | p60 | p70 | p80 | p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 570 ms | 613 ms | 635 ms | 650 ms | 660 ms | 704 ms | 726 ms | 752 ms | 779 ms |
| B | 635 ms | 645 ms | 651 ms | 659 ms | 683 ms | 695 ms | 724 ms | 739 ms | 771 ms |

### The rung each session started on

| Arm | Sessions by start rung |
| --- | --- |
| A | 720p: 30 |
| B | 240p: 30 |

The arms never started on the same rung (A: 720p: 30; B: 240p: 30). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

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
| Rung switches | 30 / 30 | +2 (CI +1 to +2) | < 0.001 |
| Dropped-frame ratio | 30 / 30 | 0 pp (CI 0 pp to 0 pp) | 1.000 |

### Startup within the rung the sessions started on (rung-matched)

No start rung was reached by at least 5 sessions of both arms: a rung-matched comparison is not possible with these data.

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was quiet by its load average. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `high-latency`: {"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **B is several settings together.** Configuration B differs from configuration A in 4 settings at once: `abr.useNetworkInformation` = false (Shaka's default: true); `abr.defaultBandwidthEstimate` = 500 kbps (Shaka's default: 1000 kbps); `abr.switchInterval` = 4 s (Shaka's default: 8 s); `streaming.bufferingGoal` = 20 s (Shaka's default: 10 s). The two configurations are compared as they are shipped, not setting by setting: no effect found here can be credited to one of these settings, and no arm of A plus one setting was run.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **The first rung is part of the difference.** The arms never started on the same rung (A: 720p: 30; B: 240p: 30). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

## Design and plan

|  |  |
| --- | --- |
| Experiment | PB-AB-002 (experiment, catalog row PB-AB-002) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration B: overrides `{"abr":{"useNetworkInformation":false,"defaultBandwidthEstimate":500000,"switchInterval":4},"streaming":{"bufferingGoal":20}}` (Shaka's defaults at those keys: `{"abr":{"useNetworkInformation":true,"defaultBandwidthEstimate":1000000,"switchInterval":8},"streaming":{"bufferingGoal":10}}`) |
| Conditions | `high-latency`: `{"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}` |
| Sessions | 30 per arm planned, 2 warm-up per arm recorded and left out; observation: first frame and 6 s of media after it, timeout 60000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (5000 resamples, seed 20261121); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/PB-AB-002.json`, sha256 `3dd355840318b3cd10088fba57026999f6041d17f6f6430d509f0fdd6a5bd293`. The pre-registration file was committed unmodified in e6adbf9 on 2026-11-04T11:23:14-06:00, before the run started (2026-11-04T17:23:19.123Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T17:23:19.123Z, finished 2026-11-04T17:30:39.143Z; code at commit e6adbf9 |
| Load average (1 min) | high-latency: 3.3 before, 3.8 after |
| Command | `npm run ab -- --prereg ab/prereg/PB-AB-002.json --port 4720` |

### The plan, as pre-registered

- Hypothesis (startupMs): The two configurations as shipped start within 100 ms of each other under 300 ms of latency: both wait for the same chain of round trips (manifest, initialization segments, first segments), and the link is not throttled. The verdict that would confirm it is equivalent within the margin; A better would mean B starts more than 100 ms slower, B better more than 100 ms faster. A and B start on different rungs, so any difference includes the first rung.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| startupMs | primary | lower-is-better | 100 ms | A tenth of a second is the smallest change in the time to the first frame that a viewer notices on a page load, so a smaller difference is not a reason to change a default. It is above the minimum detectable effect of the A/A pilot at 30 sessions per arm (55.7 ms for an increase, 52.8 ms for a decrease, 80 % power, from the sessions of configuration A under this condition), so the design can find it; the pilot says 30 sessions per arm suffice to detect it, which is the policy minimum. The threshold is also the margin of equivalence. | 55.7 ms at 30 per arm, power 0.8 (`docs/results/ab/PB-AB-001-high-latency.local-darwin-arm64.20261104T171111Z.power-30.json`) |
| rebufferShare | secondary | lower-is-better | n/a | n/a | n/a |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: Four verdicts and no more: B better (ship B) only if the whole interval of the primary metric lies beyond the threshold in B's favour, the Holm-adjusted p is below alpha and no primary metric is harmed; A better (do not ship B) if the primary metric is worse beyond the threshold with an interval that excludes zero; equivalent within the margin (keep A) only if the whole interval lies inside plus or minus the threshold; inconclusive (keep A, collect more sessions) otherwise. Not finding a difference is not evidence that there is none.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. The number of sessions is fixed in advance, 30 per arm after the warm-up: there is no interim analysis, no extension and no re-run to improve a result; the condition stops only after 5 failed sessions in a row. If the run is not valid (a data-quality gate fails) the report says so and the verdict is not acted on. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## Files

- Raw results: `docs/results/ab/PB-AB-002.local-darwin-arm64.20261104T172319Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/PB-AB-002.local-darwin-arm64.20261104T172319Z.raw.json`.

