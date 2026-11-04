## Sensitivity check of the gate: regressions injected on purpose

Local Chromium on `local-darwin-arm64` (macOS 27.2, Apple silicon, 12 CPUs, 16 GiB; Chromium 156.0.8078.4; Playwright 1.64.1), 2026-11-04, the gate of commit `a28a6fe` against the baselines recorded at `7389861` (Chromium) and `90df3a0` (throttled), 10 runs a batch unless noted. Every row is one `npm run perf:gate -- --profile <p> --scenario <s> <injection>`; the host's 1-minute load average was at or below 3 when each series started (`perf/quiet.ts --max-load 3`).

Baseline: PB-PERF-001 `startupMs` median 37.05 ms, p90 39.03 ms; the gate allows +11.11 ms on the median and +11.71 ms on the p90 (30 % and 5 ms floor). PB-PERF-004 (throttled, 4x) 111.5 ms / 114.7 ms, +33.4 ms / +34.4 ms allowed. The injected latency is added to **every** manifest request and **every** init-segment request of the session (two requests on the path to the first frame).

"First batch" is the median of the first measurement and its verdict; "fresh batch" the median of the second one (a new browser, new runs), measured only when the first batch failed; "final" is how the two are settled: `regression` (it failed twice: exit code 1), `not-reproduced` (the first measurement is discarded: exit code 0) or `pass`. A first batch can fail on the p90 while its median passes (a few runs jump).

| run | injected | metric | exit | first batch: baseline to current median (change), verdict | fresh batch | final |
| --- | --- | --- | --- | --- | --- | --- |
| latency-2 | +2 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 36.85 (-0.2 ms), pass | - | pass |
| latency-5 | +5 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 37.05 (+0 ms), pass | - | pass |
| fine-6-r1 | +6 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 38.55 (+1.5 ms), pass | - | pass |
| fine-6-r2 | +6 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 39.45 (+2.4 ms), pass | - | pass |
| fine-6-r3 | +6 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 38.95 (+1.9 ms), pass | - | pass |
| fine-7-r1 | +7 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 39.05 (+2 ms), fail | 38.25 (+1.2 ms), fail | regression |
| fine-7-r2 | +7 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 40.55 (+3.5 ms), fail | 38.55 (+1.5 ms), pass | not-reproduced |
| fine-7-r3 | +7 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 38.7 (+1.65 ms), fail | 37.85 (+0.8 ms), pass | not-reproduced |
| fine-8-r1 | +8 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 52.35 (+15.3 ms), fail | 46.2 (+9.15 ms), fail | regression |
| fine-8-r2 | +8 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 38.55 (+1.5 ms), pass | - | pass |
| fine-8-r3 | +8 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 39.2 (+2.15 ms), fail | 39.55 (+2.5 ms), fail | regression |
| fine-9-r1 | +9 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 53 (+15.95 ms), fail | 54.25 (+17.2 ms), fail | regression |
| fine-9-r2 | +9 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 54.45 (+17.4 ms), fail | 54.7 (+17.65 ms), fail | regression |
| fine-9-r3 | +9 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 53.1 (+16.05 ms), fail | 54.45 (+17.4 ms), fail | regression |
| fine-10-r1 | +10 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 54.95 (+17.9 ms), fail | 54.35 (+17.3 ms), fail | regression |
| fine-10-r2 | +10 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 54.55 (+17.5 ms), fail | 53.55 (+16.5 ms), fail | regression |
| fine-10-r3 | +10 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 51.3 (+14.25 ms), fail | 54.45 (+17.4 ms), fail | regression |
| latency-10 | +10 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 52.45 (+15.4 ms), fail | 54.9 (+17.85 ms), fail | regression |
| latency-20 | +20 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 71.8 (+34.75 ms), fail | 70.65 (+33.6 ms), fail | regression |
| latency-40 | +40 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 111.9 (+74.85 ms), fail | 105.5 (+68.45 ms), fail | regression |
| latency-80 | +80 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 188.5 (+151.4 ms), fail | 187.7 (+150.6 ms), fail | regression |
| latency-150 | +150 ms on manifest and init | chromium PB-PERF-001 startupMs | 1 | 37.05 to 337.9 (+300.9 ms), fail | 337 (+300 ms), fail | regression |
| outlier-first-r1 | first batch only: +150 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 337.9 (+300.9 ms), fail | 36.8 (-0.25 ms), pass | not-reproduced |
| outlier-first-r2 | first batch only: +150 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 337.8 (+300.8 ms), fail | 39.15 (+2.1 ms), pass | not-reproduced |
| outlier-first-r3 | first batch only: +150 ms on manifest and init | chromium PB-PERF-001 startupMs | 0 | 37.05 to 338.5 (+301.5 ms), fail | 38.3 (+1.25 ms), pass | not-reproduced |
| cpu-1.25 | CPU throttle 1.25x | chromium PB-PERF-001 startupMs | 0 | 37.05 to 42.15 (+5.1 ms), pass | - | pass |
| cpu-1.5 | CPU throttle 1.5x | chromium PB-PERF-001 startupMs | 0 | 37.05 to 46.9 (+9.85 ms), pass | - | pass |
| cpu-2 | CPU throttle 2x | chromium PB-PERF-001 startupMs | 1 | 37.05 to 54.65 (+17.6 ms), fail | 56.3 (+19.25 ms), fail | regression |
| cpu-3 | CPU throttle 3x | chromium PB-PERF-001 startupMs | 1 | 37.05 to 78.85 (+41.8 ms), fail | 75.75 (+38.7 ms), fail | regression |
| cpu-4 | CPU throttle 4x | chromium PB-PERF-001 startupMs | 1 | 37.05 to 102.7 (+65.65 ms), fail | 103.4 (+66.35 ms), fail | regression |
| lowend-8x | CPU throttle 8x (instead of 4x) | chromium-cpu4x PB-PERF-004 startupMs | 1 | 111.5 to 250.5 (+139 ms), fail | 227.9 (+116.4 ms), fail | regression |
| frame-20x | CPU throttle 20x | chromium PB-PERF-002 | 2 | no batch was measured (the run failed: a second load interrupted the page's own, see ADR-127) | - | problem |
| late-segment | `{"type":"latency","ms":8000,"times":1,"match":{"kind":"segment","track":"video","number":4}}`, 5 runs a batch | chromium PB-PERF-003 rebufferCount | 1 | 0 to 3 (+3), fail | 3 (+3), fail | regression |
| late-segment | (same) | chromium PB-PERF-003 rebufferMs | 1 | 0 to 7990 (+7990 ms), fail | 7988 (+7988 ms), fail | regression |
| late-segment | (same) | chromium PB-PERF-003 rebufferRatio | 1 | 0 to 0.3061 (+0.3061), fail | 0.3059 (+0.3059), fail | regression |

Reports of the runs that show a behaviour (the full gate report with every run of both batches, and the Markdown a person reads): [latency-150](latency-150.md) ([json](latency-150.json)), [fine-8-r1](fine-8-r1.md) (a regression right at the edge), [outlier-first-r1](outlier-first-r1.md) (not reproduced: the first measurement is discarded), [cpu-2](cpu-2.md), [lowend-8x](lowend-8x.md), [late-segment](late-segment.md), [frame-20x](frame-20x.md) (the problem). The other reports are in `reports/sens` of the machine that took them (not committed).

What the table does not show: the frame-rate and dropped-frame metrics did not respond to any injection that could be run (an 8x throttle dropped no frame at 720p), so those two gates were never seen to fire.
