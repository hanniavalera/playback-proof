## Threshold derivation

Derived from 6 baselines (N runs per metric, the warm-up excluded). Noise = 3 x sqrt(2) x SE, where SE is the larger of a parametric and a bootstrap (4000 resamples, seed 20260717) estimate of the standard error of the batch median or tail: how far two independent batches of the same code may be apart. The policy numbers cover 1.25 x that noise for every gated pair, rounded up (5 % for shares, a round number for floors). A metric gates only while its baseline CV is at most 15.0 %.

### Baselines

| environment | profile | recorded | commit |
| --- | --- | --- | --- |
| docker-linux-arm64 | chromium | 2026-11-04 06:49 | `0dfbed1` |
| docker-linux-arm64 | firefox | 2026-11-04 06:54 | `58da1b2` |
| docker-linux-arm64 | webkit | 2026-11-04 07:01 | `8661aed` |
| local-darwin-arm64 | chromium-cpu4x | 2026-11-04 06:44 | `90df3a0` |
| local-darwin-arm64 | chromium | 2026-11-04 06:36 | `7389861` |
| local-darwin-arm64 | webkit | 2026-11-04 06:42 | `e8d31c4` |

### Relative metrics: variation of the baseline runs

| environment | profile | metric | n | median | tail | min..max | CV | robust CV | warm-up (x median) | SE median (param / boot) | noise median | noise tail | gated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docker-linux-arm64 | chromium | PB-PERF-001 startupMs | 10 | 39.7 ms | p90 44.6 | 30.9..45.3 | 13.3 % | 16.1 % | 78.9 (2x) | 1.94 / 2.17 | 9.2 ms (23.2 %) | 10.1 ms (22.6 %) | yes |
| docker-linux-arm64 | chromium | PB-PERF-002 fps | 10 | 30 fps | p10 30 | 30..30 | 0.0 % | 0.0 % | 30 (1x) | 0 / 0 | 0 fps (0.0 %) | 0 fps (0.0 %) | yes |
| docker-linux-arm64 | firefox | PB-PERF-001 startupMs | 10 | 54 ms | p90 61.2 | 41..63 | 15.3 % | 19.2 % | 72 (1.3x) | 3.02 / 4.77 | 20.2 ms (37.5 %) | 15.7 ms (25.6 %) | no: tracked |
| docker-linux-arm64 | firefox | PB-PERF-002 fps | 10 | 30 fps | p10 30 | 30..30 | 0.0 % | 0.0 % | 30 (1x) | 6.26e-7 / 4.7e-7 | 0.00000266 fps (0.0 %) | 0.00000757 fps (0.0 %) | yes |
| docker-linux-arm64 | webkit | PB-PERF-001 startupMs | 10 | 157 ms | p90 284 | 146..516 | 56.7 % | 8.1 % | 311 (2x) | 43 / 17.5 | 182 ms (116.5 %) | 565 ms (199.0 %) | no: tracked |
| docker-linux-arm64 | webkit | PB-PERF-002 fps | 10 | 30 fps | p10 30 | 30..30 | 0.0 % | 0.0 % | 30 (1x) | 0 / 0 | 0 fps (0.0 %) | 0 fps (0.0 %) | yes |
| local-darwin-arm64 | chromium-cpu4x | PB-PERF-004 startupMs | 10 | 111 ms | p90 115 | 94.6..117 | 6.4 % | 5.1 % | 253 (2.3x) | 2.58 / 2.68 | 11.4 ms (10.2 %) | 13.4 ms (11.7 %) | yes |
| local-darwin-arm64 | chromium | PB-PERF-001 startupMs | 10 | 37 ms | p90 39 | 35.5..40.2 | 4.0 % | 4.2 % | 169 (4.6x) | 0.558 / 0.543 | 2.37 ms (6.4 %) | 3.63 ms (9.3 %) | yes |
| local-darwin-arm64 | chromium | PB-PERF-002 fps | 10 | 30 fps | p10 30 | 30..30 | 0.0 % | 0.0 % | 30 (1x) | 0 / 0 | 0 fps (0.0 %) | 0 fps (0.0 %) | yes |
| local-darwin-arm64 | webkit | PB-PERF-001 startupMs | 10 | 80.5 ms | p90 87.1 | 72..88 | 6.8 % | 8.3 % | 258 (3.2x) | 2.05 / 2.69 | 11.4 ms (14.2 %) | 10.7 ms (12.3 %) | yes |
| local-darwin-arm64 | webkit | PB-PERF-002 fps | 10 | 30 fps | p10 30 | 30..30 | 0.0 % | 0.0 % | 30 (1x) | 0 / 0 | 0 fps (0.0 %) | 0 fps (0.0 %) | yes |

