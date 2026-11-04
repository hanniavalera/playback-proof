# Performance baselines and the regression gate

This lab records **startup time, rebuffering and frame rate** of its player on every build, against a **baseline committed for each environment and browser**, and **fails the merge when a regression reproduces**. A second profile runs Chromium with a **4x CPU throttle** (`Emulation.setCPUThrottlingRate` through a DevTools session before the page navigates) as a stand-in for a weak device.

The decisions behind it are [ADR-120 to ADR-129](decisions/perf.md); the metric definitions are in [METRICS.md](METRICS.md); the policy numbers are `PERF_POLICY` in [`src/shared/criteria.ts`](../src/shared/criteria.ts), rendered in [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 7.1.

> **What these numbers are.** Laboratory measurements of one player page on one laptop (and its Docker VM), against localhost, with software-decoded synthetic content, taken on 2026-11-04 with the host's load average at or below 3. They compare builds under identical conditions; they are not production quality of experience and not comparable between environments. See "What the numbers do not mean" below.

## How it works, in one page

- **Scenarios** (catalog rows PB-PERF-001 to PB-PERF-004, stream `vod-cmaf`, DASH): startup under a clean network; frame rate and dropped frames over a five-second window at a rung pinned to 720p; rebuffering under `bandwidth-drop`; startup and dropped frames of the throttled profile.
- **A batch** is one scenario on one profile: one browser process, a **warm-up run that is recorded and discarded**, then **N = 10 runs, each in a fresh context** with a session of its own on the test data service (a child process of the harness). The summary of a metric is the **median and the p90** (Hyndman-Fan type 7; the p10 where lower is worse), with the range, the MAD and the CV.
- **A baseline** is `perf/baselines/<envId>/<profile>.json`: every run, every summary, the content hash of every stream, the host and browser versions, and how it was measured (the CPU limit of the container, the load average, what the quiet-machine wait found). The loader checks that every summary follows from the raw values beside it and refuses a baseline of another environment.
- **The gate** measures a batch and compares it with the baseline of this environment. A metric fails when its median or its tail is worse by more than **its share of the baseline value and an absolute floor** (or, for counts and ratios whose baseline is zero, by more than an **absolute budget**). A scenario that fails is **measured again in a fresh browser with fresh runs, and judged alone**: the build fails only if the same metric fails again. A metric whose baseline is noisier than the stability limit (CV above 15 %) is **tracked and reported, not gated**.
- **Exit codes:** `0` pass (a failure that did not reproduce passes, and the report says the first measurement was discarded); `1` a regression that reproduced; `2` the measurement could not be trusted (no baseline here, a changed stream, a different start rung, a run that failed): an environment problem is never reported as a regression.

## Run it

```bash
# Measure and print (no baseline needed):
npm run perf -- --profile chromium --scenario PB-PERF-001

# Record the baseline of this environment (a quiet machine; the wrapper waits for the host load to be at or below 3):
npx tsx perf/quiet.ts --max-load 3 -- npm run perf:baseline -- --profile chromium

# The gate (what CI runs): exit 0, 1 or 2; writes reports/perf/<envId>/<profile>.json and .md:
npm run perf:gate -- --profile chromium,chromium-cpu4x

# Firefox, and the Linux environment, through the Playwright container (4 CPUs, as the baselines were recorded):
npm run docker:pw -- --cpus 4 npm run perf:gate -- --profile firefox

# The checks of the gate itself (below):
npx tsx perf/derive.ts                      # thresholds from the baselines on disk
npx tsx perf/aa.ts reports/aa/*/…/chromium.json   # summarize gate runs against their own baseline
npm run perf:gate -- --profile chromium --scenario PB-PERF-001 \
  --inject-faults '[{"type":"latency","ms":150,"match":{"kind":"manifest"}},{"type":"latency","ms":150,"match":{"kind":"init"}}]'
```

`--inject-faults`, `--inject-cpu-throttle <rate>` and `--inject-on first` put a regression in on purpose (never into a baseline; the report says so). `npm run perf -- --help` lists every option.

## The baselines

Ten runs after the warm-up, `vod-cmaf`, 2026-11-04. Startup is `load()` to the first presented frame (METRICS.md). "Gates" says whether the startup metric is enforced (baseline CV at most 15 %). Raw values: [`perf/baselines`](../perf/baselines); variation of every metric: [results/perf/threshold-derivation.md](results/perf/threshold-derivation.md).

| Environment | Profile | Browser | Start rung | Startup median | p90 | CV | Gates |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local-darwin-arm64 | chromium | 156.0.8078.4 | 720p | 37.05 ms | 39.03 ms | 4.0 % | yes |
| local-darwin-arm64 | webkit | 27.2 | 360p | 80.5 ms | 87.1 ms | 6.8 % | yes |
| local-darwin-arm64 | chromium-cpu4x | 156.0.8078.4 | 720p | 111.5 ms | 114.7 ms | 6.4 % | yes |
| docker-linux-arm64 (4 CPUs) | chromium | 156.0.8078.4 | 720p | 39.65 ms | 44.58 ms | 13.3 % | yes |
| docker-linux-arm64 (4 CPUs) | firefox | 157.0 | 360p | 54 ms | 61.2 ms | 15.3 % | **no: tracked** |
| docker-linux-arm64 (4 CPUs) | webkit | 27.2 | 360p | 156.5 ms | 283.8 ms | 56.7 % | **no: tracked** |

- **Frame rate** was 30 fps and **dropped frames** were 0 in every one of the 50 runs of PB-PERF-002 (and in the 10 of the throttled profile): nothing varied, so there was nothing to derive those thresholds from.
- **Rebuffering** under `bandwidth-drop` was 0 in all 50 runs on the five profiles that run PB-PERF-003 (the player switches rung once on Chromium and twice on the other engines).
- **The warm-up is not decoration:** the discarded first run took 1.3 to 4.6 times the median of the ten measured runs on every profile (169 ms against 37 ms on local Chromium).
- **Two startup baselines do not gate.** Firefox in the container has a CV of 15.3 %, just above the limit. WebKit in the container has one: its first two measured runs after the warm-up were 516 and 258 ms against 146 to 183 ms for the other eight (the warm-up of that engine on Linux lasts longer than one run), so its CV and p90 are the start of the process, not the player. Both are reported on every build and enforced by nothing.
- **Time:** the runs of one profile take 282 s (Chromium: 0.15 s, 7.3 s and 18.2 s per run for PB-PERF-001 to PB-PERF-003) and 83 s (the throttled profile: 7.5 s per run); the job "chromium and chromium-cpu4x" is about 6 to 7 minutes on this machine (a CI runner is not measured here).

## The thresholds

| Rule | Median | Tail | Floor | Basis |
| --- | --- | --- | --- | --- |
| Startup (PB-PERF-001) | +30 % | p90 +30 % | 5 ms | **measured**: 1.25 x the noise of the noisiest gating profile (Chromium in the container: 23 % of the median) rounded up; floor 1.25 x the noise of the quietest (3.6 ms) |
| Low-end startup (PB-PERF-004) | +30 % | p90 +30 % | 20 ms | shares as startup (one stability limit for both); floor measured. The one throttled baseline needs 15 %: a per-rule limit would allow that |
| Frame rate (PB-PERF-002) | -5 % | p10 -10 % | 1 fps | assumption: the rate never varied in a baseline run |
| Dropped frames (PB-PERF-002 and 004) | +0.01 (low-end +0.02) | p90 +0.03 (+0.05) | | assumption: zero in every baseline run |
| Rebuffering (PB-PERF-003) | count +0, 250 ms, ratio +0.01 | count +1, 1 s, ratio +0.05 | | assumption: zero in every baseline run |
| Stability limit | baseline CV at most 15 % | | | **measured**: the CV of the noisiest pair that gates (13.3 %), rounded up to 5 % |

How a threshold was derived ([`derive.ts`](../src/lab/measure/derive.ts), [ADR-123](decisions/perf.md)): between a baseline and a later batch of the same code the median differs by noise alone, with a standard deviation of `sqrt(2) x SE`; the threshold covers three of them (and 1.25 times that, because a spread estimated from ten runs is itself uncertain by a quarter). `SE` is the larger of a parametric estimate and a bootstrap of the baseline's own ten runs. The margins of the committed policy above that noise are in the last table of [threshold-derivation.md](results/perf/threshold-derivation.md): 4.7 times on local Chromium, 2.1 times on local WebKit, 1.3 times on Chromium in the container (the noisiest pair), 2.9 times under the throttle.

## Checks of the gate itself

**A/A: the gate against its own baseline.** Nothing changed, so every alarm is false. Local Chromium was run 10 times (passes 1 to 5 with all three scenarios, 6 to 10 with PB-PERF-001 and 002), the other profiles 5 times with PB-PERF-001 and 002 (the throttled profile with PB-PERF-004); summaries in [results/perf](results/perf) (`<envId>/<profile>-aa.md`).

| Profile | Passes | Scenarios per pass | Exit codes | False positives | First-batch alarms | Worst pass, startup: share of the allowance (median / p90) |
| --- | --- | --- | --- | --- | --- | --- |
| local chromium | 10 | PB-PERF-001 and 002; 003 in the first 5 | 0 x 10 | **0** | 0 | 21 % / 15 % (+2.3 ms of 11.1 ms; +1.8 ms of 11.7 ms) |
| local webkit | 5 | 001, 002 | 0 x 5 | **0** | 0 | 0 % (never slower than the baseline; -0.5 ms) |
| local chromium-cpu4x | 5 | 004 | 0 x 5 | **0** | 0 | 0 % / 5 % (-3.2 ms; +1.7 ms of 34.4 ms) |
| docker chromium | 5 | 001, 002 | 0 x 5 | **0** | 0 | 45 % / 15 % (+5.4 ms of 11.9 ms) |
| docker firefox | 5 | 001, 002 | 0 x 2, **2 x 3** | **0** | 0 | startup tracked; see below |
| docker webkit | 5 | 001, 002 | 0 x 5 | **0** | 0 | startup tracked |

Frame rate, dropped frames and (local Chromium, five passes) rebuffering did not move from the baseline in any pass: 30 fps, no dropped frame, no rebuffer.

**What the A/A check found.** Three of the five Firefox passes ended with **exit code 2**, not a false positive: PB-PERF-002 failed a run because the scenario asked for a second load of a manifest that the page was already loading (`LOAD_INTERRUPTED`, then no first frame; about one run in twelve on Firefox in the container, never seen in the 11 runs of its baseline). That is a race in the scenario, which the check exposed; the scenario now waits for the page's own load (ADR-127). After the fix, five more Firefox passes (55 runs of PB-PERF-002) ended with exit code 0, and two more local Chromium passes did too ([results/perf/after-fix](results/perf/after-fix)): 0 harness problems where 3 of 5 had stood before (the chance of that by luck, at the earlier rate of 3 failed runs in 37, is about one in a hundred).

The between-batch spread of the median in the A/A is at or below what the derivation predicted from one baseline batch on five of the six profiles (the standard deviation of the batch medians against the estimated standard error of one batch: 2.6 against 2.6 ms for the throttled profile, 2.2 against 1.9 to 2.2 ms for Chromium in the container, 1.5 against 2.1 to 2.7 ms for local WebKit) and **about twice as large on local Chromium** (1.2 against 0.56 ms: the median of a 37 ms startup drifted between 35.9 and 39.3 ms over the hour). Its allowance (11.1 ms) is still nine times that spread.

**Sensitivity: a regression injected on purpose** (local Chromium; [results/perf/sensitivity/summary.md](results/perf/sensitivity/summary.md); baseline startup 37.05 ms, allowed +11.1 ms on the median and +11.7 ms on the p90):

| Injected (on purpose) | What the gate saw | Verdict |
| --- | --- | --- |
| +2 ms and +5 ms of latency on every manifest and init request | median startup -0.2 and +0.0 ms | pass: nothing to detect |
| +6 ms | +1.5, +2.4 and +1.9 ms in three runs of the gate | pass 3 of 3 |
| +7 ms | a few runs jump by about 15 ms (a step, not a slope); the p90 sees them: the first batch failed 3 of 3 times | reproduced 1 of 3 (exit 1); not reproduced 2 of 3 (exit 0) |
| +8 ms | first batch failed 2 of 3 | reproduced 2 of 3 |
| +9 and +10 ms | +14 to +18 ms (+39 % to +48 %) in both batches | **reproduced 7 of 7** (exit 1) |
| +20, +40, +80, +150 ms | +34.8, +74.9, +151.4 and +300.9 ms (+812 %) | reproduced, exit 1: "median 37.05 ms -> 337.9 ms (+812.0 %): worse by 300.9 ms, more than the 11.11 ms allowed" |
| CPU throttle 1.25x and 1.5x on the page (PB-PERF-001) | +13.8 % and +26.6 % | pass (under the 30 % share) |
| CPU throttle 2x, 3x and 4x | +47.5 %, +113 % and +177 % | reproduced, exit 1 |
| +150 ms on manifest and init in the **first batch only** (a one-off outlier) | first batch 337.9 ms, fresh batch 36.8 ms | **not reproduced**: "the first measurement is discarded and the build passes" (exit 0, 3 of 3 times) |
| Low-end profile (PB-PERF-004) under an 8x throttle instead of 4x | 111.5 ms to 250.5 ms (+125 %); dropped ratio stays 0 | reproduced (fresh batch 227.9 ms), exit 1 |
| Rebuffering (PB-PERF-003, 5 runs a batch): video segment 4 held back for 8 s | 0 to 3 rebuffers (p90 4), 7,990 ms stalled, ratio 0.31 | reproduced on all three rebuffering metrics, exit 1 |
| Frame rate (PB-PERF-002) under a 20x throttle | the run failed: the double load of the scenario (fixed after this check) | exit 2: a problem, not a regression |

What this says about the sensitivity: a shift of the median by about 15 ms (+40 % of a 37 ms startup) is caught every time, in both batches; a shift of 1 to 3 ms is invisible to the gate, which allows 11 ms (three to five times the noise of that profile); and where only some of the runs jump (at +7 and +8 ms per request) the p90 notices them in the first batch and the fresh batch confirms it about half of the time: a regression right at the edge of the thresholds fails some builds and not others, which is what a gate that must reproduce costs (ADR-125). The numbers come from 33 gate runs; the table of every one is in [results/perf/sensitivity/summary.md](results/perf/sensitivity/summary.md).

## What the numbers do not mean

- One laptop and its VM, localhost, software decode, synthetic content, a fresh context in a warm browser: **not production quality of experience**, not comparable between environments, not a statement about any device. The 4x throttle slows the main thread of Chromium and nothing else (not the decoder, not the network): it is a stand-in for a weak device, not a device, and Firefox and WebKit have no such stand-in.
- **0 false positives in 10 passes is a sanity check, not a proof**: with zero events in ten tries the 95 % upper bound of the false-positive rate per pass is 26 %. What carries weight is the margin: the worst pass of every gated metric used a fraction of its allowance (the A/A tables).
- The thresholds were derived on these machines. **A CI runner is another environment with its own baseline**; its first A/A run is the evidence that the thresholds fit it, and the stability limit makes a noisy runner track instead of block.
- The gate catches a **change relative to the committed baseline** that exceeds the measured noise and reproduces. It does not say the baseline is good, and a slow drift below the thresholds passes every time (the baseline changes only when someone records it again).
- The frame-rate and dropped-frame gates were **not exercised by an injected regression**: even an 8x CPU throttle did not drop a frame at 720p on this machine, and the frame-rate scenario under a 20x throttle exposed a race of the harness (below), not a regression.
