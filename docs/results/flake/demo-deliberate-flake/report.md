# Flake report: demo-deliberate-flake

Generated 2026-11-04T16:14:34.018Z, as of 2026-11-04. History: 25 runs, from 2026-11-04T16:11:50.135Z to 2026-11-04T16:13:54.477Z. Window: the last 30 executions of a test, the last 30 builds of an engine job. A test is judged from 20 executions; the trigger is 5.0%, the suite budget 2.0%.

## Engine jobs: the suite flake rate

Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.

| Engine job | Builds | Executions | Flaky | Failed | Flake rate | Budget | Verdict | Quarantined (left out) | Worst tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | 25 | 0 | 0 | 0 | 0.0% | 2.0% | ok | 25 (6 flaky) | - |

## Tests: the last 30 executions of each

| Test | Engine | Tier | Runs | Flaky | Failed | Flake rate | Failure rate | Verdict | Quarantine | Last failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-VOD-001 | chromium | merge | 25 | 6 | 0 | 24.0% | 0.0% | over-trigger | until 2026-11-10 (@hanniavalera) | flaky, 2026-11-04: Error: deliberately injected first-attempt failure (this is the demons… |

## Quarantine

| Test | Engine | Tier | Owner | Since | Expires | State | Reason | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-VOD-001 | chromium | merge | @hanniavalera | 2026-11-04 | 2026-11-10 | active | demonstration: the first attempt fails in every fourth repetition on purpose (tests/e2e/d… | 25 repetitions of the flake collector: 6 flaky, 0 failed (docs/results/flake/demo-deliber… |

## Skipped

No test was skipped in the history.

## What this does not say

- A rate is a count over a window, not a probability: 30 executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).
- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.
- Every number is from the environment named above; none is comparable with another environment.
