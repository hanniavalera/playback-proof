# Performance baselines and the regression gate: how to run it, read it and re-baseline

The lab measures **startup, rebuffering and frame rate** of its player (and startup and dropped frames under a **4x CPU throttle**, Chromium only) on every build, compares them with a **baseline committed for each environment and browser**, and **fails the merge when a regression reproduces**. This page is how to use it. Why it is built this way: [ADR-120 to ADR-129](decisions/perf.md). What the metrics are: [METRICS.md](METRICS.md). The policy numbers: `PERF_POLICY` in [`src/shared/criteria.ts`](../src/shared/criteria.ts), rendered in [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 7.1. **The numbers are not repeated here**; they are in the files this page links to.

## The commands

| Command | What it does | What it writes |
| --- | --- | --- |
| `npm run perf -- --profile chromium --scenario PB-PERF-001` | Measures and prints the median, p10, p90, range and CV of every metric. No baseline needed. | `reports/perf/<envId>/<profile>.run.json` |
| `npm run perf:baseline -- --profile chromium` | The same for every scenario of the profile, then **records the baseline** and lists which metrics gate and which are tracked. | `perf/baselines/<envId>/<profile>.json` |
| `npm run perf:gate -- --profile chromium,chromium-cpu4x` | **The gate**: measures, compares with the baseline of this environment, measures a fresh batch of anything that failed, decides. | `reports/perf/<envId>/<profile>.json` and `.md` (the Markdown also goes to `$GITHUB_STEP_SUMMARY` when it is set) |
| `npx tsx perf/quiet.ts --max-load 3 -- <command>` | Waits until the host's 1-minute load average is at or below the limit (exit 2 after 15 minutes), then runs the command, and the baseline records the wait. Use it for anything that records a baseline. | nothing |
| `npx tsx perf/aa.ts <gate-report.json>...` | Summarizes an **A/A check**: the gate run several times against its own baseline. | `docs/results/perf/<envId>/<profile>-aa.json` and `.md` |
| `npx tsx perf/derive.ts` | Derives what the thresholds have to be from the baselines on disk, and shows the margin of the committed policy above each baseline's noise. | `docs/results/perf/threshold-derivation.json` and `.md` |

Profiles: `chromium`, `firefox`, `webkit`, `chromium-cpu4x`. Firefox on a macOS host, and the Linux environment, run through the Playwright container: `npm run docker:pw -- --cpus 4 npm run perf:gate -- --profile firefox` (that is another environment, `docker-linux-<arch>`, and its baseline is recorded the same way). `npm run perf -- --help` lists every option. `--inject-faults <json>`, `--inject-cpu-throttle <rate>` and `--inject-on first` put a regression in **on purpose** (the sensitivity check): never into a baseline, and the report says so.

## Exit codes of the gate

| Code | Meaning | What to do |
| --- | --- | --- |
| **0** | Every gated metric is within its threshold. A failure that did **not reproduce** also passes: the report says the first measurement was discarded. | Nothing. |
| **1** | A regression **reproduced**: the same metric failed in the first batch and again in a fresh browser with fresh runs. | Read the table: baseline against current median and tail, the change, the threshold, both batches. Fix it, or, if the change is intended, record the baseline again in the same pull request and say why. |
| **2** | The measurement **could not be trusted**: no baseline for this environment (the message prints the command that records one), a stream that changed, a different start rung, a documented gap, a browser that did not start, a run that failed. It is never a regression. | Read the `PROBLEM` lines. A changed stream means every baseline of the environment has to be recorded again, together. |

`npm run perf:baseline` exits 0 or 2. A reproduced regression wins over a problem elsewhere; a problem wins over a pass.

## Reading a report

One table per scenario: metric, baseline median and tail, current median and tail, change, the threshold in words, verdict. The tail is the p90 (the p10 for the frame rate). A verdict is **pass**, **REGRESSION** (failed twice), **not reproduced** (failed once, passed in the fresh batch), or **tracked**. **Tracked, not gated** means the metric is reported on every build and can neither fail it nor start a re-measure, for one of two reasons the report states: it has no rule (manifest time, the frame counts), or its **baseline is noisier than the stability limit** (`PERF_POLICY.maxBaselineCv`): that baseline cannot tell a regression of any useful size from noise, which is the truth about that environment and not a defect. Which pairs are tracked on the recorded baselines is in [threshold-derivation.md](results/perf/threshold-derivation.md) (last column). Warnings (a different browser build, Playwright version or CPU count; a high load average; an injection on purpose) explain why a number moved and never fail a build.

**Which machine.** Every report carries one line, `baseline machine: <CPU model or 'not recorded'>; this machine: <CPU model>` (in the terminal, the Markdown, the job summary and the JSON), and, when both are known and differ, a note that the CPU model differs from the one the baseline was recorded on and that a difference in startup of that size may be the machine. An environment id such as `gha-linux-x64` is a pool of different CPUs, so a number can move because the job landed on another one ([the measurements](results/perf/gha-cross-vm.md)); the line says so and changes no verdict and no threshold ([ADR-178](decisions/perf-paired.md)). The model is recorded as `host.cpuModel` (`os.cpus()[0].model`); baselines recorded before the field existed say `not recorded` and stay valid, and the Playwright container on an Apple-silicon host does not name its CPU and records none. The A/A summary lists the CPU model of every pass, how many distinct models the passes ran on, and a table of pass, verdict, CPU model, startup median against the baseline median and deviation.

## Baselines

They live in [`perf/baselines/<envId>/<profile>.json`](../perf/baselines), committed. `<envId>` is what the code calls the machine ([`detectEnvId()`](../src/shared/env.ts)): `PB_ENV_ID` if set; `gha-<os>-<arch>` on GitHub Actions (`gha-linux-x64`, `gha-macos-arm64`); `jenkins-<platform>-<arch>`; `docker-<platform>-<arch>` in a container; otherwise `local-<platform>-<arch>`. A baseline holds every run, every summary, the content hash of every stream, the host, browser and Playwright versions and how it was measured (the container's CPU limit, the load average, what the quiet-machine wait found). The loader checks that every summary follows from the raw values beside it, and **refuses a baseline of another environment**: numbers are never compared across environments (ADR-126).

## Re-baselining, and recording a new environment

Record the baseline again when the environment has none, when the gate says a stream changed (exit 2), or when a pull request changes performance **on purpose**. On a new environment, in this order:

1. **Record each profile** on a machine that is otherwise idle, one browser at a time: `npx tsx perf/quiet.ts --max-load 3 -- npm run perf:baseline -- --profile <profile>`. On GitHub's runners the `measure` workflow does it (`task=perf-baseline`, one dispatch per profile and runner: `docs/CI.md`, "Measurements on GitHub runners"). Read the list of gating and tracked metrics it prints.
2. **Commit** `perf/baselines/<envId>/` (a baseline change is a decision that deserves a diff), without changing code in the same commit: the baseline records the commit it was measured at.
3. **Run the A/A check**: the gate against its own baseline, at least five times (`task=perf-aa` on a runner), then `npx tsx perf/aa.ts` on the reports. Read `docs/results/perf/<envId>/<profile>-aa.md`: **false positives must be 0**, and a pass that exited 2 is not a false positive but has to be explained (its first line is in the summary, the rest in the JSON). Zero in a few passes is a sanity check, not a proof: read how much of its allowance each metric used.
4. **Check the thresholds fit**: `npx tsx perf/derive.ts` and read the last table of [threshold-derivation.md](results/perf/threshold-derivation.md): a margin below 1 on a gated pair means the committed thresholds are tighter than that baseline's noise. The thresholds are one set for every environment (`PERF_POLICY`): noise is handled per environment by the stability limit, not by thresholds of its own.

## Where the results are

[`perf/baselines`](../perf/baselines) (raw runs) · [`docs/results/perf/threshold-derivation.md`](results/perf/threshold-derivation.md) (variation of every metric, what each rule needs, the policy's margin) · `docs/results/perf/<envId>/<profile>-aa.md` (the A/A checks; [`after-fix`](results/perf/after-fix) holds the ones after a harness fix) · [`docs/results/perf/sensitivity/summary.md`](results/perf/sensitivity/summary.md) (regressions injected on purpose, and what the gate did). What a lab number means and does not mean: ADR-129.
