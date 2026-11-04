## A/A check: chromium-cpu4x in `gha-linux-x64`

The gate was run **12 times** against its own baseline (recorded 2026-11-04 at commit `5a2cb3e`, browser 156.0.8078.4) on the same build, with nothing changed. Scenarios: PB-PERF-004.

- **False positives (exit code 1): 6 of 12.**
- Exit codes: 0 x 6, 1 x 6, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 6; of those 0 did not reproduce.
- CPU models: the passes did not record theirs (the baseline was recorded on: not recorded).

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-004 | startupMs | 172.3 ms / 198 ms | 10.0 % | 51.68 ms / 59.39 ms | 75.8 ms / 63.04 ms | 147 % / 106 % | 32.23 ms (18.7 %) |
| PB-PERF-004 | droppedRatio | 0 / 0 | - | 0.02 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-004 manifestMs, PB-PERF-004 loadedMs, PB-PERF-004 fps, PB-PERF-004 decodedFrames, PB-PERF-004 droppedFrames.

Every pass, in the order it was measured (startup is PB-PERF-004 startupMs: the median of the first batch of the pass against the median of the baseline):

| pass | verdict | CPU model | startup median vs baseline median | deviation |
| --- | --- | --- | --- | --- |
| 1 | pass | not recorded | 205.7 ms vs 172.3 ms | +19.4 % |
| 2 | REGRESSION (false positive) | not recorded | 248.1 ms vs 172.3 ms | +44.0 % |
| 3 | REGRESSION (false positive) | not recorded | 242.9 ms vs 172.3 ms | +41.0 % |
| 4 | pass | not recorded | 176.3 ms vs 172.3 ms | +2.4 % |
| 5 | pass | not recorded | 214.9 ms vs 172.3 ms | +24.8 % |
| 6 | pass | not recorded | 168.4 ms vs 172.3 ms | -2.2 % |
| 7 | pass | not recorded | 163.3 ms vs 172.3 ms | -5.2 % |
| 8 | pass | not recorded | 206.6 ms vs 172.3 ms | +19.9 % |
| 9 | REGRESSION (false positive) | not recorded | 244.3 ms vs 172.3 ms | +41.9 % |
| 10 | REGRESSION (false positive) | not recorded | 236.1 ms vs 172.3 ms | +37.1 % |
| 11 | REGRESSION (false positive) | not recorded | 243.8 ms vs 172.3 ms | +41.5 % |
| 12 | REGRESSION (false positive) | not recorded | 245.9 ms vs 172.3 ms | +42.7 % |
