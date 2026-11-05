# The committed baselines of `gha-linux-x64` against 13 GitHub-hosted VMs (A/A)

**Written by hand from the artifacts of the `measure` workflow (task `perf-aa`); no tool generated this table.** The per-pass reports of every job are committed in [`gha-cross-vm/raw/`](gha-cross-vm/raw) (each job's `machine.txt` has its `cpu:` line, the pass files have the exit code, the medians and the metric that failed), and the repository's own A/A summarizer was run over them: [`gha-cross-vm/chromium-aa.md`](gha-cross-vm/chromium-aa.md), [`chromium-cpu4x-aa.md`](gha-cross-vm/chromium-cpu4x-aa.md) and [`firefox-aa.md`](gha-cross-vm/firefox-aa.md) (18 passes with 0 false positives, 12 with 6 and 9 with 2; those reports pre-date the recording of the CPU model, so they say "not recorded": the CPU of each job is in `machine.txt`). Source: `measure.yml` runs 41870959932 to 41871055049 on commit `6ab5e98` (branch `perf/gha-baselines`): 13 jobs on `ubuntu-24.04`, each running `npm run perf:gate` three times against the committed baseline of its profile in `perf/baselines/gha-linux-x64/`, with nothing changed. The paired gate that replaced this comparison on GitHub, and its own A/A on twelve other jobs, are in [`paired-aa/`](paired-aa/README.md).

An environment id such as `gha-linux-x64` names a runner class, not a CPU: the 13 jobs landed on five CPU models, counted from the `cpu:` line of each job's `machine.txt` (AMD EPYC 7763 and 9V74, 4 jobs each; AMD EPYC 9V45, 3 jobs; Intel Xeon 8573C and 6975P-C, 1 job each). The Intel Xeon 8370C in the table below is a sixth model: it is the machine the `chromium` baseline was recorded on, and none of the 13 jobs ran on it.

## Result

| Profile (scenario of the startup column) | Baseline recorded on | Job | CPU of the job | Passes | Startup median of the first batch, per pass, against the baseline median |
| --- | --- | --- | --- | --- | --- |
| `chromium` (PB-PERF-001) | Xeon 8370C, 75.4 ms | 1 | EPYC 9V74 | 3 of 3 pass | 55.2, 60.5, 63.9 ms (-26.9, -19.7, -15.3 %) |
| | | 2 | EPYC 7763 | 3 of 3 pass | 67.0, 66.4, 74.3 ms (-11.2, -11.9, -1.4 %) |
| | | 3 | EPYC 9V74 | 3 of 3 pass | 56.3, 57.2, 57.7 ms (-25.3, -24.2, -23.5 %) |
| | | 4 | EPYC 9V45 | 3 of 3 pass | 53.2, 54.6, 54.8 ms (-29.4, -27.5, -27.3 %) |
| | | 5 | EPYC 9V45 | 3 of 3 pass | 56.8, 57.0, 50.8 ms (-24.6, -24.4, -32.7 %) |
| | | 6 | EPYC 9V74 | 3 of 3 pass | 73.1, 74.5, 75.3 ms (-3.1, -1.1, -0.2 %) |
| `chromium-cpu4x` (PB-PERF-004) | EPYC 9V45, 172.3 ms | 1 | EPYC 9V45 | 3 of 3 pass | 176.3, 168.5, 163.3 ms (+2.4, -2.2, -5.2 %) |
| | | 2 | EPYC 9V74 | 3 of 3 pass | 205.7, 214.9, 206.6 ms (+19.4, +24.8, +19.9 %) |
| | | 3 | **EPYC 7763** | **3 of 3 REGRESSION** (reproduced) | 242.9, 236.1, 245.9 ms (+41.0, +37.1, +42.7 %) |
| | | 4 | **EPYC 7763** | **3 of 3 REGRESSION** (reproduced) | 248.1, 244.3, 243.8 ms (+44.0, +41.9, +41.5 %) |
| `firefox` (PB-PERF-001) | EPYC 9V74, 86.5 ms | 1 | Xeon 6975P-C | 3 of 3 pass | 68.0, 69.5, 67.0 ms (-21.4, -19.7, -22.5 %) |
| | | 2 | Xeon 8573C | 3 of 3 pass | 94.5, 96.5, 96.0 ms (+9.2, +11.6, +11.0 %) |
| | | 3 | **EPYC 7763** | **REGRESSION, REGRESSION**, pass | 105.0, 105.5, 110.0 ms (+21.4, +22.0, +27.2 %); the p90 failed: 133 to 141 ms against 96.1 ms and an allowance of 28.8 ms |

**Totals: 39 passes, 8 regressions, all of them on the EPYC 7763: 8 of the 12 passes on that model failed, none of the 27 passes on the other four models.** The baselines were recorded on one machine each (Xeon 8370C for `chromium`, EPYC 9V45 for `chromium-cpu4x`, EPYC 9V74 for `firefox`). Every regression is a reproduced one (exit code 1): the fresh batch of the gate measured the same slow machine and confirmed it. The fresh batch medians of the `chromium-cpu4x` failures were 236.1 to 248.1 ms.

## What it shows

1. **A committed baseline is a measurement of one machine.** On a shared runner the gate failed 8 of 39 passes of an unchanged build, all of them on one CPU model, because the machine was about 40 % slower than the one the baseline came from for a CPU-bound scenario (the 4x throttle multiplies main-thread work).
2. **Confirm-on-regression cannot tell a slow machine from slow code.** The fresh batch runs in the same job, on the same machine, so it reproduces the difference: that is what it is meant to do for a regression in the code.
3. **The same CPU model is not the same machine.** `chromium` on the EPYC 9V74 measured 55 to 64 ms in job 1, 56 to 58 ms in job 3 and 73 to 75 ms in job 6; within job 1 the three passes (about five minutes apart) drifted from 55.2 to 63.9 ms.
4. **The baseline machine decides the sensitivity in the other direction too.** Every `chromium` pass was faster than the baseline (0.2 to 33 %), because the baseline was recorded on a machine that was slower at startup than the three models the six `chromium` jobs landed on (the Xeon 8370C: 75.4 ms, against 50.8 to 75.3 ms in the 18 passes): on a faster machine a regression has to exceed the 30 % limit plus the machine's advantage before the gate sees it.
5. **A job does not take longer on a runner than on the workstation.** The measuring time of one pass was 283 to 288 s for `chromium` (PB-PERF-001, 002, 003), 84 to 86 s for `chromium-cpu4x` (173 s when a fresh batch was needed) and 292 to 300 s for `firefox` (309 s with a fresh batch), against 282 s and 83 s measured on the workstation.

What the gate on GitHub does about it: [PERF.md](../../PERF.md) ("Paired control on a shared runner") and ADR-179 in [perf-paired.md](../../decisions/perf-paired.md). What this file does not show: how the paired gate behaves, which is a separate measurement.
