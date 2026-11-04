# Flake rate: what was measured

Everything here was measured with the tools of this repository (the Playwright reporter, the collector `tools/flake-collect.ts`, the report `npm run flake:report` and the gate), on GitHub-hosted runners through [`measure.yml`](../../../.github/workflows/measure.yml), except the demonstration at the end, which ran on a workstation. The mechanism is [FLAKE.md](../../FLAKE.md); the arguments for the policy numbers are [decisions/flake.md](../../decisions/flake.md).

**Words.** A _flaky_ outcome is a test that failed its first attempt and passed its retry in the same run (`--retries 1`, as in CI); a _failed_ outcome failed both attempts; a _skipped_ attempt carries its reason, and an _invalid run_ is a skip whose reason says that the attempt could not evaluate its claim (ADR-106). One _execution_ is one test in one repetition. Every number carries its environment id and nothing here compares one environment with another: the Linux runner and the macOS runner are different machines, with different CPUs and different WebKit builds.

## The numbers in one table

| #   | What                                                           | Environment      | Repetitions | Executions |  Flaky | Failed (both attempts) | Skipped as invalid run | Files                                                                                  |
| --- | -------------------------------------------------------------- | ---------------- | ----------: | ---------: | -----: | ---------------------: | ---------------------: | -------------------------------------------------------------------------------------- |
| 1a  | the whole `@merge` tier, Chromium                              | `gha-linux-x64`  |          30 |        450 |      0 |                      0 |                      0 | [report](collect-1/report-chromium.md), [raw](collect-1/raw/chromium)                  |
| 1b  | the whole `@merge` tier, Firefox                               | `gha-linux-x64`  |          30 |        450 |      0 |                      0 |                      0 | [report](collect-1/report-firefox.md), [raw](collect-1/raw/firefox)                    |
| 1c  | the whole `@merge` tier, WebKit on Linux (experimental)        | `gha-linux-x64`  |          30 |        450 |      0 |                      0 |                      0 | [report](collect-1/report-webkit-linux.md), [raw](collect-1/raw/webkit-linux)          |
| 1d  | the whole `@merge` tier, WebKit on macOS                       | `gha-macos-arm64` |         20 |        300 |      1 |                      2 |                      0 | [report](collect-1/report-webkit-macos.md), [raw](collect-1/raw/webkit-macos)          |
| 2   | PB-ABR-002 alone, WebKit on macOS, **before** the fix          | `gha-macos-arm64` |         40 |         40 |      4 |                      0 |                      0 | [raw](abr-002-macos-40/raw), [four attempts](abr-002-macos-40/failing-attempts)        |
| 3a  | PB-ABR-002, after the fix (ADR-106)                            | `gha-macos-arm64` |         40 |         32 |      0 |                      0 |                      8 | [report](after-fix/abr002-fix/report.md), [raw](after-fix/abr002-fix/raw)              |
| 3b  | the same with tracing off                                      | `gha-macos-arm64` |         40 |         34 |      0 |                      0 |                      6 | [report](after-fix/abr002-traceoff/report.md), [raw](after-fix/abr002-traceoff/raw)    |
| 3c  | the same, next to WebKit at device scale factor 1 (experiment) | `gha-macos-arm64` |    40 + 40 |    30 + 35 |      0 |                      0 |               10 + 5   | [report](after-fix/dpr1b/report.md), [raw](after-fix/dpr1b/raw)                        |
| 3d  | the same, in a job of its own, next to PB-ABR-001              | `gha-macos-arm64` |          30 |         25 |      0 |                      0 |                      5 | [report](after-fix/abr12-isolated/report.md), [raw](after-fix/abr12-isolated/raw)      |
| 4   | PB-ABR-006 (release tier)                                      | `gha-macos-arm64` |          40 |         40 |      0 |                      0 |                      0 | [report](after-fix/abr006-main/report.md), [raw](after-fix/abr006-main/raw)            |
| 5a  | PB-ABR-001 (release tier), other macOS jobs running            | `gha-macos-arm64` |          40 |         40 |      6 |                 **26** |                      0 | [report](after-fix/abr001-main/report.md), [raw](after-fix/abr001-main/raw)            |
| 5b  | PB-ABR-001 (release tier), in a job of its own                 | `gha-macos-arm64` |          30 |         30 |      4 |                 **19** |                      0 | [report](after-fix/abr12-isolated/report.md), [raw](after-fix/abr12-isolated/raw)      |
| 6   | a deliberately flaky test, 25 repetitions (a demonstration)    | `demo-deliberate-flake` (a workstation) |   25 |         25 |      6 |                      0 |                      0 | [the demonstration](demo-deliberate-flake/README.md)                                   |

