# Paired gate sensitivity: a real regression on a real pull request

The [A/A](paired-aa/README.md) shows that the paired gate does not fail a build for the machine it landed on. This is the other half: **does it fail a build that is slower?** The test is a pull request that makes the player slower by a known amount and nothing else.

## The pull request

Draft pull request #16, "DEMO (do not merge): a 150 ms startup regression", closed without merging. Head commit `d1b6582` on base `e0a5be3`, one change in `src/player/hook.ts`: the page waits 150 ms between recording `load-requested` and handing the manifest to the player. CI run [41887534070](https://github.com/hanniavalera/playback-proof/actions/runs/41887534070).

| Check | Result |
| --- | --- |
| `static`, `unit` | pass |
| `merge-gate` chromium, chromium-cpu4x, webkit (Linux), webkit (macOS) | pass: no functional test notices 150 ms in the load path |
| `merge-gate (firefox)` | **failed in the setup step, before any test**: the install of the browser's system packages found the dpkg lock held by an `apt-get` that a watchdog in the setup action had killed too late. Nothing to do with the change; the watchdog was removed in the next pull request and apt's own stall timeouts are used instead. `flake` failed in consequence (it had no Firefox report to judge). |
| **`perf (chromium)`** | **fail: REGRESSION** ([`chromium.md`](paired-sensitivity/chromium.md)) |
| **`perf (chromium-cpu4x)`** | **fail: REGRESSION** ([`chromium-cpu4x.md`](paired-sensitivity/chromium-cpu4x.md)) |
| `triage` | ran (a leg was red) and clustered what it was given: [../triage/ci-demo.md](../triage/ci-demo.md) |

Both perf legs are required checks, so the pull request could not have been merged.

## What the gate said

Each leg measured the control (`e0a5be3`, built and measured by its own harness) and then the head on the same machine, and the reports say that machine's CPU model for both (Intel Xeon 6973P-C for `chromium`, AMD EPYC 7763 for `chromium-cpu4x`).

| Profile | Metric | Control (median) | Head, first batch | Fresh batch | Allowed | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `chromium` (PB-PERF-001) | startup | 58.95 ms | 200.6 ms (+240.3 %, p90 +220.2 %) | 192.3 ms (+226.1 %) | 17.69 ms (30 %, more than 5 ms) | REGRESSION, reproduced |
| `chromium-cpu4x` (PB-PERF-004) | startup | 266.7 ms | 354.9 ms (+33.1 %, p90 +32.2 %) | 347.3 ms (+30.2 %) | 80 ms (30 %, more than 20 ms) | REGRESSION, reproduced |

Frame rate and rebuffering passed in both. The tracked markers moved with the delay (`manifestMs` +144 ms and `loadedMs` +142 ms in `chromium`): the manifest request now starts 150 ms later.

## What it shows, and what it does not

- **It shows** that a regression no functional test sees fails the merge, with the numbers of both sides from one machine and the confirm-on-regression batch reproducing it: exit 1, a red required check.
- **The sensitivity depends on the profile, and the low-end one is at its edge.** The same 150 ms is +240 % of a Chromium startup and only +33 % of the throttled profile's, because the CPU throttle slows the CPU-bound work of startup and not a timer: the regression added 88 ms there, the first batch was 8 ms over the allowance, and **the fresh batch was over it by 0.65 ms** (80.65 ms against 80 ms). A regression a little smaller than this one would have passed the low-end leg; the regression of a CPU-bound kind is what that profile is for (the workstation's sweep, [sensitivity/summary.md](sensitivity/summary.md), has CPU slowdowns).
- **It is one regression of one size on one day.** It is not a sweep, and no claim about the smallest regression the gate catches on GitHub runners is made from it. The sweep of sizes was done on the workstation with the committed-baseline gate, not with the paired one.
- The Firefox leg's failure is an infrastructure fault that the same run exposed (`flake gate: reports/flake/reports-firefox: no such file or directory`, exit 2, because the leg never ran a test); the setup action was fixed in pull request #15, and it is the reason this run is not a clean "only perf failed" demonstration.
