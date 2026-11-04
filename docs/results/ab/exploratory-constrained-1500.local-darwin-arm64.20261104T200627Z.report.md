# exploratory-constrained-1500: EXPLORATORY: startup and rebuffering of configuration B against configuration A on a constrained link of 1500 kbps (Chromium, local-darwin-arm64)

**Exploratory, no verdict**

> EXPLORATORY comparison: pre-registered, but it estimates and decides nothing. No ship decision follows from it.

**Validity:** VALID: the experiment was run as pre-registered, on data that pass all 6 gates. The direction of the result does not enter: it drives the decision named for the row.

## Validity: was the experiment run as pre-registered, on data that can be trusted?

| Gate | Result | What was checked |
| --- | --- | --- |
| Pre-registration fixed first | PASS | The plan embedded in the results hashes to ea6d9fb11b6a5a397845ab0fb830ea47c8a8036707375fbcfd1b8bec6282a91f. The pre-registration file was committed unmodified in 5fc295a on 2026-11-04T11:58:57-06:00, before the run started (2026-11-04T20:06:27.152Z). |
| Design followed | PASS | 64 sessions in 1 condition: blocks of two, the arm that goes first alternating, 2 warm-up blocks first, 30 measured per arm, exactly the plan's schedule, rules and stream. |
| Configuration proved | PASS | 64 finished sessions: the page reported the configuration of its arm, with exactly its overrides, and played through Media Source Extensions. |
| Condition applied, the same in both arms | PASS | 64 finished sessions: the service held exactly the registered rules, and every rule fired on at least 26 requests of the session (27 to 33 requests per session); both arms were created with the same rules. |
| Failures few and even | PASS | 0 of 60 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike. |
| Machine quiet at the start | PASS | The 1-minute load average was 4.5 before the first session, on 12 CPUs (the limit is 50 % of them, 6.0). |

The lab passes an experiment when it is valid, not by the direction of its result. Whether A is better, B is better, they are equivalent within the margin, or the data cannot tell is the verdict below, and the verdict drives the decision the test catalog names for the row (ship B, do not ship B, keep A).

## Verdict

**No verdict.** This is an exploratory comparison: it estimates and decides nothing. The effects, intervals and p-values below describe these sessions; no ship decision follows from them.

### Primary metrics (Holm-adjusted over a family of 2)

| Metric | n A / n B | A median (p90) or share | B median (p90) or share | B minus A | Cliff's delta | Test, p | Holm-adjusted p | Practical threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Startup time | 30 / 30 | 1698 ms (p90 1744 ms) | 450 ms (p90 474 ms) | -1249 ms (95 % CI -1254 ms to -1238 ms) | -1.00 (large) | Mann-Whitney, < 0.001 | < 0.001 | 100 ms |
| Share of sessions with a rebuffer | 30 / 30 | 0 of 30 (0.0 %) | 0 of 30 (0.0 %) | 0 pp (95 % CI -11.4 pp to +11.4 pp) | n/a | Fisher's exact, 1.000 | 1.000 | 20 pp |

- Startup time: normal approximation with continuity and tie corrections; Hodges-Lehmann shift, seeded percentile bootstrap interval (5000 resamples).
- Share of sessions with a rebuffer: exact (hypergeometric, two-sided); difference of the shares, Newcombe's hybrid score interval.

### Distribution of each arm (quantiles, from p10 to p90)

Startup time:

| Arm | p10 | p20 | p30 | p40 | p50 | p60 | p70 | p80 | p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1665 ms | 1682 ms | 1696 ms | 1698 ms | 1698 ms | 1700 ms | 1712 ms | 1725 ms | 1744 ms |
| B | 446 ms | 448 ms | 448 ms | 449 ms | 450 ms | 451 ms | 456 ms | 461 ms | 474 ms |

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

No start rung was reached by at least 5 sessions of both arms: a rung-matched comparison is not possible with these data.

## What this experiment cannot say

- **One engine.** Only chromium 156.0.8078.4 was measured. Shaka's first rung depends on the engine (720p from the reported downlink in Chromium, 360p then 720p in Firefox and WebKit, ADR-064 in docs/decisions/player.md), so another engine would start from another place; nothing here says what it would do.
- **Localhost, synthetic content.** Test patterns (a three-rung VP9 ladder of 300, 700 and 1800 kbps with 2 s segments), software decoding, a test data service on the same machine (local-darwin-arm64, macOS 27.2, 12 CPUs), and a machine that was NOT quiet: the load average reached 29.6 on 12 CPUs, more than 50 % of them. These are laboratory numbers that compare configurations under identical conditions. They are not members' quality of experience and they do not transfer to another environment.
- **The condition tested.** Only `constrained-1500`: {"type":"throttle","kbps":1500}. A configuration can win under one network and lose under another; nothing here speaks for the others.
- **B is several settings together.** Configuration B differs from configuration A in 4 settings at once: `abr.useNetworkInformation` = false (Shaka's default: true); `abr.defaultBandwidthEstimate` = 500 kbps (Shaka's default: 1000 kbps); `abr.switchInterval` = 4 s (Shaka's default: 8 s); `streaming.bufferingGoal` = 20 s (Shaka's default: 10 s). The two configurations are compared as they are shipped, not setting by setting: no effect found here can be credited to one of these settings, and no arm of A plus one setting was run.
- **What the intervals mean.** They describe the sampling noise of these sessions on this machine. "Equivalent within the margin" says the whole interval lies inside the pre-registered margin, not that the true effect is zero, and it is the only verdict that says there is no meaningful difference; "inconclusive" says the data cannot rule out a difference that matters and do not show one: not finding a difference is not evidence that there is none.
- **When a stall starts in Chromium.** The rebuffer metric counts Shaka's `buffering` episodes. In Chromium the audio can keep the media clock running while the video buffer has a gap, so a stall is counted when the audio runs out, not when the picture freezes: a video-only underflow is not in the number (docs/decisions/e2e-rec.md). The audio is 64 kbps and always ahead, so both arms undercount alike, but a difference confined to video-only stalls cannot be seen.
- **The first rung is part of the difference.** The arms never started on the same rung (A: 720p: 30; B: 240p: 30). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. A rung-matched comparison is not possible with these data.