How each was run: `npx tsx tools/flake-collect.ts --project <engine> --runs <n> --grep <what>` inside one `measure.yml` job (task `flake-collect`), one repetition being one Playwright invocation with one retry and the flake reporter; the commits and machines are in the `machine*.txt` files next to the data. The GitHub runs: 1a to 1d [41799200378](https://github.com/hanniavalera/playback-proof/actions/runs/41799200378), [41799203955](https://github.com/hanniavalera/playback-proof/actions/runs/41799203955), [41799207740](https://github.com/hanniavalera/playback-proof/actions/runs/41799207740) and [41799211831](https://github.com/hanniavalera/playback-proof/actions/runs/41799211831); 2 [41862147667](https://github.com/hanniavalera/playback-proof/actions/runs/41862147667); 3a [41876590730](https://github.com/hanniavalera/playback-proof/actions/runs/41876590730); 3b [41876600074](https://github.com/hanniavalera/playback-proof/actions/runs/41876600074); 3c, 5a and 4 [41882643648](https://github.com/hanniavalera/playback-proof/actions/runs/41882643648), [41882651860](https://github.com/hanniavalera/playback-proof/actions/runs/41882651860) and [41882660744](https://github.com/hanniavalera/playback-proof/actions/runs/41882660744) (three jobs started in the same minute); 3d and 5b [41892727961](https://github.com/hanniavalera/playback-proof/actions/runs/41892727961). The reports were rendered afterwards from the raw histories with `flake/report.ts`, so a report's window ("the last 30 executions") can be shorter than the collection: the counts above are from the raw files.

## 1. The whole `@merge` tier

Thirty repetitions of the 15 `@merge` tests in each Linux engine, on the commit `be6f38c` of `main`, 2026-11-04: **no flaky and no failed execution in 450, in any of the three engines.** The 95 % upper bound on the rate over the tier is 0.8 % per execution (Clopper-Pearson, 0 of 450). Per test the evidence is thinner: 30 executions each, whose upper bound is 10 to 12 %, so the data excludes a test that flakes at 10 % or more and says nothing about one that flakes at 1 or 2 % ([FLAKE.md](../../FLAKE.md) puts the chance that a 5 % test shows two flaky outcomes in a window of 30 at 45 %). The three engines ran on three different CPUs (AMD EPYC 7763, Intel Xeon Platinum 8370C, AMD EPYC 9V45: [`machine-*.txt`](collect-1)), so the rates of the engines are not a comparison of the engines either.

The macOS runner is a different story. Twenty repetitions (300 executions, one worker, three vCPUs of a virtual Apple M1) gave **3 first-attempt failures in 300, all of one test, PB-ABR-002** (the other 14 tests passed 20 of 20): one flaky, and two that failed both attempts.

## 2. One test that flaked: PB-ABR-002 on macOS WebKit

Forty repetitions of PB-ABR-002 alone, with the traces kept (row 2): 4 more first-attempt failures, every one passing on the retry. Together with row 1d that is **7 first attempts failed in 60 (11.7 %, Wilson 95 % interval 5.8 to 22.2 %) and 2 in 60 failed both** (3.3 %, 0.9 to 11.4 %). The flake gate triggers at 5 % per test, so this would have turned the required `flake` check red once the history held 20 executions of the runner.

Four of the failing attempts kept their traces (the [error contexts](abr-002-macos-40/failing-attempts) are here; the traces themselves hold media segments and are not committed). They show one shape: after the link drops, the player steps down to the rung it carries (240p), and then **climbs to 360p, a rung the 600 kbps link cannot carry, 4.0 to 6.0 s later, with 10 to 55 frames dropped and no failed request.** The climb comes 1.89 to 1.92 s after the playhead enters the first 240p segment, in all four. That is the timing of Shaka's dropped-frame protection, which looks every 2 s and, at 15 % of the frames of a window dropped, bans the rung that plays for 30 s. The timing is confirmed; the burst of dropped frames itself was not observed, so the cause is a hypothesis with one confirmed prediction ([ADR-106](../../decisions/e2e-abr.md), with the table of the four traces). The player did what Shaka's design says; the test's claim, that nothing changes after the step down, could not be evaluated on that attempt.

**The fix** (pull request 13): the spec recognises that shape (a first change that is a climb above the rung the link carries, made by the player, sooner than the 8 s the adaptation waits, on a load that dropped frames, with no failed request) and ends the attempt as an **invalid run**: a skip, with its numbers, counted by the collector and listed by the report. Any other change after the step down still fails the test.

## 3. After the fix

The same collection, 40 repetitions each, then twice more (rows 3a to 3d). One character per repetition: `.` ran to a verdict and passed on the first attempt, `s` skipped as an invalid run, `F` flaky, `X` failed both attempts.

```text
3a fix                       s.s................s...s...s.ss......s..
3b fix, tracing off          s...s..s....ss...............s..........
3c fix, scale factor 2       s..s...........s.s......s.s.s...ss..s...
3c fix, scale factor 1       .ss..s.............ss...................
3d fix, a job of its own     .s.s.s..........ss............
```

| Series                         | Repetitions | Ran to a verdict | Failed or flaky | Invalid runs |
| ------------------------------ | ----------: | ---------------: | --------------: | -----------: |
| 3a fix                         |          40 |               32 |               0 |    8 (20 %)  |
| 3b fix, tracing off            |          40 |               34 |               0 |    6 (15 %)  |
| 3c fix, default scale factor   |          40 |               30 |               0 |   10 (25 %)  |
| 3c fix, device scale factor 1  |          40 |               35 |               0 |  5 (12.5 %)  |
| 3d fix, in a job of its own    |          30 |               25 |               0 |    5 (17 %)  |

**0 of 156 executions that ran to a verdict failed or flaked; 34 of 190 attempts (17.9 %) were invalid runs**, 29 of 150 (19.3 %, Wilson 13.8 to 26.4 %) in the four series with the default configuration. Before the fix 6 of the 60 first attempts failed on the assertion that now skips (10 %, 4.7 to 20 %): the two shares are compatible with one cause that produces an invalid attempt in 10 to 25 % of the attempts on this runner, which the fix **labels instead of failing**. It did not make the test stronger, and it did not remove the cause: what changed is that a forced change is no longer reported as a defect of the player.

Two things were tried to remove the cause, and neither did. Tracing off (3b, `--trace off`: the recording of a trace costs CPU) gave 6 of 40 against 8 of 40 (Fisher exact p = 0.77). WebKit at a device scale factor of 1 (3c, a project of an experiment branch that is not merged, [`exp/abr002-load`](https://github.com/hanniavalera/playback-proof/tree/exp/abr002-load); a smaller surface to composite) gave 5 of 40 against 10 of 40 in the same job and repetitions (p = 0.25): a halving that 40 repetitions cannot tell from chance. So **no change of the test removes the cause**; the share is 12.5 to 25 % and varies with the machine the job lands on. A test that is skipped as invalid in most of its runs protects nothing and would look green, which is why the share is budgeted by the gate (40 %, ADR-135a, pull request 20) and not only reported.

The strips of the invalid runs above show them spread over the whole of each collection, not clustered at its start, although every macOS job starts about a minute after the VM booted, at a load average of 65 to 100 (the image's own start-up work), and ends at a load average of 2 to 3 ([`machine.txt`](after-fix/abr12-isolated/machine.txt)).

## 4. PB-ABR-006 and PB-ABR-001, the release tier

PB-ABR-006 (also covered by the classifier) passed **40 of 40** (row 4).

PB-ABR-001, "climbs to the top rung on an unconstrained network and stays there", **fails most of its attempts on the same runner**. One character per repetition, as above:

```text
5a other macOS jobs running  .XXX.XX.FX.XF..X.XXXXXFFXXXX.FXXXXFXXXXX
5b a job of its own          ..XXF.F.XXX.XXXXX.XXX.FXXXXXXF
```

Row 5a, 40 repetitions with other macOS jobs of this project running at the same time: 8 passed first time, 6 flaky and **26 failed both attempts** (65 %, Wilson 49.5 to 77.9 %). Row 5b, 30 repetitions in a job that ran alone, with PB-ABR-002 in the same invocation: 7, 4 and **19** (63 %, 45.5 to 78.1 %). Pooled, 55 of 70 first attempts failed (78.6 %, 67.6 to 86.6 %) and 45 of 70 failed both (64.3 %, 52.6 to 74.5 %). The two collections do not differ, which rules out jobs competing with each other as the cause.

All 100 failing attempts have one message, and almost one timeline ([`abr001-failing-attempts.jsonl`](after-fix/abr001-failing-attempts.jsonl), one line per attempt, taken from the error context of each): after the player reaches 720p, **it changes to 360p at 9.88 to 10.02 s of media time, in 100 of 100** (median 9.89 s; once more, to 240p at 11.93 s). The frames dropped in the whole attempt were 2 to 30 of about 386 (0.5 to 7.7 %, the median 1.5 to 1.8 % in the two collections), and no request failed. 9.9 s is about 1.9 s after the playhead enters the first 720p segment (8 s), the same fingerprint as the forced climb of PB-ABR-002: it looks like the dropped-frame protection of Shaka again, this time banning the top rung. Seven of the attempts dropped only 2 frames in all, which cannot be 15 % of a 2 s window of 60 frames, so how the protection fires on so few frames is not explained here, and no sentence of this page says it is.

In the five runs of the nightly workflow's macOS leg that could be read (`nightly.yml` runs every `@merge` and `@release` test in one invocation), PB-ABR-001 was flaky in 2 and green in 3, and never failed both attempts: milder than here, and the difference is not explained (in the collections the test runs first in an invocation of one or two tests, in the nightly first in an invocation of about forty; there is no difference that could be named). Whatever the reason, **the nightly's macOS leg cannot count on PB-ABR-001 passing**.

## 5. A flake the tracker does not see: a unit test

On 2026-11-04 the `unit` job of pull request 15 failed on a test that has nothing to do with the player: `tests/unit/probe/media.test.ts`, "generates the same bytes every time": `v-hevc.mp4: expected '47bccd0e…' to be '7f3ced40…'` (run 41896513054). The two generations of the HEVC probe clip, in one job a few seconds apart, hashed differently; **the second equals the hash committed for `gha-linux-x64`**, so it was the first that deviated. The job passed on a re-run. The cause is not known. A diagnostic run on a hosted runner (4 vCPUs, AMD EPYC 7763, ffmpeg 6.1.1-3ubuntu5) encoded the same clip 12 times idle and 12 times with eight busy loops on the 4 vCPUs, and every series produced one hash (the committed one) in 12 of 12; with `-threads 1`, a different hash, also 12 of 12; H.264 likewise. So the nondeterminism, one failure in the 40 most recent runs of `ci.yml` before it, was not reproduced, and the experiment cannot exclude a rate of 1 or 2 %. The flake tracker records Playwright runs, not Vitest runs: **this class of flake is not tracked**, and the only record of it is this paragraph and a failed job.

## 6. The gate stops a flake: a demonstration

[`demo-deliberate-flake`](demo-deliberate-flake/README.md): a scratch spec that fails its first attempt in every fourth repetition, run 25 times with the real collector and judged by the real gate. 6 flaky executions (repetitions 4, 8, 12, 16, 20, 24), every build green to a pass/fail run; the gate failed with exit 1 and the decision it drives; one quarantine entry later, exit 0, with the test still listed with its owner and expiry. It shows the mechanism end to end and says nothing about the player.

## What this does not say

- **It is a count, not a rate.** 30 or 40 repetitions cannot tell a test that flakes at 1 % from one that never does; the intervals above are the honest way to read them.
- **One runner type per environment, on one day.** Every number was measured on 2026-11-04, on the runners GitHub gave that day (the CPU models differ between jobs, which the A/A experiments of the performance gate showed matters: [PERF.md](../../PERF.md)). The flake history in CI (the `ci-data` branch) is the long-run record, and on the day of writing it holds a handful of runs.
- **The classifier labels, it does not repair.** 17.9 % of the attempts of PB-ABR-002 on the macOS runner evaluate nothing. A leg whose invalid runs exceed 40 % of its scheduled executions fails the flake gate (ADR-135a), which is the designed outcome for PB-ABR-001 on this runner if its failures are classified the same way.
- **The cause of the forced rung changes is a hypothesis.** The timing predicts them; the dropped-frame burst was not observed, and the smallest attempts (2 frames) do not fit the 15 % rule as stated.
- **Linux WebKit is experimental**; its 450 clean executions are a fact about one image and one day ([ADR-067](../../decisions/player.md)).