### What each relative rule needs

| rule | gated pairs | tracked pairs | largest noise share: median / tail | largest noise: median / tail | quietest pair noise | suggested: median share, tail share, floor |
| --- | --- | --- | --- | --- | --- | --- |
| startup | 3 | 2 | 23.2 % / 22.6 % | 11.4 / 10.7 | 3.63 | 30.0 %, 30.0 %, 5 |
| fps | 5 | 0 | 0.0 % / 0.0 % | 0.00000266 / 0.00000757 | 0 | 5.0 %, 5.0 %, 0 |
| lowEndStartup | 1 | 0 | 10.2 % / 11.7 % | 11.4 / 13.4 | 13.4 | 15.0 %, 15.0 %, 20 |

### Metrics judged by an absolute budget: what the baselines show

| rule | metric | runs | runs above zero | largest value | largest median | largest tail |
| --- | --- | --- | --- | --- | --- | --- |
| frameDropped | droppedRatio | 50 | 0 | 0 ratio | 0 | 0 |
| rebufferCount | rebufferCount | 50 | 0 | 0 count | 0 | 0 |
| rebufferMs | rebufferMs | 50 | 0 | 0 ms | 0 | 0 |
| rebufferRatio | rebufferRatio | 50 | 0 | 0 ratio | 0 | 0 |
| lowEndDropped | droppedRatio | 10 | 0 | 0 ratio | 0 | 0 |

### The committed policy against the noise

Margin = allowed / noise (1 is just enough). A margin below 1 on a gated pair means the policy is tighter than the noise of its baseline.

| environment | profile | metric | allowed: median / tail | noise: median / tail | margin: median / tail | gated |
| --- | --- | --- | --- | --- | --- | --- |
| docker-linux-arm64 | chromium | PB-PERF-001 startupMs | 11.9 / 13.4 ms | 9.2 / 10.1 | 1.3x / 1.3x | yes |
| docker-linux-arm64 | chromium | PB-PERF-002 fps | 1.5 / 3 fps | 0 / 0 | - / - | yes |
| docker-linux-arm64 | firefox | PB-PERF-001 startupMs | 16.2 / 18.4 ms | 20.2 / 15.7 | 0.8x / 1.2x | no: tracked |
| docker-linux-arm64 | firefox | PB-PERF-002 fps | 1.5 / 3 fps | 0.00000266 / 0.00000757 | 560000x / 400000x | yes |
| docker-linux-arm64 | webkit | PB-PERF-001 startupMs | 46.9 / 85.1 ms | 182 / 565 | 0.26x / 0.15x | no: tracked |
| docker-linux-arm64 | webkit | PB-PERF-002 fps | 1.5 / 3 fps | 0 / 0 | - / - | yes |
| local-darwin-arm64 | chromium-cpu4x | PB-PERF-004 startupMs | 33.4 / 34.4 ms | 11.4 / 13.4 | 2.9x / 2.6x | yes |
| local-darwin-arm64 | chromium | PB-PERF-001 startupMs | 11.1 / 11.7 ms | 2.37 / 3.63 | 4.7x / 3.2x | yes |
| local-darwin-arm64 | chromium | PB-PERF-002 fps | 1.5 / 3 fps | 0 / 0 | - / - | yes |
| local-darwin-arm64 | webkit | PB-PERF-001 startupMs | 24.1 / 26.1 ms | 11.4 / 10.7 | 2.1x / 2.4x | yes |
| local-darwin-arm64 | webkit | PB-PERF-002 fps | 1.5 / 3 fps | 0 / 0 | - / - | yes |
