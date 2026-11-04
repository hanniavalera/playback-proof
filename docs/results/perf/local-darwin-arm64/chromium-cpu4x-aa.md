## A/A check: chromium-cpu4x in `local-darwin-arm64`

The gate was run **5 times** against its own baseline (recorded 2026-11-04 at commit `90df3a0`, browser 156.0.8078.4) on the same build, with nothing changed. Scenarios: PB-PERF-004.

- **False positives (exit code 1): 0 of 5.**
- Exit codes: 0 x 5, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-004 | startupMs | 111.5 ms / 114.7 ms | 6.4 % | 33.44 ms / 34.41 ms | -3.15 ms / 1.72 ms | 0 % / 5 % | 2.623 ms (2.4 %) |
| PB-PERF-004 | droppedRatio | 0 / 0 | - | 0.02 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-004 manifestMs, PB-PERF-004 loadedMs, PB-PERF-004 fps, PB-PERF-004 decodedFrames, PB-PERF-004 droppedFrames.
