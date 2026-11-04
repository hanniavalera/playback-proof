## A/A check: chromium in `gha-linux-x64`

The gate was run **18 times** against its own baseline (recorded 2026-11-04 at commit `5a2cb3e`, browser 156.0.8078.4) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002, PB-PERF-003.

- **False positives (exit code 1): 0 of 18.**
- Exit codes: 0 x 18, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.
- CPU models: the passes did not record theirs (the baseline was recorded on: not recorded).

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-001 | startupMs | 75.4 ms / 83.13 ms | 9.7 % | 22.62 ms / 24.94 ms | -0.15 ms / -0.83 ms | 0 % / 0 % | 8.177 ms (10.8 %) |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0 fps / 0 fps | 0 % / 0 % | 0 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferCount | 0 / 0 | - | 0 / 1 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferMs | 0 ms / 0 ms | - | 250 ms / 1000 ms | 0 ms / 0 ms | 0 % / 0 % | 0 ms |
| PB-PERF-003 | rebufferRatio | 0 / 0 | - | 0.01 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames, PB-PERF-003 switches.

Every pass, in the order it was measured (startup is PB-PERF-001 startupMs: the median of the first batch of the pass against the median of the baseline):

| pass | verdict | CPU model | startup median vs baseline median | deviation |
| --- | --- | --- | --- | --- |
| 1 | pass | not recorded | 66.95 ms vs 75.4 ms | -11.2 % |
| 2 | pass | not recorded | 53.2 ms vs 75.4 ms | -29.4 % |
| 3 | pass | not recorded | 56.85 ms vs 75.4 ms | -24.6 % |
| 4 | pass | not recorded | 73.05 ms vs 75.4 ms | -3.1 % |
| 5 | pass | not recorded | 56.3 ms vs 75.4 ms | -25.3 % |
| 6 | pass | not recorded | 55.15 ms vs 75.4 ms | -26.9 % |
| 7 | pass | not recorded | 54.65 ms vs 75.4 ms | -27.5 % |
| 8 | pass | not recorded | 66.4 ms vs 75.4 ms | -11.9 % |
| 9 | pass | not recorded | 57 ms vs 75.4 ms | -24.4 % |
| 10 | pass | not recorded | 74.55 ms vs 75.4 ms | -1.1 % |
| 11 | pass | not recorded | 57.15 ms vs 75.4 ms | -24.2 % |
| 12 | pass | not recorded | 60.55 ms vs 75.4 ms | -19.7 % |
| 13 | pass | not recorded | 54.85 ms vs 75.4 ms | -27.3 % |
| 14 | pass | not recorded | 74.35 ms vs 75.4 ms | -1.4 % |
| 15 | pass | not recorded | 50.75 ms vs 75.4 ms | -32.7 % |
| 16 | pass | not recorded | 75.25 ms vs 75.4 ms | -0.2 % |
| 17 | pass | not recorded | 57.65 ms vs 75.4 ms | -23.5 % |
| 18 | pass | not recorded | 63.9 ms vs 75.4 ms | -15.3 % |
