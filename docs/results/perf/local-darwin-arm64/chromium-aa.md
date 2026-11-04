## A/A check: chromium in `local-darwin-arm64`

The gate was run **10 times** against its own baseline (recorded 2026-11-04 at commit `7389861`, browser 156.0.8078.4) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002, PB-PERF-003.

- **False positives (exit code 1): 0 of 10.**
- Exit codes: 0 x 10, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-001 | startupMs | 37.05 ms / 39.03 ms | 4.0 % | 11.11 ms / 11.71 ms | 2.3 ms / 1.8 ms | 21 % / 15 % | 1.199 ms (3.2 %) |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0 fps / 0 fps | 0 % / 0 % | 0 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferCount | 0 / 0 | - | 0 / 1 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferMs | 0 ms / 0 ms | - | 250 ms / 1000 ms | 0 ms / 0 ms | 0 % / 0 % | 0 ms |
| PB-PERF-003 | rebufferRatio | 0 / 0 | - | 0.01 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames, PB-PERF-003 switches.
