## Performance gate: chromium in `local-darwin-arm64`: REGRESSION

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-001 startup: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 37.05 ms / 39.03 ms | 337.9 ms / 338.5 ms | +812.0 % | median +30 %, p90 +30 %, and more than 5 ms | REGRESSION |
| manifestMs | 11.05 ms / 11.53 ms | 158.9 ms / 159.1 ms | +1338.0 % | - | tracked |
| loadedMs | 15.65 ms / 16.04 ms | 163.2 ms / 163.6 ms | +942.8 % | - | tracked |

- `startupMs`: median 37.05 ms -> 337.9 ms (+812.0 %): worse by 300.9 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 338.5 ms (+767.4 %): worse by 299.5 ms, more than the 11.71 ms allowed
  - fresh batch: median 37.05 ms -> 337 ms (+809.7 %): worse by 300 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 340.4 ms (+772.1 %): worse by 301.4 ms, more than the 11.71 ms allowed

> Warning: FAULTS WERE INJECTED ON PURPOSE into every session ([{"type":"latency","ms":150,"match":{"kind":"manifest"}},{"type":"latency","ms":150,"match":{"kind":"init"}}]): this is a sensitivity check of the gate, not a measurement of the build
