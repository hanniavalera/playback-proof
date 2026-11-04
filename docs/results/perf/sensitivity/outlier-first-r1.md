## Performance gate: chromium in `local-darwin-arm64`: PASS

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-001 startup: pass (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| startupMs | 37.05 ms / 39.03 ms | 337.9 ms / 342.8 ms | +812.1 % | median +30 %, p90 +30 %, and more than 5 ms | not reproduced |
| manifestMs | 11.05 ms / 11.53 ms | 160.9 ms / 161.5 ms | +1356.1 % | - | tracked |
| loadedMs | 15.65 ms / 16.04 ms | 167.1 ms / 168.3 ms | +967.4 % | - | tracked |

- `startupMs`: median 37.05 ms -> 337.9 ms (+812.1 %): worse by 300.9 ms, more than the 11.11 ms allowed; p90 39.03 ms -> 342.8 ms (+778.4 %): worse by 303.8 ms, more than the 11.71 ms allowed
  - fresh batch passed, within the limits (median +30 %, p90 +30 %, and more than 5 ms): not reproduced, so the first measurement is discarded and the build passes

> Warning: FAULTS WERE INJECTED ON PURPOSE into the FIRST batch of each scenario only (the fresh batch is clean) ([{"type":"latency","ms":150,"match":{"kind":"manifest"}},{"type":"latency","ms":150,"match":{"kind":"init"}}]): this is a sensitivity check of the gate, not a measurement of the build
