## Performance gate: chromium in `local-darwin-arm64`: REGRESSION

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-001 startup: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 37.05 ms / 39.03 ms | 52.35 ms / 54.52 ms | +41.3 % | median +30 %, p90 +30 %, and more than 5 ms | REGRESSION |
| manifestMs | 11.05 ms / 11.53 ms | 16.5 ms / 16.7 ms | +49.3 % | - | tracked |
| loadedMs | 15.65 ms / 16.04 ms | 20.85 ms / 20.93 ms | +33.2 % | - | tracked |

- `startupMs`: median 37.05 ms -> 52.35 ms (+41.3 %): worse by 15.3 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 54.52 ms (+39.7 %): worse by 15.49 ms, more than the 11.71 ms allowed
  - fresh batch: p90 39.03 ms -> 55.07 ms (+41.1 %): worse by 16.04 ms, more than the 11.71 ms allowed

> Warning: FAULTS WERE INJECTED ON PURPOSE into every session ([{"type":"latency","ms":8,"match":{"kind":"manifest"}},{"type":"latency","ms":8,"match":{"kind":"init"}}]): this is a sensitivity check of the gate, not a measurement of the build
