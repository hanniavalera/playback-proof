## Performance gate: chromium-cpu4x in `local-darwin-arm64`: REGRESSION

Baseline recorded 2026-11-04 at commit `90df3a0` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-004 low-end: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 111.5 ms / 114.7 ms | 250.5 ms / 261.2 ms | +124.8 % | median +30 %, p90 +30 %, and more than 20 ms | REGRESSION |
| manifestMs | 47.3 ms / 49.75 ms | 117.3 ms / 119.4 ms | +147.9 % | - | tracked |
| loadedMs | 67.9 ms / 70.94 ms | 164.8 ms / 174.6 ms | +142.6 % | - | tracked |
| droppedRatio | 0 / 0 | 0 / 0 | +0 | median +0.02, p90 +0.05 | pass |
| fps | 30 fps / 30 fps | 30 fps / 30 fps | +0.0 % | - | tracked |
| decodedFrames | 150 / 150 | 150 / 150 | +0.0 % | - | tracked |
| droppedFrames | 0 / 0 | 0 / 0 | +0 | - | tracked |

- `startupMs`: median 111.5 ms -> 250.5 ms (+124.8 %): worse by 139 ms, more than the 33.44 ms allowed; p90 114.7 ms -> 261.2 ms (+127.7 %): worse by 146.5 ms, more than the 34.41 ms allowed
  - fresh batch: median 111.5 ms -> 227.9 ms (+104.5 %): worse by 116.4 ms, more than the 33.44 ms allowed; p90 114.7 ms -> 267.4 ms (+133.1 %): worse by 152.7 ms, more than the 34.41 ms allowed

> Warning: THE CPU THROTTLE WAS REPLACED ON PURPOSE by 8x in every session: this is a sensitivity check of the gate, not a measurement of the build
