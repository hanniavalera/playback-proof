paired: the baseline was measured on this machine minutes ago from e0a5be30c3d6; the committed baselines of this environment were not used

## Performance gate: chromium-cpu4x in `gha-linux-x64`: REGRESSION

Baseline recorded 2026-11-04 at commit `e0a5be3` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

baseline machine: AMD EPYC 7763 64-Core Processor; this machine: AMD EPYC 7763 64-Core Processor

### PB-PERF-004 low-end: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 266.7 ms / 278.6 ms | 354.9 ms / 368.3 ms | +33.1 % | median +30 %, p90 +30 %, and more than 20 ms | REGRESSION |
| manifestMs | 114.2 ms / 119 ms | 210.3 ms / 226 ms | +84.1 % | - | tracked |
| loadedMs | 164.5 ms / 171.9 ms | 251.9 ms / 268.9 ms | +53.1 % | - | tracked |
| droppedRatio | 0 / 0 | 0 / 0 | +0 | median +0.02, p90 +0.05 | pass |
| fps | 30 fps / 30 fps | 30 fps / 30 fps | +0.0 % | - | tracked |
| decodedFrames | 150 / 150 | 150 / 150 | +0.0 % | - | tracked |
| droppedFrames | 0 / 0 | 0 / 0 | +0 | - | tracked |

- `startupMs`: median 266.7 ms -> 354.9 ms (+33.1 %): worse by 88.2 ms, more than the 80 ms allowed; p90 278.6 ms -> 368.3 ms (+32.2 %): worse by 89.71 ms, more than the 83.57 ms allowed
  - fresh batch: median 266.7 ms -> 347.3 ms (+30.2 %): worse by 80.65 ms, more than the 80 ms allowed