## Design and plan

|  |  |
| --- | --- |
| Experiment | exploratory-constrained-1500 (exploratory) |
| Engine, browser | chromium 156.0.8078.4 (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36`) |
| Stream | vod-cmaf over dash (content hash 66738540703f45d7ccfb51c91b8ccd40fe53bec59cb7bbef41fde9d03270ec06) |
| Arm A | configuration A: no overrides (Shaka's own defaults) |
| Arm B | configuration B: overrides `{"abr":{"useNetworkInformation":false,"defaultBandwidthEstimate":500000,"switchInterval":4},"streaming":{"bufferingGoal":20}}` (Shaka's defaults at those keys: `{"abr":{"useNetworkInformation":true,"defaultBandwidthEstimate":1000000,"switchInterval":8},"streaming":{"bufferingGoal":10}}`) |
| Conditions | `constrained-1500`: `{"type":"throttle","kbps":1500}` |
| Sessions | 30 per arm planned, 2 warm-up per arm recorded and left out; observation: first frame and 12 s of media after it, timeout 90000 ms |
| Interleaving | blocks of two (one session of each arm), the arm that goes first alternates from block to block (A B, B A, ...), a fresh browser context and a service session per session, one browser process per condition |
| Statistics | alpha 0.05; two-sided Mann-Whitney U (exact for small samples and for heavy ties, normal approximation with continuity and tie corrections otherwise); Hodges-Lehmann shift with a seeded percentile bootstrap interval (5000 resamples, seed 20261141); Cliff's delta; Fisher's exact test and Newcombe's interval for shares; Holm over the primary family |
| Pre-registration | `ab/prereg/exploratory-constrained-1500.json`, sha256 `ea6d9fb11b6a5a397845ab0fb830ea47c8a8036707375fbcfd1b8bec6282a91f`. The pre-registration file was committed unmodified in 5fc295a on 2026-11-04T11:58:57-06:00, before the run started (2026-11-04T20:06:27.152Z). |
| Environment | local-darwin-arm64: macOS 27.2 arm64, 12 CPUs, 16 GiB, Node v22.11.0, Playwright 1.64.1, ffmpeg 9.0.2 |
| Date and commit | started 2026-11-04T20:06:27.152Z, finished 2026-11-04T20:20:58.373Z; code at commit bd89cf2 |
| Load average (1 min) | constrained-1500: 4.5 before, 29.6 after |
| Command | `npm run ab -- --prereg ab/prereg/exploratory-constrained-1500.json --port 4720` |

### The plan, as pre-registered

- Hypothesis (startupMs): Exploratory, not confirmatory, and decides nothing. The link carries 1500 kbps on media requests, which is above the 360p rung with its audio (about 764 kbps) and below the 720p rung with its audio (about 1864 kbps). A and B start on different rungs, so the expectation is that the configuration that starts on the higher rung waits longer for its first frame; this is a guess about the two configurations as shipped, not about any one setting, and the run only estimates the size of the difference.
- Hypothesis (rebufferShare): Exploratory, not confirmatory, and decides nothing. On a link below the rate of the first rung of one of the two configurations, the sessions of that configuration may stall at the start; the run estimates the share of sessions that stall in each arm and the difference, and no ship decision follows from it.

| Metric | Role | Direction | Practical threshold | Why that number | Minimum detectable effect (pilot) |
| --- | --- | --- | --- | --- | --- |
| startupMs | primary | lower-is-better | 100 ms | A tenth of a second is the smallest change in the time to the first frame that a viewer notices on a page load. In an exploratory run the threshold only labels the table: it is not tied to a minimum detectable effect, because no A/A pilot was run for this condition (it decides nothing, so the harness does not ask for one). | n/a |
| rebufferShare | primary | lower-is-better | 20 pp | One session in five stalling more, or less, often is what a team would change a default for. In an exploratory run the threshold only labels the table: it is not tied to a minimum detectable effect, because no A/A pilot was run for this condition (it decides nothing, so the harness does not ask for one). | n/a |
| rebufferRatio | secondary | lower-is-better | n/a | n/a | n/a |

Decision rule `pb-ab-v1`: No decision. This is an exploratory run: it estimates the effects, intervals and p-values of two primary metrics (adjusted over their family with Holm's correction) and prints no verdict; nothing here is presented as confirmatory, and a result of this run is a hypothesis for a pre-registered experiment, not a finding.

Exclusion rule: A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison. The number of sessions is fixed in advance, 30 per arm after the warm-up: there is no interim analysis, no extension and no re-run to improve a result. (largest share of failed sessions per arm 10.0 %; the condition stops after 5 failures in a row).

## Files

- Raw results: `docs/results/ab/exploratory-constrained-1500.local-darwin-arm64.20261104T200627Z.raw.json` (every session, with its rung history and the configuration `qa.info()` reported).
- Reproduce this report from the raw results: `npm run ab -- --report docs/results/ab/exploratory-constrained-1500.local-darwin-arm64.20261104T200627Z.raw.json`.

