## A/A check: firefox in `gha-linux-x64`

The gate was run **9 times** against its own baseline (recorded 2026-11-04 at commit `5a2cb3e`, browser 157.0) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002, PB-PERF-003.

- **False positives (exit code 1): 2 of 9.**
- Exit codes: 0 x 7, 1 x 2, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 2; of those 0 did not reproduce.
- CPU models: the passes did not record theirs (the baseline was recorded on: not recorded).

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-001 | startupMs | 86.5 ms / 96.1 ms | 14.1 % | 25.95 ms / 28.83 ms | 23.5 ms / 44.1 ms | 91 % / 153 % | 17.31 ms (20.0 %) |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0.000003974 fps / 0 fps | 0 % / 0 % | 0.000001325 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferCount | 0 / 0 | - | 0 / 1 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferMs | 0 ms / 0 ms | - | 250 ms / 1000 ms | 0 ms / 0 ms | 0 % / 0 % | 0 ms |
| PB-PERF-003 | rebufferRatio | 0 / 0 | - | 0.01 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames, PB-PERF-003 switches.

Every pass, in the order it was measured (startup is PB-PERF-001 startupMs: the median of the first batch of the pass against the median of the baseline):

| pass | verdict | CPU model | startup median vs baseline median | deviation |
| --- | --- | --- | --- | --- |
| 1 | REGRESSION (false positive) | not recorded | 105 ms vs 86.5 ms | +21.4 % |
| 2 | pass | not recorded | 94.5 ms vs 86.5 ms | +9.2 % |
| 3 | pass | not recorded | 68 ms vs 86.5 ms | -21.4 % |
| 4 | pass | not recorded | 96.5 ms vs 86.5 ms | +11.6 % |
| 5 | REGRESSION (false positive) | not recorded | 105.5 ms vs 86.5 ms | +22.0 % |
| 6 | pass | not recorded | 69.5 ms vs 86.5 ms | -19.7 % |
| 7 | pass | not recorded | 96 ms vs 86.5 ms | +11.0 % |
| 8 | pass | not recorded | 110 ms vs 86.5 ms | +27.2 % |
| 9 | pass | not recorded | 67 ms vs 86.5 ms | -22.5 % |
