## Performance gate: chromium in `local-darwin-arm64`: REGRESSION

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-003 rebuffering: regression (re-measured)

| metric | baseline median / tail | current median / tail | change | threshold | verdict |
| --- | --- | --- | --- | --- | --- |
| rebufferCount | 0 / 0 | 3 / 4 | +3 | median +0, p90 +1 | REGRESSION |
| rebufferMs | 0 ms / 0 ms | 7990 ms / 11180 ms | +7990 ms | median +250 ms, p90 +1000 ms | REGRESSION |
| rebufferRatio | 0 / 0 | 0.3061 / 0.3806 | +0.3061 | median +0.01, p90 +0.05 | REGRESSION |
| switches | 1 / 1 | 3 / 3 | +200.0 % | - | tracked |

- `rebufferCount`: median 0 -> 3: worse by 3, more than the 0 allowed; p90 0 -> 4: worse by 4, more than the 1 allowed
  - fresh batch: median 0 -> 3: worse by 3, more than the 0 allowed; p90 0 -> 3: worse by 3, more than the 1 allowed
- `rebufferMs`: median 0 ms -> 7990 ms: worse by 7990 ms, more than the 250 ms allowed; p90 0 ms -> 11180 ms: worse by 11180 ms, more than the 1000 ms allowed
  - fresh batch: median 0 ms -> 7988 ms: worse by 7988 ms, more than the 250 ms allowed; p90 0 ms -> 8131 ms: worse by 8131 ms, more than the 1000 ms allowed
- `rebufferRatio`: median 0 -> 0.3061: worse by 0.3061, more than the 0.01 allowed; p90 0 -> 0.3806: worse by 0.3806, more than the 0.05 allowed
  - fresh batch: median 0 -> 0.3059: worse by 0.3059, more than the 0.01 allowed; p90 0 -> 0.3094: worse by 0.3094, more than the 0.05 allowed

> Warning: FAULTS WERE INJECTED ON PURPOSE into every session ([{"type":"latency","ms":8000,"times":1,"match":{"kind":"segment","track":"video","number":4}}]): this is a sensitivity check of the gate, not a measurement of the build
