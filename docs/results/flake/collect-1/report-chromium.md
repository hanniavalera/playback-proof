# Flake report: gha-linux-x64

Generated 2026-11-04T15:50:48.477Z, as of 2026-11-04. History: 30 runs, from 2026-11-04T08:24:51.787Z to 2026-11-04T09:00:51.837Z. Window: the last 30 executions of a test, the last 30 builds of an engine job. A test is judged from 20 executions; the trigger is 5.0%, the suite budget 2.0%.

## Engine jobs: the suite flake rate

Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.

| Engine job | Builds | Executions | Flaky | Failed | Flake rate | Budget | Verdict | Quarantined (left out) | Worst tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | 30 | 450 | 0 | 0 | 0.0% | 2.0% | ok | 0 (0 flaky) | - |

## Tests: the last 30 executions of each

| Test | Engine | Tier | Runs | Flaky | Failed | Flake rate | Failure rate | Verdict | Quarantine | Last failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-ABR-002 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-ENV-001 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-LIVE-001 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-LIVE-002 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-LIVE-003 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-LIVE-004 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-REC-001 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-REC-002 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-REC-008 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-001 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-002 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-006 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-007 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-009 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |
| PB-VOD-012 | chromium | merge | 30 | 0 | 0 | 0.0% | 0.0% | ok | - | - |

## Quarantine

Nothing is quarantined: flake/quarantine.json is empty.

## Skipped

No test was skipped in the history.

## What this does not say

- A rate is a count over a window, not a probability: 30 executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).
- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.
- Every number is from the environment named above; none is comparable with another environment.
