# Flake report: gha-macos-arm64

Generated 2026-11-04T21:22:05.553Z, as of 2026-11-04. History: 40 runs, from 2026-11-04T21:07:06.207Z to 2026-11-04T21:20:23.780Z. Window: the last 30 executions of a test, the last 30 builds of an engine job. A test is judged from 20 executions; the trigger is 5.0%, the suite budget 2.0%, the invalid-run budget 40.0%.

## Engine jobs: the suite flake rate

Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.

No merge-tier execution in the history.

## Tests: the last 30 executions of each

| Test | Engine | Tier | Runs | Flaky | Failed | Flake rate | Failure rate | Verdict | Quarantine | Last failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-ABR-001 | webkit | release | 19 | 0 | 0 | 0.0% | 0.0% | not-enough-data | - | - |

## Invalid runs: the share of scheduled executions that could not evaluate their claim

An invalid run is a skip whose reason starts with `invalid run:`: the attempt could not evaluate its claim (docs/FLAKE.md, "Invalid runs"). Per test and engine, over the last 30 scheduled executions (invalid runs and executions that ran to a verdict; a documented gap is neither), judged from 20; above the budget of 40.0% the gate fails, quarantined or not.

| Test | Engine | Tier | Invalid runs | Share | Budget | Verdict | Quarantine | Last invalid run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-ABR-001 | webkit | release | 16 of 30 | 53.3% | 40.0% | over-invalid-budget | - | 2026-11-04: forced downshift to 360p 2.0 s after entering 720p, 10 of 387 frames dropped |

## Quarantine

Nothing is quarantined: flake/quarantine.json is empty.

## Skipped

| Test | Engine | Reason (the evidence a documented gap carries) | Last seen | Skipped |
| --- | --- | --- | --- | --- |
| PB-ABR-001 | webkit | invalid run: forced downshift to 360p 2.0 s after entering 720p, 10 of 387 frames dropped… | 2026-11-04 | 21 of 40 runs |

## What this does not say

- A rate is a count over a window, not a probability: 30 executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).
- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.
- Every number is from the environment named above; none is comparable with another environment.
