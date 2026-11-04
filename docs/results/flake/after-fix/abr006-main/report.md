# Flake report: gha-macos-arm64

Generated 2026-11-04T19:01:12.057Z, as of 2026-11-04. History: 40 runs, from 2026-11-04T18:01:06.140Z to 2026-11-04T18:15:18.625Z. Window: the last 30 executions of a test, the last 30 builds of an engine job. A test is judged from 20 executions; the trigger is 5.0%, the suite budget 2.0%.

## Engine jobs: the suite flake rate

Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.

No merge-tier execution in the history.

## Tests: the last 30 executions of each

| Test | Engine | Tier | Runs | Flaky | Failed | Flake rate | Failure rate | Verdict | Quarantine | Last failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-ABR-006 | webkit | release | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |

## Quarantine

Nothing is quarantined: flake/quarantine.json is empty.

## Skipped

No test was skipped in the history.

## What this does not say

- A rate is a count over a window, not a probability: 30 executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).
- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.
- Every number is from the environment named above; none is comparable with another environment.
