# Flake report: gha-macos-arm64

Generated 2026-11-04T19:50:30.172Z, as of 2026-11-04. History: 30 runs, from 2026-11-04T19:01:22.547Z to 2026-11-04T19:36:53.321Z. Window: the last 30 executions of a test, the last 30 builds of an engine job. A test is judged from 20 executions; the trigger is 5.0%, the suite budget 2.0%.

## Engine jobs: the suite flake rate

Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.

| Engine job | Builds | Executions | Flaky | Failed | Flake rate | Budget | Verdict | Quarantined (left out) | Worst tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| webkit | 25 | 25 | 0 | 0 | 0.0% | 2.0% | ok | 0 (0 flaky) | - |

## Tests: the last 30 executions of each

| Test | Engine | Tier | Runs | Flaky | Failed | Flake rate | Failure rate | Verdict | Quarantine | Last failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-ABR-001 | webkit | release | 30 | 4 | 19 | 13.3% | 63.3% | over-trigger | - | flaky, 2026-11-04: Error: rung changes in the <n> s after reaching <n>p (qa.events()): no… |
| PB-ABR-002 | webkit | merge | 25 | 0 | 0 | 0.0% | 0.0% | ok | - | - |

## Quarantine

Nothing is quarantined: flake/quarantine.json is empty.

## Skipped

| Test | Engine | Reason (the evidence a documented gap carries) | Last seen | Skipped |
| --- | --- | --- | --- | --- |
| PB-ABR-002 | webkit | invalid run: forced climb to 360p 3.3 s after the step down, 10 of 1104 frames dropped. T… | 2026-11-04 | 5 of 30 runs |

## What this does not say

- A rate is a count over a window, not a probability: 30 executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).
- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.
- Every number is from the environment named above; none is comparable with another environment.
