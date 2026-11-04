# docs/results/ab

The results of the A/B harness ([docs/AB.md](../../AB.md), ADR-140 to ADR-149 in [decisions/ab.md](../../decisions/ab.md)). Each run writes three files here: `<id>.<environment>.<start>.raw.json` (every session, with the plan embedded), `.report.json` and `.report.md`; the report can be regenerated from the raw file with `npm run ab -- --report`, byte for byte.

## `pipeline-check/`: plumbing only, not evidence

[`pipeline-check/`](pipeline-check/pipeline-check.local-darwin-arm64.20261104T164641Z.report.md) is the output of the one real run of Part 1: **a pipeline check**. It exists to show that the harness runs end to end on a real machine, and for nothing else.

- **What it is.** Six sessions of configuration A and B interleaved in one condition (`high-latency`), in Chromium: one warm-up block and two measured blocks, so **two measured sessions per arm**. Plan: [`ab/prereg/pipeline-check.json`](../../../ab/prereg/pipeline-check.json), committed before the run. Command: `npm run ab -- --prereg ab/prereg/pipeline-check.json --port 4720 --out-dir docs/results/ab/pipeline-check`, at commit `1dce76c`, on `local-darwin-arm64` (macOS, 12 CPUs, 16 GiB).
- **Why its numbers mean nothing.** Two sessions per arm cannot say anything about the configurations, and the workstation was shared with two other agents running browsers (1-minute load average 4.0 before the first session and 4.6 after, on 12 CPUs). The report prints its statistics only to show that the report works, prints **no verdict**, and says "pipeline check, plumbing only, not evidence" in its title, its banner, its validity line and the summary the command prints.
- **Nothing was tuned from it.** No threshold, number of sessions, margin or level of the harness was set, changed or checked against these numbers.
- **What it proved.** The service starts as a child process, the player page is built, one Chromium runs the sessions with the arms interleaved, every page reports the configuration of its arm, the service reports the rules it held and the number of requests each fired on, git says the plan was committed before the run, the statistics and the report are produced, and the report is regenerated identically from the raw results. What it found while doing so is in ADR-145 and the intro of [decisions/ab.md](../../decisions/ab.md).

The experiments and the pilots of Part 2 are written next to this folder, one set of files per run, and their reports say, in their validity section, whether the run can be trusted.
