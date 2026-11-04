## A/A check: webkit in `local-darwin-arm64`

The gate was run **5 times** against its own baseline (recorded 2026-11-04 at commit `e8d31c4`, browser 27.2) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002.

- **False positives (exit code 1): 0 of 5.**
- Exit codes: 0 x 5, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-001 | startupMs | 80.5 ms / 87.1 ms | 6.8 % | 24.15 ms / 26.13 ms | -0.5 ms / -0.7 ms | 0 % / 0 % | 1.458 ms (1.8 %) |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0 fps / 0 fps | 0 % / 0 % | 0 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames.
