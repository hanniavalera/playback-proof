## Performance gate: chromium in `local-darwin-arm64`: REGRESSION

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-001 startup: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 37.05 ms / 39.03 ms | 54.65 ms / 57.11 ms | +47.5 % | median +30 %, p90 +30 %, and more than 5 ms | REGRESSION |
| manifestMs | 11.05 ms / 11.53 ms | 22.25 ms / 24.08 ms | +101.4 % | - | tracked |
| loadedMs | 15.65 ms / 16.04 ms | 31.35 ms / 32.74 ms | +100.3 % | - | tracked |

- `startupMs`: median 37.05 ms -> 54.65 ms (+47.5 %): worse by 17.6 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 57.11 ms (+46.3 %): worse by 18.08 ms, more than the 11.71 ms allowed
  - fresh batch: median 37.05 ms -> 56.3 ms (+52.0 %): worse by 19.25 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 57.81 ms (+48.1 %): worse by 18.78 ms, more than the 11.71 ms allowed

> Warning: THE CPU THROTTLE WAS REPLACED ON PURPOSE by 2x in every session: this is a sensitivity check of the gate, not a measurement of the build
