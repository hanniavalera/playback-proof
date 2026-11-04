# Paired A/A: the performance gate against itself, on twelve GitHub-hosted runners

The gate that guards pull requests on GitHub compares the head with a **control measured on the same machine** (`npm run gate:perf -- --paired`, [ADR-179](../../../decisions/perf-paired.md)), because a baseline committed from one machine failed an unchanged build on a slower one ([../gha-cross-vm.md](../gha-cross-vm.md): 8 of 39 passes against the committed baselines, all on one CPU model). This is the same kind of check for the paired gate: **an A/A**, in which the control and the head are the same commit, run on many machines. Every pass is a false positive if it is not a pass.

## What was run

`measure.yml`, task `perf-aa`, with `args="--paired --control-ref HEAD"` and `repeat=3`, on twelve separate `ubuntu-24.04` jobs (six per profile), all on commit `b971ed3` (the commit of pull request #14 that wired the perf job; the harness and the paired gate are the ones that were merged). Each pass measures the control (a checkout of the same commit, built and measured by its own harness: 10 runs per scenario after a discarded warm-up), then the head (the same), on the same machine, and judges the head against what the control just measured with the usual rules and thresholds; `paired.aa` is `true` in every report. The three passes of a job share one machine, so the twelve jobs are the independent samples of the machine, not the thirty-six passes.

| Profile | Job | CPU of the job | Verdicts | Startup median, control to head (first batch), per pass |
| --- | --- | --- | --- | --- |
| `chromium` | 1 | AMD EPYC 7763 | 3 of 3 pass | 76 to 75 ms (-2 %); 78 to 78 ms (+0 %); 79 to 77 ms (-3 %) |
| `chromium` | 2 | Intel Xeon Platinum 8573C | 3 of 3 pass | 68 to 78 ms (+15 %); 78 to 74 ms (-6 %); 70 to 72 ms (+2 %) |
| `chromium` | 3 | AMD EPYC 7763 | 3 of 3 pass | 70 to 75 ms (+7 %); 74 to 71 ms (-5 %); 78 to 70 ms (-10 %) |
| `chromium` | 4 | Intel Xeon 6975P-C | 3 of 3 pass | 55 to 52 ms (-5 %); 56 to 52 ms (-6 %); 55 to 51 ms (-7 %) |
| `chromium` | 5 | Intel Xeon Platinum 8370C | 3 of 3 pass | 71 to 77 ms (+9 %); 78 to 77 ms (-1 %); 70 to 72 ms (+3 %) |
| `chromium` | 6 | AMD EPYC 9V74 | 3 of 3 pass | 61 to 61 ms (-1 %); 63 to 64 ms (+0 %); 65 to 60 ms (-8 %) |
| `chromium-cpu4x` | 1 | AMD EPYC 7763 | 3 of 3 pass | 255 to 249 ms (-2 %); 244 to 242 ms (-1 %); 253 to 249 ms (-2 %) |
| `chromium-cpu4x` | 2 | AMD EPYC 7763 | 3 of 3 pass | 250 to 250 ms (+0 %); 247 to 255 ms (+3 %); 250 to 253 ms (+1 %) |
| `chromium-cpu4x` | 3 | Intel Xeon 6975P-C | 3 of 3 pass | 182 to 178 ms (-2 %); 186 to 185 ms (-1 %); 181 to 180 ms (-1 %) |
| `chromium-cpu4x` | 4 | AMD EPYC 9V74 | 3 of 3 pass | 204 to 204 ms (+0 %); 201 to 208 ms (+3 %); 201 to 209 ms (+4 %) |
| `chromium-cpu4x` | 5 | Intel Xeon Platinum 8370C | 3 of 3 pass | 256 to 251 ms (-2 %); 249 to 248 ms (-0 %); 255 to 255 ms (+0 %) |
| `chromium-cpu4x` | 6 | Intel Xeon 6975P-C | 3 of 3 pass | 173 to 180 ms (+4 %); 167 to 172 ms (+3 %); 171 to 169 ms (-1 %) |

The summaries made by the repository's own A/A tool over the raw reports: [`chromium-aa.md`](chromium-aa.md) (18 passes, 0 false positives, 0 first-batch alarms, 5 CPU models) and [`chromium-cpu4x-aa.md`](chromium-cpu4x-aa.md) (18 passes, 0 false positives, 0 first-batch alarms, 4 CPU models). The raw reports and each job's machine facts are in [`raw/`](raw) (`<profile>-<job>/pass-<k>.json`, `machine.txt`). The workflow runs, in the order of the table (`gh run view <id>` on `hanniavalera/playback-proof`): chromium 41881699584, 41881707473, 41881715419, 41881723524, 41881732140, 41881740310; low-end 41881748902, 41881757244, 41881765921, 41881773664, 41881781394, 41881790295.

## What it shows

1. **36 passes, 0 false positives.** Every exit code was 0. The machines are the ones that failed the committed baselines (four of the twelve jobs ran on the AMD EPYC 7763: 12 of the 36 passes above), and they pass here.
2. **The machine effect cancels.** The control medians of the low-end profile range from 167 to 256 ms across these jobs (a spread of about 45 % between machines of one runner label), and the head against the control stays within -2 % and +4 %. For `chromium` the control medians range from 55 to 79 ms and the head stays within -10 % and +15 % (the +15 % pass is 68 to 78 ms: 10 ms, with a threshold of 30 % and more than 5 ms).
3. **No ordering bias that this size of experiment can see.** The control is measured first (a known weakness, ADR-179). The mean difference of the head from the control over the passes is -1.0 % for `chromium` and +0.3 % for the low-end profile; a drift of the machine that counted against the head would make it positive.

## What it does not show

- **It bounds the false-positive rate, it does not measure it at zero.** 0 of 36 passes means that, at 95 % confidence, the rate per pass is below about 8 % (`1 - 0.05^(1/36)`), and the passes of a job are not independent (twelve machines). A required check that blocks one pull request in a hundred for no reason is not excluded by this data; a re-run is how that is handled, and the flake and perf reports are what would show it.
- **It says nothing about sensitivity.** An A/A cannot fail for the right reason. That a real regression fails the paired gate is shown by the pull request of [../paired-sensitivity.md](../paired-sensitivity.md).
- **Linux, Chromium, two profiles.** Firefox and WebKit are not gated in CI (their baselines are noisy: [../threshold-derivation.md](../threshold-derivation.md)), and macOS runners were not measured (the first runner's load average was 44 when its baseline started).
- **Not a statement about any other CPU model**, nor about the day the runner images change.
