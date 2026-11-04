## A/A check: firefox in `docker-linux-arm64`

The gate was run **5 times** against its own baseline (recorded 2026-11-04 at commit `58da1b2`, browser 157.0) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002.

- **False positives (exit code 1): 0 of 5.**
- Exit codes: 0 x 2, 1 x 0, 2 x 3.
- **Passes that could not be trusted (exit code 2): 3 of 5.** They are not false positives: the measurement failed, and what is in the table comes from the other passes. The first line of each problem is listed below; the JSON keeps the whole message.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0.000001987 fps / 0 fps | 0 % / 0 % | 0.000001405 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 startupMs, PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames.

> Problem in reports/aa/docker-firefox/1/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 1 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).

> Problem in reports/aa/docker-firefox/3/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 8 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).

> Problem in reports/aa/docker-firefox/5/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 6 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
