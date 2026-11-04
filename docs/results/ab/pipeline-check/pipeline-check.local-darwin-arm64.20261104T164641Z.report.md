# pipeline-check: Pipeline check: six sessions that prove the harness runs end to end (it decides nothing)

**Pipeline check, plumbing only, not evidence: no verdict**

> PIPELINE CHECK, PLUMBING ONLY, NOT EVIDENCE: a few sessions that show the harness runs end to end, on a machine that may be shared with other work. Its numbers decide nothing and mean nothing, and no threshold, size, margin or level is tuned from them.

**Validity:** Plumbing checks passed (6 of 6). This is a pipeline check, plumbing only, not evidence.

## Plumbing checks (pipeline check, plumbing only, not evidence)

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to c52c09eae2d7b9b0101610b3e25dcd5a9b9ddaf728adb099ad141984f3d98cdd. The pre-registration file was committed unmodified in 1a4095b on 2026-11-04T10:29:02-06:00, before the run started (2026-11-04T16:46:41.756Z). |
| Design followed | PASS | 6 sessions in 1 condition: blocks of two, the arm that goes first alternating, 1 warm-up block first, 2 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 6 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 6 finished sessions: the service held exactly the registered rules, and every rule fired on at least 19 requests of the session (19 to 29 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 0 of 4 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 4.0 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |

A pipeline check proves that the pieces run together. It is not evidence about the player, and nothing is tuned from it.

## Verdict

**No verdict.** This is a pipeline check: a few sessions that show the harness runs end to end. Its statistics are printed to show the report works; they decide nothing.

### Primary metrics (Holm-adjusted over a family of 1)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Startup time | 2 / 2 | 637 ms (p90 688 ms) | 693 ms (p90 717 ms) | +55.9 ms (95 % CI -38.6 ms to +151 ms) | 0.50 (large) | Mann-Whitney, 0.667 | 0.667 | 100 ms |

- Startup time: exact permutation distribution; Hodges-Lehmann shift, seeded percentile bootstrap interval (1000 resamples).

### Distribution of each arm (quantiles, from p10 to p90)

Startup time:

| Arm | p10 | p20 | p30 | p40 | p50 | p60 | p70 | p80 | p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 586 ms | 599 ms | 611 ms | 624 ms | 637 ms | 650 ms | 663 ms | 675 ms | 688 ms |
| B | 669 ms | 675 ms | 681 ms | 687 ms | 693 ms | 699 ms | 705 ms | 711 ms | 717 ms |

### The rung each session started on

| Arm | Sessions by start rung |
| --- | --- |
| A | 720p: 2 |
| B | 240p: 2 |

The arms never started on the same rung (A: 720p: 2; B: 240p: 2). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

### Sessions, failures and errors

|  | Arm A | Arm B |
| --- | --- | --- |
| Warm-up sessions (recorded, left out) | 1 | 1 |
| Measured sessions attempted | 2 | 2 |
| Failed (reported, never silently dropped) | 0 | 0 |
| Analysed | 2 | 2 |
| Analysed sessions with a recoverable Shaka error | 0 | 0 |

No session failed.


### Secondary metrics (pre-registered, not part of the decision)

Raw p-values, no adjustment: they describe, they decide nothing.

| Metric | n A / n B | A | B | B minus A | Cliff's delta | Test, raw p |
| --- | --- | --- | --- | --- | --- | --- |
| Share of sessions with a rebuffer | 2 / 2 | 0 of 2 (0.0 %) | 0 of 2 (0.0 %) | 0 pp (95 % CI -65.8 pp to +65.8 pp) | n/a | Fisher's exact, 1.000 |
| Rebuffer ratio | 2 / 2 | 0 % (p90 0 %) | 0 % (p90 0 %) | 0 pp (95 % CI 0 pp to 0 pp) | 0.00 (negligible) | Mann-Whitney, 1.000 |


## Exploratory (not pre-registered, outside the Holm family)

Nothing in this section was in the plan. It is here so that the data are not hidden, not so that it can be quoted: every p-value is raw, and one comparison in twenty is significant by chance.

### Metrics that were not pre-registered

Recorded in every session and compared here with the same tests, but with raw p-values, no adjustment and no threshold: they describe, they decide nothing, and one in twenty of them will look significant by chance.

| Comparison | n A / n B | B minus A | Raw p |
| --- | --- | --- | --- |
| Rebuffer count | 2 / 2 | 0 (CI 0 to 0) | 1.000 |
| Rebuffer duration | 2 / 2 | 0 ms (CI 0 ms to 0 ms) | 1.000 |
| Rung switches | 2 / 2 | +1.5 (CI +1 to +2) | 0.333 |
| Dropped-frame ratio | 2 / 2 | 0 pp (CI 0 pp to 0 pp) | 1.000 |

### Startup within the rung the sessions started on (rung-matched)

No start rung was reached by at least 5 sessions of both arms: a rung-matched comparison is not possible with these data.

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was quiet by its load average. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `high-latency`: {"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **B is several settings together.** Configuration B differs from configuration A in 4 settings at once: `abr.useNetworkInformation` = false (Shaka's default: true); `abr.defaultBandwidthEstimate` = 500 kbps (Shaka's default: 1000 kbps); `abr.switchInterval` = 4 s (Shaka's default: 8 s); `streaming.bufferingGoal` = 20 s (Shaka's default: 10 s). The two configurations are compared as they are shipped, not setting by setting: no effect found here can be credited to one of these settings, and no arm of A plus one setting was run.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **The first rung is part of the difference.** The arms never started on the same rung (A: 720p: 2; B: 240p: 2). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

## Design and plan

|  |  |
| --- | --- |
| Experiment | pipeline-check (pipeline-check) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration B: overrides `{"abr":{"useNetworkInformation":false,"defaultBandwidthEstimate":500000,"switchInterval":4},"streaming":{"bufferingGoal":20}}` (Shaka's defaults at those keys: `{"abr":{"useNetworkInformation":true,"defaultBandwidthEstimate":1000000,"switchInterval":8},"streaming":{"bufferingGoal":10}}`) |
| Conditions | `high-latency`: `{"type":"latency","ms":300,"jitterMs":100,"match":{"kind":"any"}}` |
| Sessions | 2 per arm planned, 1 warm-up per arm recorded and left out; observation: first frame and 6 s of media after it, timeout 60000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (1000 resamples, seed 20261104); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/pipeline-check.json`, sha256 `c52c09eae2d7b9b0101610b3e25dcd5a9b9ddaf728adb099ad141984f3d98cdd`. The pre-registration file was committed unmodified in 1a4095b on 2026-11-04T10:29:02-06:00, before the run started (2026-11-04T16:46:41.756Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T16:46:41.756Z, finished 2026-11-04T16:47:23.526Z; code at commit 1dce76c |
| Load average (1 min) | high-latency: 4.0 before, 4.6 after |
| Command | `npm run ab -- --prereg ab/prereg/pipeline-check.json --port 4720 --out-dir docs/results/ab/pipeline-check` |

### The plan, as pre-registered

- Hypothesis (startupMs): None about the configurations: this run proves that the service, the browser, the page, the runner, the analysis and the report work together. Six sessions cannot say anything about configuration B.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| startupMs | primary | lower-is-better | 100 ms | A tenth of a second is the smallest startup change a viewer notices on a page load. A pipeline check decides nothing, so the number only has to be there. | n/a |
| rebufferShare | secondary | lower-is-better | n/a | n/a | n/a |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: Four verdicts and no more: B better (ship B), A better (do not ship B), equivalent within the margin (keep A), inconclusive (keep A and collect more sessions). A pipeline check applies none of them: it prints no verdict.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## Files

- Raw results: `docs/results/ab/pipeline-check/pipeline-check.local-darwin-arm64.20261104T164641Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/pipeline-check/pipeline-check.local-darwin-arm64.20261104T164641Z.raw.json`.

