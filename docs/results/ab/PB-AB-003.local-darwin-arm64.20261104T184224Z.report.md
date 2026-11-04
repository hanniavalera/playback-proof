# PB-AB-003: Rebuffering of configuration B against configuration A under a bandwidth drop on a finite link (Chromium, local-darwin-arm64)

**Equivalent within the margin: no meaningful difference (keep A)**

> Pre-registered A/B experiment: the verdict below is the decision rule applied to the pre-registered metrics. The lab passes it when it is valid (see Validity), whatever the direction of the result: the direction drives the decision.

**Validity:** VALID: the experiment was run as pre-registered, on data that pass all 7 gates. The direction of the result does not enter: it drives the decision named for the row.

## Validity: was the experiment run as pre-registered, on data that can be trusted?

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to bc930ea63fac5e7a721365d85ce29528bb7f96a89c03fff3f6693c6383d6121d. The pre-registration file was committed unmodified in 150da3b on 2026-11-04T12:42:21-06:00, before the run started (2026-11-04T18:42:24.910Z). |
| Design followed | PASS | 84 sessions in 1 condition: blocks of two, the arm that goes first alternating, 2 warm-up blocks first, 40 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 82 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 82 finished sessions: the service held exactly the registered rules, and every rule fired on at least 36 requests of the session (57 to 69 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 2 of 80 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 3.7 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |
| A/A check passed (PB-AB-001) | PASS | docs/results/ab/PB-AB-001-bandwidth-drop-finite-40s.local-darwin-arm64.20261104T175652Z.report.json: the real interleaved A/A and its calibration passed for bandwidth-drop-finite on chromium in local-darwin-arm64. |

The lab passes an experiment when it is valid, not by the direction of its result. Whether A is better, B is better, they are equivalent within the margin, or the data cannot tell is the verdict below, and the verdict drives the decision the test catalog names for the row (ship B, do not ship B, keep A).

## Verdict

**Verdict: Equivalent within the margin: no meaningful difference (keep A).** Every primary interval lies inside its margin (Share of sessions with a rebuffer -9 pp to +9 pp within ±20 pp), so the data show that nothing worth a change is there.

### The decision rule, applied literally

1. Harm (worse than the threshold with an interval that excludes zero): none.
2. Benefit (adjusted p < 0.05 and the whole interval beyond the threshold in B's favour): none; worse end of the interval not inside the threshold: none.
3. Equivalence (the whole interval inside the margin of plus or minus the threshold): 1 of 1 (rebufferShare).
4. Failed sessions: 2 of 80 failed, guard not tripped.

What each primary metric read:

- Share of sessions with a rebuffer: B minus A is 0 pp (95 % interval -9 pp to +9 pp), threshold 20 pp, adjusted p = 1.0: equivalent: the whole interval is inside the margin

### Primary metrics (Holm-adjusted over a family of 1)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Share of sessions with a rebuffer | 39 / 39 | 0 of 39 (0.0 %) | 0 of 39 (0.0 %) | 0 pp (95 % CI -9 pp to +9 pp) | n/a | Fisher's exact, 1.000 | 1.000 | 20 pp |

- Share of sessions with a rebuffer: exact (hypergeometric, two-sided); difference of the shares, Newcombe's hybrid score interval.

### Distribution of each arm (quantiles, from p10 to p90)

### The rung each session started on

| Arm | Sessions by start rung |
| --- | --- |
| A | 720p: 39 |
| B | 240p: 39 |

The arms never started on the same rung (A: 720p: 39; B: 240p: 39). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

### Sessions, failures and errors

|  | Arm A | Arm B |
| --- | --- | --- |
| Warm-up sessions (recorded, left out) | 2 | 2 |
| Measured sessions attempted | 40 | 40 |
| Failed (reported, never silently dropped) | 1 | 1 |
| Analysed | 39 | 39 |
| Analysed sessions with a recoverable Shaka error | 0 | 0 |

Failure counts differ between the arms with Fisher p = 1.000. The failure guard did not trip.

- session 73 (block 37, arm A): page: the player page did not boot (http://127.0.0.1:4720/player/?manifest=%2Fs%2F72b413738bc5%2Fvod-cmaf%2Fdash%2Fmanifest.mpd&config=A): ReferenceError: shaka is not defined
- session 74 (block 37, arm B): timeout: PB-AB-003 bandwidth-drop-finite B #74 did not finish within 180000 ms

### Secondary metrics (pre-registered, not part of the decision)

Raw p-values, no adjustment: they describe, they decide nothing.

| Metric | n A / n B | A | B | B minus A | Cliff's delta | Test, raw p |
| --- | --- | --- | --- | --- | --- | --- |
| Rebuffer ratio | 39 / 39 | 0 % (p90 0 %) | 0 % (p90 0 %) | 0 pp (95 % CI 0 pp to 0 pp) | 0.00 (negligible) | Mann-Whitney, 1.000 |


## Exploratory (not pre-registered, outside the Holm family)

Nothing in this section was in the plan. It is here so that the data are not hidden, not so that it can be quoted: every p-value is raw, and one comparison in twenty is significant by chance.

### Metrics that were not pre-registered

Recorded in every session and compared here with the same tests, but with raw p-values, no adjustment and no threshold: they describe, they decide nothing, and one in twenty of them will look significant by chance.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Startup time | 39 / 39 | -149 ms (CI -155 ms to -146 ms) | < 0.001 |
| Rebuffer count | 39 / 39 | 0 (CI 0 to 0) | 1.000 |
| Rebuffer duration | 39 / 39 | 0 ms (CI 0 ms to 0 ms) | 1.000 |
| Rung switches | 39 / 39 | +1 (CI +1 to +1) | < 0.001 |
| Dropped-frame ratio | 39 / 39 | 0 pp (CI 0 pp to 0 pp) | 0.453 |

### Startup within the rung the sessions started on (rung-matched)

No start rung was reached by at least 5 sessions of both arms: a rung-matched comparison is not possible with these data.

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was NOT quiet: the load average reached 17.0 on 12 CPUs, more than 50 % of them. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `bandwidth-drop-finite`: {"type":"throttle","kbps":20000}, {"type":"throttle","kbps":600,"afterMs":8000}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **B is several settings together.** Configuration B differs from configuration A in 4 settings at once: `abr.useNetworkInformation` = false (Shaka's default: true); `abr.defaultBandwidthEstimate` = 500 kbps (Shaka's default: 1000 kbps); `abr.switchInterval` = 4 s (Shaka's default: 8 s); `streaming.bufferingGoal` = 20 s (Shaka's default: 10 s). The two configurations are compared as they are shipped, not setting by setting: no effect found here can be credited to one of these settings, and no arm of A plus one setting was run.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **The first rung is part of the difference.** The arms never started on the same rung (A: 720p: 39; B: 240p: 39). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

## Design and plan

|  |  |
| --- | --- |
| Experiment | PB-AB-003 (experiment, catalog row PB-AB-003) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration B: overrides `{"abr":{"useNetworkInformation":false,"defaultBandwidthEstimate":500000,"switchInterval":4},"streaming":{"bufferingGoal":20}}` (Shaka's defaults at those keys: `{"abr":{"useNetworkInformation":true,"defaultBandwidthEstimate":1000000,"switchInterval":8},"streaming":{"bufferingGoal":10}}`) |
| Conditions | `bandwidth-drop-finite`: `{"type":"throttle","kbps":20000}`, `{"type":"throttle","kbps":600,"afterMs":8000}` |
| Sessions | 40 per arm planned, 2 warm-up per arm recorded and left out; observation: first frame and 40 s of media after it, timeout 180000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (5000 resamples, seed 20261131); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/PB-AB-003.json`, sha256 `bc930ea63fac5e7a721365d85ce29528bb7f96a89c03fff3f6693c6383d6121d`. The pre-registration file was committed unmodified in 150da3b on 2026-11-04T12:42:21-06:00, before the run started (2026-11-04T18:42:24.910Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T18:42:24.910Z, finished 2026-11-04T19:45:52.437Z; code at commit 150da3b |
| Load average (1 min) | bandwidth-drop-finite: 3.7 before, 17.0 after |
| Command | `npm run ab -- --prereg ab/prereg/PB-AB-003.json --port 4720` |

### The plan, as pre-registered

- Hypothesis (rebufferShare): The two configurations as shipped stall about equally often under the drop: B does not stall in a share of sessions more than 20 percentage points above A. Neither is expected to stall often: in the two A/A pilots of this condition (18 s and 40 s of media) none of the 120 measured sessions of configuration A stalled, and every one of the 60 sessions of the second pilot went 720p, then 360p (between 16.7 and 16.9 s), then 240p (between 24.7 and 24.9 s). With the share of A at 0 the experiment can show that B stalls more (A better) or that the two are equivalent within 20 points; it cannot show that B stalls less, because a share cannot fall below 0. The verdict that would confirm the expectation is equivalent within the margin.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| rebufferShare | primary | lower-is-better | 20 pp | One session in five stalling more often than in the other arm is what a team would change a default for: rebuffering is what viewers feel most. This is the number written in the plan of the A/A pilot before its data. The sample size comes from that pilot by the rule stated there: the smallest even number of sessions per arm, at most 50, whose minimum detectable effect is not above the threshold. At 30 sessions per arm the minimum is 25.2 points and at 38 it is 20.1, above the threshold; at 40 it is 19.0 points (80 % power), so the design has 40 sessions per arm and the threshold stays 0.2. The threshold is also the margin of equivalence. | 19 pp at 40 per arm, power 0.8 (`docs/results/ab/PB-AB-001-bandwidth-drop-finite-40s.local-darwin-arm64.20261104T175652Z.power-40.json`) |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: Four verdicts and no more: B better (ship B) only if the whole interval of the primary metric lies beyond the threshold in B's favour, the Holm-adjusted p is below alpha and no primary metric is harmed; A better (do not ship B) if the primary metric is worse beyond the threshold with an interval that excludes zero; equivalent within the margin (keep A) only if the whole interval lies inside plus or minus the threshold; inconclusive (keep A, collect more sessions) otherwise. Not finding a difference is not evidence that there is none.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. The number of sessions is fixed in advance, 40 per arm after the warm-up: there is no interim analysis, no extension and no re-run to improve a result; the condition stops only after 5 failed sessions in a row. If the run is not valid (a data-quality gate fails) the report says so and the verdict is not acted on. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## Files

- Raw results: `docs/results/ab/PB-AB-003.local-darwin-arm64.20261104T184224Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/PB-AB-003.local-darwin-arm64.20261104T184224Z.raw.json`.

