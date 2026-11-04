paired: the baseline was measured on this machine minutes ago from e0a5be30c3d6; the committed baselines of this environment were not used

## Performance gate: chromium in `gha-linux-x64`: REGRESSION

Baseline recorded 2026-11-04 at commit `e0a5be3` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

baseline machine: Intel(R) Xeon(R) 6973P-C; this machine: Intel(R) Xeon(R) 6973P-C

### PB-PERF-001 startup: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 58.95 ms / 62.99 ms | 200.6 ms / 201.7 ms | +240.3 % | median +30 %, p90 +30 %, and more than 5 ms | REGRESSION |
| manifestMs | 17.45 ms / 19.82 ms | 161.5 ms / 164 ms | +825.5 % | - | tracked |
| loadedMs | 27.1 ms / 30.44 ms | 169.1 ms / 171.4 ms | +524.0 % | - | tracked |

- `startupMs`: median 58.95 ms -> 200.6 ms (+240.3 %): worse by 141.6 ms, more than the 17.69 ms allowed; p90 62.99 ms -> 201.7 ms (+220.2 %): worse by 138.7 ms, more than the 18.9 ms allowed
  - fresh batch: median 58.95 ms -> 192.3 ms (+226.1 %): worse by 133.3 ms, more than the 17.69 ms allowed; p90 62.99 ms -> 198.2 ms (+214.7 %): worse by 135.2 ms, more than the 18.9 ms allowed

### PB-PERF-002 frame-rate: pass

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| fps | 30 fps / 30 fps | 30 fps / 30 fps | +0.0 % | median -5 %, p10 -10 %, and more than 1 fps | pass |
| droppedRatio | 0 / 0 | 0 / 0 | +0 | median +0.01, p90 +0.03 | pass |
| decodedFrames | 150 / 150.1 | 150 / 150 | +0.0 % | - | tracked |
| droppedFrames | 0 / 0 | 0 / 0 | +0 | - | tracked |


### PB-PERF-003 rebuffering: pass

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| rebufferCount | 0 / 0 | 0 / 0 | +0 | median +0, p90 +1 | pass |
| rebufferMs | 0 ms / 0 ms | 0 ms / 0 ms | +0 ms | median +250 ms, p90 +1000 ms | pass |
| rebufferRatio | 0 / 0 | 0 / 0 | +0 | median +0.01, p90 +0.05 | pass |
| switches | 1 / 1 | 1 / 1 | +0.0 % | - | tracked |
