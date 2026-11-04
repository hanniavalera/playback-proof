# Live-event readiness: what the evidence says

The readiness checks (PB-RDY-001 to PB-RDY-004) and the soak (PB-RDY-005) of [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 8 were run on GitHub's
hosted runners, 18 jobs of `measure.yml` on commit `0d62c1d` (the first evidence, which most of this page is about): the readiness checks in Chromium,
Firefox and WebKit on Linux and in WebKit on macOS, each for configuration A (Shaka Player 5.3.3 with its defaults, what ships) and for one candidate
(`live-sync`: `streaming.liveSync.enabled` and nothing else), and 14 soaks of 5 and 30 minutes of the same two configurations. Six more jobs on commit
`e0a5be3` (the extra runs: four 8-minute soaks with a stale manifest and nothing else, and two readiness runs over HLS) answer two questions that the first
evidence left open; they have a section of their own, "Extra runs", and everything above it is about the first evidence. Where each file comes from
(run, runner, CPU, load) is in the [manifest](results/readiness/README.md); the decisions behind this page are
[ADR-159a to ADR-159e](decisions/readiness-evidence.md); the checks themselves are [ADR-150 to ADR-159](decisions/readiness.md). Every number
below is read from the committed files by `npm run results:docs` (the tables) or quoted from them (the sentences); the unit suite asserts the
headline ones against the files (`tests/unit/readiness/evidence.test.ts`).

**What this is not.** One run of each case, on localhost, against a synthetic live stream, on shared runners. These checks detect regressions and
pathologies (a player that never gets back to the live edge, a join that takes seconds, a manifest that stops refreshing). They do not
certify the latency, the start time or the stability that a viewer gets on a real network and a real CDN, and no number here is a forecast
of one.

## The result

<!-- BEGIN:READINESS_VERDICTS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | PB-RDY-001 | PB-RDY-002 | PB-RDY-003 | PB-RDY-004 | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | A | GO | GO | NO-GO | GO | NO-GO |
| chromium 156.0.8078.4 | live-sync | GO | GO | GO | GO | GO |
| firefox 157.0 | A | GO | GO | NO-GO | GO | NO-GO |
| firefox 157.0 | live-sync | GO | GO | GO | GO | GO |
| webkit 27.2 | A | GO | GO | NO-GO | GO | NO-GO |
| webkit 27.2 | live-sync | GO | GO | GO | GO | GO |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| Engine | Configuration | PB-RDY-001 | PB-RDY-002 | PB-RDY-003 | PB-RDY-004 | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| webkit 27.2 | A | GO | GO | NO-GO | GO | NO-GO |
| webkit 27.2 | live-sync | GO | GO | GO | GO | GO |
<!-- END:READINESS_VERDICTS -->

- **Configuration A is NO-GO in every run of the first evidence, and on one line only: PB-RDY-003, latency restored after the origin stalls.** PB-RDY-001 (start),
  PB-RDY-002 (latency in steady state) and PB-RDY-004 (manifest cadence) are GO on every engine, with wide margins (below).
- **The candidate `live-sync` is GO on every check in every run of the first evidence.**
- The exit code of `npm run readiness` is the verdict of A, so every one of these runs exited 1: that is the result, not a failure of the run.
- The 14 soaks were all GO when they were measured. By the criteria of today 8 are NO-GO: the 7 soaks of A and the 30-minute WebKit soak of the
  candidate (the latency level after the faults became a criterion of PB-RDY-005 after these files were measured, [ADR-159c](decisions/readiness-evidence.md);
  the files are not touched, they are judged again).

## The finding: after an origin stall the defaults never get back to the live edge (PB-RDY-003)

The check stops the origin for 10 s while a session plays, lets the player resume, and watches the latency for at least 65 s. The stall
(the limit is 14 s) is not the problem: the player recovers by itself in every run. The latency is.

<!-- BEGIN:READINESS_RESTORE -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Latency before the outage | Stall after the outage | Latency when the observation ended | Observed | Back under the maximum after | Back at its own level after | Highest playback rate | Verdict (the limit is the absolute reading) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | A | 6.07 s | 4.96 s | 11.01 to 11.02 s | 65.05 to 65.08 s | no run of 3 | no run of 3 | 1 | NO-GO |
| chromium 156.0.8078.4 | live-sync | 6.06 s | 4.95 to 4.96 s | 7.48 to 7.49 s | 35.54 s | 11.00 to 11.01 s | 30.09 to 30.10 s | 1.1 | GO |
| firefox 157.0 | A | 6.08 s | 4.08 to 4.14 s | 10.17 to 11.01 s | 65.01 to 65.84 s | no run of 3 | no run of 3 | 1 | NO-GO |
| firefox 157.0 | live-sync | 6.06 to 6.08 s | 4.08 to 4.11 s | 7.46 to 7.47 s | 27.30 to 36.34 s | 2.76 to 11.80 s | 21.84 to 30.88 s | 1.1 | GO |
| webkit 27.2 | A | 6.17 to 6.18 s | 3.98 to 4.01 s | 10.15 to 10.20 s | 65.97 s | no run of 3 | no run of 3 | 1 | NO-GO |
| webkit 27.2 | live-sync | 6.16 to 6.19 s | 3.98 to 3.99 s | 7.55 to 7.57 s | 26.37 to 26.38 s | 2.73 to 2.74 s | 20.92 s | 1.1 | GO |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| Engine | Configuration | Latency before the outage | Stall after the outage | Latency when the observation ended | Observed | Back under the maximum after | Back at its own level after | Highest playback rate | Verdict (the limit is the absolute reading) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| webkit 27.2 | A | 6.38 to 6.55 s | 3.88 to 4.83 s | 10.43 to 11.50 s | 65.02 to 65.08 s | no run of 3 | no run of 3 | 1 | NO-GO |
| webkit 27.2 | live-sync | 6.36 to 6.42 s | 3.83 to 3.91 s | 7.75 to 7.81 s | 28.49 to 29.42 s | 6.67 to 7.60 s | 23.04 to 23.97 s | 1.1 | GO |
<!-- END:READINESS_RESTORE -->

- **A: the latency stays where the outage put it.** Before the outage it is 6.07 to 6.18 s behind the live edge on Linux (6.38 to 6.55 s on
  macOS); the stall after the outage is 3.98 to 4.96 s on Linux (3.88 to 4.83 s on macOS); when the observation ends, at least 65 s after the
  resume, the player is 10.15 to 11.02 s behind on Linux (10.43 to 11.50 s on macOS), which is above the 10 s maximum, and its playback rate never
  went above 1. It is a step and not a drift: the line does not slope, it sits at a new level. Nothing reports it: the 14 soaks recorded no error at all
  (`errors` is empty in every file), the 7 of A included.
- **What it means for a live event.** A viewer who lived through a 10 s outage of the origin is 4 to 5 s further behind the live edge than one who
  did not, and stays there for as long as they watch. The 30-minute soaks show the delays adding up: from 6.10 to 6.16 s before the outage at
  minute 10, to 10.58 to 10.94 s after it, to 11.38 s (Firefox), 12.47 s (Chromium) and 12.79 s (WebKit) after the stale manifest at minute 20.
  Anything the audience shares in real time (a score, a countdown, the chat) is then ahead of the people who stalled by the sum of their stalls.
  This paragraph is the reasoning from the measurement; the measurement is the table.
- **`live-sync` restores it.** The player plays at up to 1.1x (the highest rate in every run was 1.1), gains 0.1 s per second, is back under the
  maximum within 2.73 to 11.80 s on Linux (6.67 to 7.60 s on macOS) and back within 2 s of its own level before the outage within 20.92 to 30.88 s
  on Linux (23.04 to 23.97 s on macOS). It does not return to exactly where it was: it ends the observation 1.38 to 1.43 s above its level before
  the outage in all 12 runs, and in the soaks it settles at 6.99 to 7.04 s in five of the six on Linux (the sixth is the WebKit soak below) and at
  7.42 to 7.49 s on macOS, against 6.11 to 6.35 s before the first fault in the same soaks on Linux.
- **The two readings of "restored" agree.** The criterion is absolute (back under 10 s and held for 5 s, within 60 s of the resume); the line next to it
  is relative (back within 2 s of the session's own level before the outage). They gave the same answer in all 24 runs of these DASH files (the HLS
  runs under "Extra runs" have one run in 12 where they differ). They err in opposite
  directions: the absolute one has a thin margin for the NO-GO of A (WebKit on Linux ends 0.15 to 0.20 s above the maximum, because 6.17 s
  plus a 4 s stall is 10.15 s) and a wide one for the GO of the candidate (2.19 to 2.54 s under it); the relative one has a wide margin for A
  (the loss is 3.99 s and more against a tolerance of 2 s) and a narrower one for the candidate. The time to get back under the maximum
  depends on how far the stall left the latency above it (11 s on Chromium, 2.7 s on WebKit) and says little about the speed of the catch-up;
  the time to the own level does. The criterion is kept absolute because the requirement is absolute (ADR-159b).
- **A variance that is not explained.** In run 1 of A on Firefox the latency stepped up by a further 0.85 s within seven seconds of the resume
  (10.16 s at the resume, 11.01 s seven seconds later) and stayed there; runs 2 and 3 stayed at 10.17 and 10.22 s. The check records one stall per
  outage, so a second short interruption would not show; it was not investigated. A second case is in the HLS runs (run 1 of A on Chromium, under
  "Extra runs"): both are the first outage run of their job, and none of the other 34 outage runs of the 36 (24 DASH, 12 HLS) shows a jump of 0.5 s between two reads at a rate of 1.

## Chromium, Firefox and WebKit agree: what that shows and what it does not

The three engines on Linux, and WebKit on macOS, give the same verdict on every check of the first evidence for both configurations and the same mechanism for the
finding (the rate stays 1 and the latency keeps the stall's step for A; the rate goes to 1.1 and it comes back for the candidate). **What this
shows:** the finding is not a quirk of one engine's media pipeline; it is in what the player does when it is not told to catch up. **What it does
not show:** that the engines are independent witnesses (it is one player build, one stream, one lab, so a bug in the lab would be agreed upon by
all three); that anything is true of a real network; or that the small differences between engines are the engines'. The three readiness jobs
of Linux ran on three different CPU models (AMD EPYC 9V45, AMD EPYC 9V74 and Intel Xeon Platinum 8370C: the manifest has one column for it) and the soak
of A and the soak of the candidate of one engine did not share a CPU model in any of the 6 pairs on Linux, so a start time of 65 ms against 404 ms, or a latency of 6.99 s
against 7.04 s, is not attributable to an engine or to a configuration from this evidence. The stall after the outage is engine-specific
(4.96 s on Chromium, 4.08 to 4.14 s on Firefox, 3.98 to 4.01 s on WebKit for the same 10 s outage); why was not investigated. What is
attributable is the difference of 4 to 5 s between A and the candidate, which is far outside any of that.

## The macOS WebKit run, and the load

The macOS runner had just booted when its jobs began: the harness read a 1-minute load average of 66.39 (readiness) and of 81.33 and 62.65 (the
two soaks) on 3 CPUs before its runs, and 3.07, 9.84 and 10.91 after them; the workflow's own `uptime` says the same ("up 1 min" or "up 2 mins", load
67.93 to 88.23). **What the harness did about it: it recorded and did nothing else.** The two readings (`load.before`, `load.after`, one per run) are
in the result file; it did not wait for the machine to quiet down, did not refuse to start and did not let the load touch a verdict. The Linux
runners read 0.27 to 1.89 before their runs and 0.14 to 2.36 after them (4 CPUs). On this branch the checklist now says it, ` [busy at the start: load 66.4
on 3 CPUs]` after the result's line, and the sheet has a line for it, for a start above one per CPU ([ADR-159e](decisions/readiness-evidence.md)), and so does the manifest; nothing
waits and nothing is excluded.

What the macOS numbers allow: the verdicts agree with Linux (A NO-GO on PB-RDY-003, the candidate GO, the soaks of A over the latency limit). The
level before the outage is higher (6.38 to 6.55 s against 6.17 to 6.18 s for WebKit on Linux), and the highest ratio of dropped frames of all 14 soaks is
the candidate's on macOS (0.49 %, against 0.09 % for A, whose soak started at the higher load of the two): the load did not order them, and with
one run of each, whether it moved any number cannot be told. **These rows are measured on a runner that began busy: they confirm the verdicts,
they are not a baseline, and they are never compared with the Linux rows** (two environments).

## The soaks

<!-- BEGIN:READINESS_SOAKS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Length, and what was injected | Verdict as measured | Verdict by today's criteria | Rebuffer ratio | Latency drift over the soak | Latency p95 / maximum after the faults | JS heap growth | Dropped frames | Unexplained errors, critical / recoverable | Unrecovered stalls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | A | 5 min; outage at minute 2.5 | GO | NO-GO | 0.00 % | 0.1 ms (slope -2 ms/h) | 10.62 s / 10.62 s | 0.11 MB | 0.02 % | 0 / 0 | 0 |
| chromium 156.0.8078.4 | live-sync | 5 min; outage at minute 2.5 | GO | GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 6.99 s / 6.99 s | 0.11 MB | 0.04 % | 0 / 0 | 0 |
| chromium 156.0.8078.4 | A | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | GO | NO-GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 12.47 s / 12.47 s | 0.54 MB | 0.01 % | 0 / 0 | 0 |
| chromium 156.0.8078.4 | live-sync | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | GO | GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 6.99 s / 6.99 s | 0.56 MB | 0.01 % | 0 / 0 | 0 |
| firefox 157.0 | A | 5 min; outage at minute 2.5 | GO | NO-GO | 0.00 % | 23.5 ms (slope 352 ms/h) | 11.13 s / 11.13 s | not measured | 0.00 % | 0 / 0 | 0 |
| firefox 157.0 | live-sync | 5 min; outage at minute 2.5 | GO | GO | 0.00 % | 11.8 ms (slope 177 ms/h) | 7.04 s / 7.04 s | not measured | 0.00 % | 0 / 0 | 0 |
| firefox 157.0 | A | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | GO | NO-GO | 0.00 % | 8.1 ms (slope -17 ms/h) | 11.39 s / 11.40 s | not measured | 0.00 % | 0 / 0 | 0 |
| firefox 157.0 | live-sync | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | GO | GO | 0.00 % | 22.5 ms (slope -46 ms/h) | 7.02 s / 7.04 s | not measured | 0.01 % | 0 / 0 | 0 |
| webkit 27.2 | A | 5 min; outage at minute 2.5 | GO | NO-GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 10.82 s / 10.82 s | not measured | 0.00 % | 0 / 0 | 0 |
| webkit 27.2 | live-sync | 5 min; outage at minute 2.2 | GO | GO | 0.00 % | 0.1 ms (slope -1 ms/h) | 6.99 s / 6.99 s | not measured | 0.00 % | 0 / 0 | 0 |
| webkit 27.2 | A | 30 min; outage at minute 9.9 and stale manifest at minute 20.0 | GO | NO-GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 12.79 s / 12.79 s | not measured | 0.00 % | 0 / 0 | 0 |
| webkit 27.2 | live-sync | 30 min; outage at minute 9.9 and stale manifest at minute 20.0 | GO | NO-GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 12.49 s / 12.49 s | not measured | 0.01 % | 0 / 0 | 0 |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| Engine | Configuration | Length, and what was injected | Verdict as measured | Verdict by today's criteria | Rebuffer ratio | Latency drift over the soak | Latency p95 / maximum after the faults | JS heap growth | Dropped frames | Unexplained errors, critical / recoverable | Unrecovered stalls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| webkit 27.2 | A | 5 min; outage at minute 2.4 | GO | NO-GO | 0.00 % | 0.7 ms (slope -10 ms/h) | 11.08 s / 11.08 s | not measured | 0.09 % | 0 / 0 | 0 |
| webkit 27.2 | live-sync | 5 min; outage at minute 2.4 | GO | GO | 0.00 % | 0.2 ms (slope 3 ms/h) | 7.42 s / 7.49 s | not measured | 0.49 % | 0 / 0 | 0 |
<!-- END:READINESS_SOAKS -->

- **Every criterion but one is GO with a wide margin in all 14.** No rebuffering (0.00 %), no unrecovered stall, no critical error and none that no
  injected fault explains, a fitted drift of at most 23.5 ms over the soak (slopes from -46 to +352 ms per hour) against a limit of 1 s, and dropped
  frames from 0.00 % to 0.49 % against 1 %. Chromium's JS heap grew 0.11 MB in the 5-minute soaks and 0.54 to 0.56 MB in the 30-minute ones against
  20 MB. **The heap is the page's JS heap after a forced collection, read through the browser's debugging protocol: it is not the player's memory**
  (decoded frames, media buffers and the native side are outside it), and Firefox and WebKit have no such reading (`not measured`). A leak in
  anything but the JS heap would not show.
- **The one that is not: the latency level.** In the 7 soaks of A the latency after the faults is 10.62 to 12.79 s (p95 and maximum within 0.02 s of
  each other: the player sits at one level), against 8 s and 10 s. The 30-minute soak of the candidate on WebKit on Linux is at 12.49 s. See the gap below.
- **The stale manifest.** In the 30-minute soaks the origin serves a stale manifest for 10 s at minute 20. The stall it causes is 1.54, 0.40 and 2.21 s for
  A (Chromium, Firefox, WebKit) and 5.43, 6.18 and 5.49 s for the candidate. The reason offered when this page was first written was a hypothesis, not a
  measurement: the candidate sits closer to the edge (about 7 s against 10.6 to 10.9 s) and has less buffered when the manifest goes stale. The extra runs
  test it ("Extra runs", question 1): with no outage before it, A stalls as long as the candidate, and the stall follows the buffer. In WebKit on Linux the
  candidate did not come back from it (below); that was not reproduced by the extra run.
- **An observation I cannot explain.** The 5-minute soak of the candidate on WebKit on Linux took 319 s and its outage fell at minute 2.2 where the other
  soaks have it at 2.4 to 2.5: the first frame came late. The result is GO either way; I did not find the cause.

## The gap: the soak was GO for A while PB-RDY-003 is NO-GO for A

Both are true. They answer different questions: PB-RDY-003 asks whether the player gets back after an outage, within 65 s; the soak asked whether
the session degraded over time (a drift, a leak, a stall, a dropped frame). A player that falls 4 to 5 s behind and stays there does not drift,
leak, stall or drop frames, so the soak, as it was specified, could not see it, and its own latency lines (advisory) said NO-GO in 7 files out of
7. **Decision: the latency level is now a criterion of the soak** ([ADR-159c](decisions/readiness-evidence.md)): the p95 and the maximum of the reads after the
warm-up, outside every fault and the 74 s the policy gives the player to settle after it, against the limits of PB-RDY-002, from at least 20 reads.
The evidence for it is the 7 soaks of A, and one soak that no other check could have caught: the candidate on WebKit on Linux, GO on every criterion
and on PB-RDY-003, sat at 12.49 s from minute 20.2 to the end after the stale manifest (the player reported a rate of 1.1 and its media clock
advanced at 1.00 s per second). **What a reader must not conclude from "soak GO":** that the player came back
from a fault in the time PB-RDY-003 allows (the soak looks at the level 74 s after the fault, not at the speed); that nothing leaked (the heap is the JS heap, in
Chromium, after a forced collection); that an event of hours is safe (the soaks are 5 and 30 minutes with one outage and, in the long one, one stale manifest);
that the stream, the network or the load resemble an event's.

## Margins, and the limits

<!-- BEGIN:READINESS_MARGINS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Line | Configuration | chromium 156.0.8078.4 | firefox 157.0 | webkit 27.2 |
| --- | --- | --- | --- | --- |
| PB-RDY-001 start time, worst of the joins | A | 65 ms (margin 4.94 s) | 119 ms (margin 4.88 s) | 404 ms (margin 4.60 s) |
| PB-RDY-001 start time, worst of the joins | live-sync | 57 ms (margin 4.94 s) | 75 ms (margin 4.92 s) | 246 ms (margin 4.75 s) |
| PB-RDY-002 latency, p95 | A | 6.07 s (margin 1.93 s) | 6.10 s (margin 1.90 s) | 6.17 s (margin 1.83 s) |
| PB-RDY-002 latency, p95 | live-sync | 6.07 s (margin 1.93 s) | 6.09 s (margin 1.91 s) | 6.17 s (margin 1.83 s) |
| PB-RDY-002 latency, maximum | A | 6.07 s (margin 3.93 s) | 6.13 s (margin 3.87 s) | 6.17 s (margin 3.83 s) |
| PB-RDY-002 latency, maximum | live-sync | 6.07 s (margin 3.93 s) | 6.10 s (margin 3.90 s) | 6.17 s (margin 3.83 s) |
| PB-RDY-003 stall after the outage, worst run | A | 4.96 s (margin 9.04 s) | 4.14 s (margin 9.86 s) | 4.01 s (margin 9.99 s) |
| PB-RDY-003 stall after the outage, worst run | live-sync | 4.96 s (margin 9.04 s) | 4.11 s (margin 9.89 s) | 3.99 s (margin 10.01 s) |
| PB-RDY-003 time to restore the latency, worst run | A | at least 65.08 s (over by at least 5.08 s) | at least 65.84 s (over by at least 5.84 s) | at least 65.97 s (over by at least 5.97 s) |
| PB-RDY-003 time to restore the latency, worst run | live-sync | 11.01 s (margin 48.99 s) | 11.80 s (margin 48.20 s) | 2.74 s (margin 57.26 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | A | 11.01 to 11.02 s (over by 1.01 to 1.02 s) | 10.17 to 11.01 s (over by 0.17 to 1.01 s) | 10.15 to 10.20 s (over by 0.15 to 0.20 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | live-sync | 7.48 to 7.49 s (margin 2.51 to 2.52 s) | 7.46 to 7.47 s (margin 2.53 to 2.54 s) | 7.55 to 7.57 s (margin 2.43 to 2.45 s) |
| PB-RDY-004 manifest refresh, median gap | A | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) |
| PB-RDY-004 manifest refresh, median gap | live-sync | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) |
| PB-RDY-004 manifest refresh, longest gap | A | 2.00 s (margin 2.00 s) | 2.02 s (margin 1.98 s) | 2.00 s (margin 2.00 s) |
| PB-RDY-004 manifest refresh, longest gap | live-sync | 2.00 s (margin 2.00 s) | 2.00 s (margin 2.00 s) | 2.00 s (margin 2.00 s) |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| Line | Configuration | webkit 27.2 |
| --- | --- | --- |
| PB-RDY-001 start time, worst of the joins | A | 376 ms (margin 4.62 s) |
| PB-RDY-001 start time, worst of the joins | live-sync | 226 ms (margin 4.77 s) |
| PB-RDY-002 latency, p95 | A | 6.37 s (margin 1.63 s) |
| PB-RDY-002 latency, p95 | live-sync | 6.39 s (margin 1.61 s) |
| PB-RDY-002 latency, maximum | A | 6.37 s (margin 3.63 s) |
| PB-RDY-002 latency, maximum | live-sync | 6.39 s (margin 3.61 s) |
| PB-RDY-003 stall after the outage, worst run | A | 4.83 s (margin 9.17 s) |
| PB-RDY-003 stall after the outage, worst run | live-sync | 3.91 s (margin 10.09 s) |
| PB-RDY-003 time to restore the latency, worst run | A | at least 65.08 s (over by at least 5.08 s) |
| PB-RDY-003 time to restore the latency, worst run | live-sync | 7.60 s (margin 52.40 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | A | 10.43 to 11.50 s (over by 0.43 to 1.50 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | live-sync | 7.75 to 7.81 s (margin 2.19 to 2.25 s) |
| PB-RDY-004 manifest refresh, median gap | A | 2.00 s (margin 1.00 s) |
| PB-RDY-004 manifest refresh, median gap | live-sync | 2.00 s (margin 1.00 s) |
| PB-RDY-004 manifest refresh, longest gap | A | 2.32 s (margin 1.68 s) |
| PB-RDY-004 manifest refresh, longest gap | live-sync | 2.00 s (margin 2.00 s) |

**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Length, and what was injected | Rebuffer ratio | Latency drift | Latency p95 | Latency maximum | JS heap growth | Dropped frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | A | 5 min; outage at minute 2.5 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 10.62 s (over by 2.62 s) | 10.62 s (over by 619 ms) | 0.11 MB (margin 19.89 MB) | 0.02 % (margin 0.98 %) |
| chromium 156.0.8078.4 | live-sync | 5 min; outage at minute 2.5 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 6.99 s (margin 1.01 s) | 6.99 s (margin 3.01 s) | 0.11 MB (margin 19.89 MB) | 0.04 % (margin 0.96 %) |
| chromium 156.0.8078.4 | A | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 12.47 s (over by 4.47 s) | 12.47 s (over by 2.47 s) | 0.54 MB (margin 19.46 MB) | 0.01 % (margin 0.99 %) |
| chromium 156.0.8078.4 | live-sync | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 6.99 s (margin 1.01 s) | 6.99 s (margin 3.01 s) | 0.56 MB (margin 19.44 MB) | 0.01 % (margin 0.99 %) |
| firefox 157.0 | A | 5 min; outage at minute 2.5 | 0.00 % (margin 0.50 %) | 23 ms (margin 977 ms) | 11.13 s (over by 3.13 s) | 11.13 s (over by 1.13 s) | not measured | 0.00 % (margin 1.00 %) |
| firefox 157.0 | live-sync | 5 min; outage at minute 2.5 | 0.00 % (margin 0.50 %) | 12 ms (margin 988 ms) | 7.04 s (margin 964 ms) | 7.04 s (margin 2.96 s) | not measured | 0.00 % (margin 1.00 %) |
| firefox 157.0 | A | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 8 ms (margin 992 ms) | 11.39 s (over by 3.39 s) | 11.40 s (over by 1.40 s) | not measured | 0.00 % (margin 1.00 %) |
| firefox 157.0 | live-sync | 30 min; outage at minute 10.0 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 22 ms (margin 978 ms) | 7.02 s (margin 980 ms) | 7.04 s (margin 2.96 s) | not measured | 0.01 % (margin 0.99 %) |
| webkit 27.2 | A | 5 min; outage at minute 2.5 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 10.82 s (over by 2.82 s) | 10.82 s (over by 823 ms) | not measured | 0.00 % (margin 1.00 %) |
| webkit 27.2 | live-sync | 5 min; outage at minute 2.2 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 6.99 s (margin 1.01 s) | 6.99 s (margin 3.01 s) | not measured | 0.00 % (margin 1.00 %) |
| webkit 27.2 | A | 30 min; outage at minute 9.9 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 12.79 s (over by 4.79 s) | 12.79 s (over by 2.79 s) | not measured | 0.00 % (margin 1.00 %) |
| webkit 27.2 | live-sync | 30 min; outage at minute 9.9 and stale manifest at minute 20.0 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 12.49 s (over by 4.49 s) | 12.49 s (over by 2.49 s) | not measured | 0.01 % (margin 0.99 %) |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| Engine | Configuration | Length, and what was injected | Rebuffer ratio | Latency drift | Latency p95 | Latency maximum | JS heap growth | Dropped frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| webkit 27.2 | A | 5 min; outage at minute 2.4 | 0.00 % (margin 0.50 %) | 1 ms (margin 999 ms) | 11.08 s (over by 3.08 s) | 11.08 s (over by 1.08 s) | not measured | 0.09 % (margin 0.91 %) |
| webkit 27.2 | live-sync | 5 min; outage at minute 2.4 | 0.00 % (margin 0.50 %) | 0 ms (margin 1.00 s) | 7.42 s (margin 582 ms) | 7.49 s (margin 2.51 s) | not measured | 0.49 % (margin 0.51 %) |
<!-- END:READINESS_MARGINS -->

The margin of a line is how far its value is from its limit. The limits are **requirements** of a live event (the strategy's policy, set
before any measurement); the margins are **measurements** of this lab. The margins are huge on localhost with a synthetic stream (a join of 57 to 404 ms against
5 s; a p95 latency of 6.07 to 6.39 s against 8 s), and lowering the limits to the measured values would be tuning the test to pass: a limit of 2 s on a join would
pass these runs and say nothing about an event. So no limit was changed ([ADR-159b](decisions/readiness-evidence.md)); the one question that data could answer, whether a limit is
unreachable or meaningless, has the answer no for all of them: the one the defaults cannot meet (restored within 60 s) is met by the candidate. The thin margins of the first evidence are the ones to read:
the NO-GO of A on the absolute reading of PB-RDY-003 on WebKit (0.15 s), the candidate's soak p95 against 8 s on macOS (0.58 s), the dropped frames of that soak
(0.49 % against 1 %), and the NO-GO of the soak of A on Chromium (0.62 s over the maximum, in the 5-minute soak). The HLS runs have a thinner one than any of them
(0.02 s, for A on Chromium: "Extra runs", question 2).

## The candidate: what `live-sync` is and is not

It is one knob (`streaming.liveSync.enabled`), one candidate, evaluated on one synthetic stream. What the readiness result says is that the candidate
passes the checks that the defaults fail. It is **not the decision to ship it**: TEST_STRATEGY section 8 requires an A/B decision on record for every configuration change before an event, and
what would be that decision is an A/B pre-registration on live latency in the style of PB-AB-002 and PB-AB-003 (a pre-registered metric, an effect size and an interval, with the
stale-manifest stall and the start time as the guard metrics): it has not been run ([ADR-159d](decisions/readiness-evidence.md)). What the first evidence seemed to show against the candidate, and
what the extra runs say of it: its stale-manifest stall was 3.3 to 5.8 s longer than the defaults' in the 30-minute soaks, but A stalls as long at the same latency, so that is not a
cost of the candidate as such but of sitting closer to the edge with less buffered (the extra runs, question 1); it settles 0.6 to 0.9 s above its level before the first fault (the extra runs
agree: 6.99 to 7.00 s in the last minute against 6.10 to 6.23 s before the fault); and on WebKit on Linux it did not come back from the stale manifest in the 30-minute soak, and did in an isolated one (not explained).

## Extra runs: the stale manifest on its own, and HLS

Six more jobs of `measure.yml` were dispatched from `main` at commit `e0a5be3` (runner `ubuntu-24.04`, environment `gha-linux-x64`, started between 18:59 and
19:01 UTC on 2026-11-04) to answer what the first evidence left open. Four are soaks of 8 minutes with `--no-stall --stale-at-minutes 2`: no outage, one stale
manifest of 10 s at minute 2, and about 68 reads left outside the warm-up and the 74 s of settling. Two are readiness runs over HLS (`--candidate live-sync
--protocol hls`). The [manifest](results/readiness/README.md) lists them as batch `extra`, with the arguments each was dispatched with. They were uploaded under the
names of the first batch (the soak of A and the soak of the candidate on WebKit both as `…-webkit-8m.json`, the HLS files under the names of the DASH ones), so
they are committed under the names of [ADR-159a](decisions/readiness-evidence.md) (`…-8m-nostall-stale2m[-live-sync].json`, `…-<engine>-hls.json`) and nothing collides.
The same rules hold: byte for byte as uploaded, one run of each case, shared runners. The soak of A and the soak of the candidate on WebKit ran on different CPU
models (AMD EPYC 9V45 and EPYC 9V74), and each HLS job ran on another CPU model than the DASH job of the same engine (Chromium: Intel Xeon Platinum 8370C against
EPYC 9V45; WebKit: EPYC 7763 against the Xeon), so a small difference between two of these runs is not attributable to what differs in their arguments.

**These soaks predate the criterion, and can still be judged by it.** `main` at `e0a5be3` has no soak latency-level criterion (ADR-159c is not on it), so the four files carry
`soak.latency-p95` and `soak.latency-max` as advisory lines, as the first evidence does. They also carry what the criterion needs: the series of an 8-minute soak is whole
(`series.sampleCount` equals the samples stored, 96 or 97), the stored lines were computed outside the settling window from 67 or 68 reads (the criterion needs 20), and the criterion's
own code, run over the stored series, gives exactly the stored values for all four (a test does it, to the last digit). So the criterion is applied to them from the files, by
`soakVerdictToday`, as to the first evidence: the verdicts below are the one measured and the one of today, and no file is touched.

### 1. After a stale manifest on its own, does each engine's latency come back?

<!-- BEGIN:EXTRA_STALE_RECOVERY -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Injected | Latency before the fault | Stall | Highest latency after the fault began | Back under 10 s after the fault ended | Within 2 s of its own level after the fault ended | Latency in the last minute |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | live-sync | stale manifest at minute 2.0 | 6.10 s | 6.44 s | 12.31 s | 30 s | 50 s | 6.99 s |
| firefox 157.0 | live-sync | stale manifest at minute 2.0 | 6.15 s | 6.54 s | 12.24 s | 30 s | 50 s | 7.00 s |
| webkit 27.2 | A | stale manifest at minute 2.0 | 6.13 s | 6.49 s | 12.63 s | not by the end of the soak | not by the end of the soak | 12.63 s |
| webkit 27.2 | live-sync | stale manifest at minute 2.0 | 6.23 s | 6.64 s | 12.61 s | 36 s | 51 s | 6.99 s |
<!-- END:EXTRA_STALE_RECOVERY -->

<!-- BEGIN:EXTRA_SOAKS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Length, and what was injected | Verdict as measured | Verdict by today's criteria | Rebuffer ratio | Latency drift over the soak | Latency p95 / maximum after the faults | JS heap growth | Dropped frames | Unexplained errors, critical / recoverable | Unrecovered stalls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | live-sync | 8 min; stale manifest at minute 2.0 | GO | GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 6.99 s / 6.99 s | 0.26 MB | 0.03 % | 0 / 0 | 0 |
| firefox 157.0 | live-sync | 8 min; stale manifest at minute 2.0 | GO | GO | 0.00 % | 1.8 ms (slope 15 ms/h) | 7.03 s / 7.03 s | not measured | 0.00 % | 0 / 0 | 0 |
| webkit 27.2 | A | 8 min; stale manifest at minute 2.0 | GO | NO-GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 12.63 s / 12.63 s | not measured | 0.00 % | 0 / 0 | 0 |
| webkit 27.2 | live-sync | 8 min; stale manifest at minute 2.0 | GO | GO | 0.00 % | 0.0 ms (slope 0 ms/h) | 6.99 s / 7.03 s | not measured | 0.00 % | 0 / 0 | 0 |
<!-- END:EXTRA_SOAKS -->

(The first table is read from the stored series, sampled every 5 s: a time is the first sample of the stretch that stays within the line to the end of the soak, so it is good to about 5 s.)

- **A on WebKit does not come back.** It was 6.13 s behind the edge, the stale manifest stalled it for 6.49 s, the latency went to 12.63 s and stayed there to the end of the
  soak, 350 s after the fault ended (the p95 and the maximum of the reads outside the settling window are both 12.63 s, against 8 s and 10 s, and the playback rate stayed
  1). That soak was GO when it was measured and is NO-GO by today's criteria, on the two latency lines. It is the same step as the defaults' after an outage (the finding above),
  from a different fault, and with no outage before it.
- **The candidate comes back on all three engines.** After a stall of 6.44 to 6.64 s the latency peaks at 12.24 to 12.61 s, the media clock advances at 1.10 s per second for
  about 50 s (the rate is 1.1 in the series), the latency is back under 10 s 30 s (Chromium, Firefox) and 36 s (WebKit) after the fault ended and within 2 s of its own level 50 to 51 s after
  it, and in the last minute it sits at 6.99 s (Chromium), 7.00 s (Firefox) and 6.99 s (WebKit): 0.76 to 0.89 s above its level before the fault (6.10 to 6.23 s), as after an
  outage in the first evidence. All three are GO by today's criteria (the p95 and the maximum are 6.99 to 7.03 s) and by the criteria they were measured with.
- **The open question of the first evidence is not reproduced.** The 30-minute WebKit soak of the candidate sat at 12.49 s after its stale manifest (and its media clock advanced at 1.00 s per
  second although the player reported 1.1). Here the same engine, with the same fault alone, caught up at 1.10 s per second and settled at 6.99 s. One run says that the stale manifest by itself
  is not enough to produce the non-return in that engine; it does not say whether it needs the outage that came 10 minutes before it in the long soak, whether it is rare (it happened in 1 of the 2
  WebKit soaks of the candidate that had a stale manifest), or whether it belongs to the machine (the long soak ran on an AMD EPYC 7763 and image `20261101.360.1`, this one on an EPYC 9V74
  and `20261026.354.1`). Its cause is still not known.
- **The stall follows the buffer, not the configuration.** In the first evidence the candidate stalled 3.3 to 5.8 s longer than A at the stale manifest (5.43, 6.18 and 5.49 s against 1.54, 0.40
  and 2.21 s). Here A, with no outage before it, stalls 6.49 s, as long as the candidate (6.44 to 6.64 s). Across the ten soaks of the two batches that had a stale manifest:

<!-- BEGIN:EXTRA_STALE_STALLS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Injected | Latency before the stale manifest | Media buffered ahead | Stall | Stall plus buffered ahead |
| --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 | live-sync | stale manifest at minute 2.0 | 6.10 s | 5.0 s | 6.44 s | 11.42 s |
| webkit 27.2 | A | stale manifest at minute 2.0 | 6.13 s | 4.8 s | 6.49 s | 11.31 s |
| firefox 157.0 | live-sync | stale manifest at minute 2.0 | 6.15 s | 5.0 s | 6.54 s | 11.51 s |
| webkit 27.2 | live-sync | stale manifest at minute 2.0 | 6.23 s | 4.4 s | 6.64 s | 11.00 s |
| chromium 156.0.8078.4 | live-sync | outage at minute 10.0 and stale manifest at minute 20.0 | 6.99 s | 5.9 s | 5.43 s | 11.31 s |
| firefox 157.0 | live-sync | outage at minute 10.0 and stale manifest at minute 20.0 | 6.99 s | 5.0 s | 6.18 s | 11.16 s |
| webkit 27.2 | live-sync | outage at minute 9.9 and stale manifest at minute 20.0 | 6.99 s | 5.3 s | 5.49 s | 10.75 s |
| webkit 27.2 | A | outage at minute 9.9 and stale manifest at minute 20.0 | 10.58 s | 8.9 s | 2.21 s | 11.12 s |
| firefox 157.0 | A | outage at minute 10.0 and stale manifest at minute 20.0 | 10.93 s | 10.0 s | 0.40 s | 10.44 s |
| chromium 156.0.8078.4 | A | outage at minute 10.0 and stale manifest at minute 20.0 | 10.94 s | 9.8 s | 1.54 s | 11.37 s |
<!-- END:EXTRA_STALE_STALLS -->

  the stall plus the media buffered ahead when it began is 10.44 to 11.51 s in every one: about the 10 s of the fault and a second. At 6.10 to 6.23 s behind the edge the buffer is 4.4 to 5.0 s and the
  stall 6.44 to 6.64 s; at about 7 s (the candidate after its outage in the 30-minute soaks) the buffer is 5.0 to 5.9 s and the stall 5.43 to 6.18 s; at 10.58 to 10.94 s (A after its outage) the
  buffer is 8.9 to 10.0 s and the stall 0.40 to 2.21 s. So the comparison of the 30-minute soaks was of a session at 7 s with one at 10.6 to 10.9 s, and A's shorter stall was the buffer of a
  player that had already fallen 4 to 5 s behind. That is the trade-off the A/B decision has to weigh ([ADR-159d](decisions/readiness-evidence.md)): a session closer to the edge has less buffered
  when the origin falters. These runs do not find it to be a defect of the candidate.
- **What this does not say.** One run per case, 8 minutes, one 10 s stale manifest, one synthetic stream. The relation between the stall and the buffer is an observation over ten soaks (`bufferedAheadSec` as
  the player reports it, the median of the reads in the 25 s before the fault; the 30-minute series are thinned, which changes the number of reads and no verdict), not a model of the player, and the
  cause of the WebKit non-return of the long soak is untouched by it. Linux WebKit is not Safari.

### 2. Do the DASH findings hold for HLS?

<!-- BEGIN:EXTRA_VERDICTS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | PB-RDY-001 | PB-RDY-002 | PB-RDY-003 | PB-RDY-004 | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 (hls) | A | GO | GO | NO-GO | GO | NO-GO |
| chromium 156.0.8078.4 (hls) | live-sync | GO | GO | GO | GO | GO |
| webkit 27.2 (hls) | A | GO | GO | NO-GO | GO | NO-GO |
| webkit 27.2 (hls) | live-sync | GO | GO | GO | GO | GO |
<!-- END:EXTRA_VERDICTS -->

<!-- BEGIN:EXTRA_RESTORE -->
**gha-linux-x64** (Linux X64, github-hosted):

| Engine | Configuration | Latency before the outage | Stall after the outage | Latency when the observation ended | Observed | Back under the maximum after | Back at its own level after | Highest playback rate | Verdict (the limit is the absolute reading) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium 156.0.8078.4 (hls) | A | 6.07 s | 3.97 to 4.10 s | 8.96 to 10.15 s | 65.06 to 65.08 s | 56.05 s in 1 of 3 runs | no run of 3 | 1 | NO-GO |
| chromium 156.0.8078.4 (hls) | live-sync | 6.07 s | 3.78 to 3.79 s | 7.45 to 7.46 s | 26.42 to 26.45 s | 0.97 to 1.89 s | 20.97 to 21.02 s | 1.1 | GO |
| webkit 27.2 (hls) | A | 6.17 to 6.20 s | 3.98 to 4.00 s | 10.17 to 10.19 s | 65.01 to 65.98 s | no run of 3 | no run of 3 | 1 | NO-GO |
| webkit 27.2 (hls) | live-sync | 6.17 to 6.19 s | 3.73 to 3.75 s | 7.57 to 7.62 s | 25.43 to 26.37 s | 1.79 to 2.73 s | 19.97 to 20.91 s | 1.1 | GO |
<!-- END:EXTRA_RESTORE -->

- **The verdicts hold, on Chromium and on WebKit.** A is NO-GO on PB-RDY-003 and nowhere else; the candidate is GO on all four checks. The mechanism is the same: A's playback rate stays 1 and the latency
  stays where the outage put it (10.17 to 10.19 s on WebKit after at least 65 s, against 10.15 to 10.20 s on DASH); the candidate plays at up to 1.1, is back within 2 s of its own level after 21.0 s
  (Chromium) and 20.0 to 20.9 s (WebKit), and ends the observation at 7.45 to 7.46 s and 7.57 to 7.62 s (DASH: 7.48 to 7.49 s and 7.55 to 7.57 s).
- **On Chromium the absolute reading barely discriminates.** The stall on HLS is shorter than on DASH (3.97 to 4.10 s for A against 4.96 s), so A's latency after the outage lands on the limit instead of 1 s above it:
  its first reads after the resume are 9.99, 10.11 and 9.98 s (about 6.07 s plus the stall), and the three runs end at 8.96, 10.15 and 10.02 s. The NO-GO of the line rests on runs 2 and 3, which end **0.15 and 0.02 s**
  over the maximum, and run 1 was judged restored: it sat at 10.03 s until 55 s after the resume, read 9.99 s at 56.05 s, and from 57 s its reads alternated once per second between 8.93 and 9.96 s (the
  rate stayed 1 and no stall was recorded; what that is I do not know: the reads move by a second at a time, which is not what a catch-up looks like). The line is the worst of three runs, so it stays NO-GO, but its verdict hangs on
  stalls that differ by hundredths of a second from the ones that would have made it GO for a player that never got back. The relative reading is NO-GO in all three runs: the latency ends 0.89, 2.08 and 1.95 s
  over its own level plus 2 s (8.07 s). The candidate's GO is thin the same way: its first read after the stall is 10.02 to 10.03 s, so "back under the maximum after 0.97 to 1.89 s" says almost nothing, and the
  21 s to its own level is what measures the catch-up. This is the weakness that [ADR-159b](decisions/readiness-evidence.md) names (the absolute reading depends on the level plus the stall), and it shows without a
  change of the healthy level (6.07 s in both protocols): through the stall alone. The criterion was not changed, nor any limit; see the addendum to that record.
- **The two readings disagree once in 12 HLS runs** (run 1 of A on Chromium, above), against none in 24 on DASH. The first outage run of a job is also where the one jump in a DASH run (Firefox, run 1 of A) is.
- **HLS starts are slower and everything else is the same.** The worst join is 108 ms (A) and 86 ms (candidate) on Chromium against 65 and 57 ms on DASH, and 525 and 271 ms on WebKit against 404 and 246 ms, with
  4.47 to 4.91 s of margin against 5 s. That is consistent with the three extra video segments an HLS join downloads for the closed-caption probe, which the start time includes (ADR-099, ADR-152); these runs
  do not test the cause. The p95 and the maximum of the latency are the same to 0.01 s (6.07 s on Chromium, 6.17 s on WebKit), and the manifest refresh is 2.00 s at the median and 2.02 to 2.04 s at the longest
  gap (DASH on the same engines: 2.00 s).

<!-- BEGIN:EXTRA_MARGINS -->
**gha-linux-x64** (Linux X64, github-hosted):

| Line | Configuration | chromium 156.0.8078.4 (dash) | chromium 156.0.8078.4 (hls) | webkit 27.2 (dash) | webkit 27.2 (hls) |
| --- | --- | --- | --- | --- | --- |
| PB-RDY-001 start time, worst of the joins | A | 65 ms (margin 4.94 s) | 108 ms (margin 4.89 s) | 404 ms (margin 4.60 s) | 525 ms (margin 4.47 s) |
| PB-RDY-001 start time, worst of the joins | live-sync | 57 ms (margin 4.94 s) | 86 ms (margin 4.91 s) | 246 ms (margin 4.75 s) | 271 ms (margin 4.73 s) |
| PB-RDY-002 latency, p95 | A | 6.07 s (margin 1.93 s) | 6.07 s (margin 1.93 s) | 6.17 s (margin 1.83 s) | 6.17 s (margin 1.83 s) |
| PB-RDY-002 latency, p95 | live-sync | 6.07 s (margin 1.93 s) | 6.07 s (margin 1.93 s) | 6.17 s (margin 1.83 s) | 6.17 s (margin 1.83 s) |
| PB-RDY-002 latency, maximum | A | 6.07 s (margin 3.93 s) | 6.08 s (margin 3.92 s) | 6.17 s (margin 3.83 s) | 6.17 s (margin 3.83 s) |
| PB-RDY-002 latency, maximum | live-sync | 6.07 s (margin 3.93 s) | 6.07 s (margin 3.93 s) | 6.17 s (margin 3.83 s) | 6.17 s (margin 3.83 s) |
| PB-RDY-003 stall after the outage, worst run | A | 4.96 s (margin 9.04 s) | 4.10 s (margin 9.90 s) | 4.01 s (margin 9.99 s) | 4.00 s (margin 10.01 s) |
| PB-RDY-003 stall after the outage, worst run | live-sync | 4.96 s (margin 9.04 s) | 3.79 s (margin 10.21 s) | 3.99 s (margin 10.01 s) | 3.75 s (margin 10.26 s) |
| PB-RDY-003 time to restore the latency, worst run | A | at least 65.08 s (over by at least 5.08 s) | at least 65.08 s (over by at least 5.08 s) | at least 65.97 s (over by at least 5.97 s) | at least 65.98 s (over by at least 5.98 s) |
| PB-RDY-003 time to restore the latency, worst run | live-sync | 11.01 s (margin 48.99 s) | 1.89 s (margin 58.11 s) | 2.74 s (margin 57.26 s) | 2.73 s (margin 57.27 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | A | 11.01 to 11.02 s (over by 1.01 to 1.02 s) | 8.96 to 10.15 s (over by 0.02 to 0.15 s in 2 of 3 runs, margin 1.04 s in the other) | 10.15 to 10.20 s (over by 0.15 to 0.20 s) | 10.17 to 10.19 s (over by 0.17 to 0.19 s) |
| PB-RDY-003 latency when the observation ended, each run against the maximum | live-sync | 7.48 to 7.49 s (margin 2.51 to 2.52 s) | 7.45 to 7.46 s (margin 2.54 to 2.55 s) | 7.55 to 7.57 s (margin 2.43 to 2.45 s) | 7.57 to 7.62 s (margin 2.38 to 2.43 s) |
| PB-RDY-004 manifest refresh, median gap | A | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) | 2.00 s (margin 1.00 s) | 2.00 s (margin 999 ms) |
| PB-RDY-004 manifest refresh, median gap | live-sync | 2.00 s (margin 1.00 s) | 2.00 s (margin 999 ms) | 2.00 s (margin 1.00 s) | 2.00 s (margin 999 ms) |
| PB-RDY-004 manifest refresh, longest gap | A | 2.00 s (margin 2.00 s) | 2.03 s (margin 1.97 s) | 2.00 s (margin 2.00 s) | 2.04 s (margin 1.96 s) |
| PB-RDY-004 manifest refresh, longest gap | live-sync | 2.00 s (margin 2.00 s) | 2.02 s (margin 1.98 s) | 2.00 s (margin 2.00 s) | 2.04 s (margin 1.96 s) |
<!-- END:EXTRA_MARGINS -->

- **What this does not say.** One run per case, on two engines (no Firefox and no macOS over HLS), on a synthetic stream, with the protocols on different CPU models (above). The differences in the stall
  between the two protocols (4.95 to 4.96 s on DASH against 3.78 to 4.10 s on HLS in Chromium; 3.98 to 4.01 s against 3.73 to 4.00 s in WebKit) are not attributed to the protocol.

### What these runs change in what is written above

- The longer stale-manifest stall of the candidate in the 30-minute soaks is the buffer at the time and not the candidate (question 1). The earlier reading in ADR-159d is corrected by an addendum there.
- The WebKit non-return after a stale manifest was seen once and is not reproduced by an isolated run: still unexplained, and no longer "the candidate fails to come back on WebKit".
- The NO-GO of A on the absolute reading of PB-RDY-003 is thin on HLS in Chromium (0.02 s): the choice of the absolute reading as the criterion is the owner's to review (addendum to ADR-159b).
- Every soak of A is NO-GO by today's criteria, 8 of 8 (the 7 of the first evidence and the 8-minute WebKit soak above).

## Reading the result files

For a program that renders tables from `docs/results/readiness/*.json` and `docs/results/soak/*.json` (nobody should parse prose, and nobody should parse a name).

**Names.** A readiness file is `<envId>-<engine>[-<protocol>].json` and holds A and the candidates of one run. A soak file is
`<envId>-<engine>-<minutes>m[-<injection plan>][-<protocol>][-<candidate>].json`: A's has no candidate part, and a soak of the policy's plan has no plan
part (ADR-159a). **Read the content, never the name**: the loader (`loadResults`, `src/lab/readiness/readiness-run.ts`) does, and notes a file whose name is not the one its
content gets. A file of the old convention (a soak of a candidate under A's name) is read as what it holds and the loader says so.

**Fields that can be relied on** (`schemaVersion` 1; a revision that breaks one raises it):

| Path | What it is |
| --- | --- |
| `kind` | `readiness` or `soak` |
| `envId` | `gha-linux-x64` and `gha-macos-arm64` here; in general what `detectEnvId` (`src/shared/env.ts`) returns: `gha-<os>-<arch>`, `jenkins-…`, `docker-…`, `local-<platform>-<arch>` or a `PB_ENV_ID`. Results of different ids are never merged or compared in one row |
| `engine`, `browser.name`, `browser.version` | `chromium`, `firefox` or `webkit`, and the version the browser reports |
| `stream.protocol`, `stream.id` | `dash` or `hls`, and the stream |
| `commit.hash`, `commit.dirty` | the short hash of the checkout and whether it had changes |
| `generatedAt`, `durationMs` | when the run ended (ISO, UTC) and how long it took |
| `host.cpus`, `host.memoryGiB`, `host.os.*` | the machine as the harness read it. **The CPU model is not in the file**: it is in `docs/results/provenance/machines/` |
| `load.before`, `load.after` | `{ at, load1, load5, load15, cpus }`, optional (older files have none). Busy at the start: `load1 / cpus > 1` |
| `limits` | the policy the evaluations were judged against, as it was |
| readiness: `configurations[].id`, `.label`, `.patch`, `.verdict` | `A` or the id of a candidate; the worst verdict of its checks |
| readiness: `configurations[].checks[].id`, `.verdict` | `PB-RDY-001` to `PB-RDY-004` |
| readiness: `configurations[].checks[].evaluations[]` | the lines (below) |
| soak: `configuration.id`, `options.minutes`, `length` | `A` or the candidate; the requested length; `ci`, `release` or `short` |
| soak: `verdict`, `evaluations[]` | the verdict **as measured**, and the lines (below) |

Every line of `evaluations` has `id`, `check`, `label`, `value` (a number, or null when nothing could be measured), `unit` (`ms`, `ratio`, `count`, `MB`, `min`), `limit`,
`bound` (`at-most` or `at-least`), `limitKey`, `verdict` (`GO`, `NO-GO`, `INCONCLUSIVE`, `N/A`), `scope` (`criterion` or `advisory`) and `sentence`; `censored: true` means that the value is
a lower bound (the player never got back, so the value is how long the observation lasted). A margin is `limit - value` for `at-most` and `value - limit` for `at-least`.

- Readiness line ids: `start.worst` (PB-RDY-001), `start.p95` (advisory), `latency.p95`, `latency.max` (PB-RDY-002), `stall.recovery`, `stall.restore`, `stall.restore-relative`
  (advisory) (PB-RDY-003), `cadence.median`, `cadence.longest` (PB-RDY-004). The per-run numbers of the stall lines are in `detail.runs[]`
  (`latencyBeforeMs`, `finalLatencyMs`, `restoredAtMs` or null, `observedMs`, `recoveryMs`).
- Soak line ids: `soak.length`, `soak.stalls`, `soak.critical-errors`, `soak.unexplained-critical-errors`, `soak.rebuffer-ratio`, `soak.latency-drift`
  (`detail.slopeMsPerHour`), `soak.latency-p95`, `soak.latency-max`, `soak.heap-growth` (`N/A` outside Chromium), `soak.dropped-frames`,
  `soak.unexplained-recoverable-errors` (advisory), `cadence.median` and `cadence.longest` (advisory).

**Three traps.** (1) **A soak's `verdict` is the one of its time.** In the files written by code that predates ADR-159c (the 18 of `0d62c1d`, and the 6 of `e0a5be3`, which `main` wrote without it) the lines
`soak.latency-p95` and `soak.latency-max` have `scope: "advisory"` and the verdict ignores them; since ADR-159c they are criteria. A table that shows `verdict` shows GO for 9 soaks that are NO-GO today (8 of the first
evidence, 1 of the extra runs). Use `soakVerdictToday(report)`
(`src/lab/readiness/report.ts`), which re-aggregates the stored lines, or show both, as the manifest does. (2) **`series.samples` is thinned** (`series.sampleCount` is how many were taken; the 5-minute and the
8-minute soaks are whole, the 30-minute ones are not): the evaluations were computed from the whole series, so never recompute a verdict from a thinned one. (3) `detail` is not a contract except for the keys named
above; its other keys can change.

**Two batches, and `docs/results/provenance/runs.json`.** The result files do not say which job wrote them. `runs.json` does, for each file: `label`, `runId`, `file`, `uploadedAs` (the name the job gave it), `sha256`, `batch`
(`first` when absent: the 18 files of `0d62c1d`; `extra`: the 6 of `e0a5be3`) and `args` (what the job was given after `--engine`; null for the first batch, whose dispatches were not written down). A generator that
shows the evidence of one commit selects by `batch` or by `commit.hash`, never by a name. The checklist reads every file of a results directory, so `npm run readiness -- --from-results` over `docs/results` now reads two
commits and item 1 says so ("the results are from 2 different commits: they are not one build"): the checklist is for the results of one build, and to judge one, `--results-dir` points at its results. A result over HLS
carries `, hls` after its environment on every line of the checklist that names it, and the line of a soak that did not inject its length's policy plan says what it injected instead.

## What to measure next

The six jobs that this section asked for when the page was first written were run: their arguments are in the [manifest](results/readiness/README.md) and their results under "Extra runs". What they leave open:

- **Why the 30-minute WebKit soak of the candidate did not come back from its stale manifest.** One isolated run did not reproduce it. What differs between the two is the outage 10 minutes before the stale manifest, the
  length, and the machine (CPU model and image). A repeat of the release soak (`--engine webkit`, `--minutes release --candidate live-sync`) would say how often it happens; a repeat of one identity replaces its file by design
  ([ADR-159a](decisions/readiness-evidence.md)), so repeats need a results directory of their own (`--out-dir`) to be kept side by side. Not requested: it costs 35 minutes of a runner per repeat, and the decision it informs
  (the guard metrics of the A/B experiment) is not being made.
- **Which reading of "restored" should decide PB-RDY-003.** That is a decision for the owner (the addendum to ADR-159b), not a measurement; if the owner wants data for it, the one run that would add some is the HLS check on
  Chromium with more outages (`readiness`, engine `chromium`, `--candidate live-sync --protocol hls --stall-runs 9`, about 30 minutes), which would show how often the absolute reading says GO for A there. Not requested.
- **Not requested, for the reasons given before:** a second macOS run at a quieter load (a fresh macOS runner started busy in 3 jobs out of 3, so a re-run would too, and nothing in the harness waits for a quiet machine: it would
  need an option first), and a path control per engine.

**Limits of this evidence.** One run per case (24 files: 18 and 6). Shared runners, five CPU models and two image versions in one Linux environment id. A synthetic stream on localhost. Three outages per readiness
run. Soaks of 5, 8 and 30 minutes. HLS on Chromium and WebKit on Linux only. No real network, no CDN, no audience. This phase measured; it did not decide anything that is not written as a decision.
