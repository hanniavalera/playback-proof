# The readiness evidence decisions (ADR-159a to ADR-159e)

Architecture decision records for what was done with the first evidence of the live-event readiness checks and the soak: the 18 results that
GitHub's runners produced for commit `0d62c1d` (docs/results/readiness and docs/results/soak, described file by file in
docs/results/readiness/README.md and analysed in docs/READINESS.md). They continue
[readiness.md](readiness.md) (ADR-150 to ADR-159): that range is full, and the numbers after it belong to other phases, so these carry a letter,
as [ADR-156a](readiness.md) does. They are written so each one can be defended in a review: what the situation was, what was chosen, what was
rejected, what it costs, and how I would argue for it.

## ADR-159a: A result file says what it is: the candidate and the protocol are in the name, the content decides what a file is, and two runs are never merged

**Context.** The first evidence came from 18 jobs of `measure.yml`, each uploading its own artifact: four readiness runs, eight CI soaks and six
release soaks, the soaks once for configuration A and once for the candidate `live-sync`. Every job wrote its file in a checkout of its own, so
nothing was lost on GitHub, but the soak of A and the soak of `live-sync` of one environment, engine and length were **the same file name**
(`gha-linux-x64-chromium-30m.json` for both): `soakFileName` was written when only A was soaked, the command learned `--candidate` afterwards, and
the name did not. Committing the results of both to `docs/results/soak` would have overwritten one with the other without a word. It was found
by the person who collected the files, not by a test: no test ran two soaks into one directory. The readiness files do not have the problem for
a candidate: a readiness run evaluates A **and** its candidates and writes them into one file (`configurations: [A, live-sync]`, confirmed in
the four files of the evidence). They have it in another form: two runs of one environment and engine replace each other, and a run over HLS
would replace a run over DASH.

**Decision.** (1) A name carries what distinguishes the runs that must be able to be kept side by side. A soak: environment, engine, length, **what
it injected when that is not the policy's plan for its length** (`-nostall`, `-stale2m`, `-warmup15s`: a soak with the stale manifest and no
outage is another experiment, and would otherwise replace the policy's soak of the same length), the protocol when it is not DASH, the candidate
when it is not A (`gha-linux-x64-chromium-30m-live-sync.json`; `custom` carries the first eight characters of a SHA-256 of its patch, with the
keys in a fixed order, so that two different `--config-json` never share a name). A readiness
file: environment, engine and the protocol when it is not DASH; it holds the configurations of one run, A first. **A keeps the names it always
had, and so does every soak of the policy** (the 14 files of the evidence have the names they were uploaded with, the candidate's apart). (2) The writers take the name from what they write (`soakFileNameOf(report)`, `readinessFileNameOf(report)`), so that the name of a file and
what it holds cannot be made to differ by the code. (3) The readers do not use names. `loadResults` reads every `*.json` of the two directories
strictly, and what a file is comes from its content: a file whose name is not the one its content gets is read as what it holds, and the reader
says so (a `note`, printed by `--from-results` and by the checklist). For the one case that exists, a candidate's soak under the name of A's,
the note says that it is read as the candidate, what to rename it to, and that the next soak of A would overwrite it. Two files that hold the same
run (environment, engine, protocol, length, configuration) are **not merged and not dropped silently**: the newer by `generatedAt` is used and the
note names both. (4) A soak file has to say what was soaked: `configuration.id` is required by the strict reader, because the checklist cannot tell
A from a candidate without it (a file without it used to fail later with a `TypeError` instead of naming the file). (5) The checklist counts the
soaks of A, and only those, for item 4 ("the release soak passed in every engine"), which it did, and now **lists** the soaks of a candidate under
it as evidence for a decision about the candidate and not about the build. (6) The evidence is committed with the names of this decision: the
seven soaks of `live-sync` were renamed when they were copied, every file is byte-for-byte what the job uploaded, and the manifest says so with
the SHA-256 of each.

**Alternatives considered.** An overwrite guard in the writers (refuse when the file exists and holds another run): the name fix makes the
collision impossible for every case that is known, and a guard would also forbid the deliberate re-run of one identity, which is how a result is
replaced. A directory per candidate: the generators and the loader read one directory, and a directory per candidate multiplies the places a
reader must look. A timestamp in every name: no overwrite, but then "the soak of this engine" is not a function of its name and the checklist
has to choose between runs; with the identity in the name a replacement is a deliberate act, and git keeps the history. A digest of all the
options in the name: unreadable, when the options are in the file. Keeping the old name for the candidate and adding the candidate to the content
only: that is what it was, and it is the bug.

**Consequences.** Two results of one identity replace each other by design (re-running a soak replaces its file). What is **not** in a name is in
the file and nowhere else: the minute of the outage, the stale manifest, the warm-up, the cadence of the sampler (`options`): a CI soak run with
`--no-stall` is, for the loader and the checklist, a CI soak (the checklist counts by length and by candidate, not by options), and it replaces the
soak with the outage of its identity: a reader of a soak file reads `faults` and `options`. A person who copies an old-convention file in gets the
note and a correct reading, not an error, and not a wrong one. The pb-docs generators that glob `docs/results/readiness/*.json` and
`docs/results/soak/*.json` see one file per run and can tell A from a candidate by `configuration.id`, never by the name
(docs/READINESS.md, "Reading the result files"). Provenance that does not belong to the result schema (the run on GitHub, the
runner, the CPU model) is kept apart, in `docs/results/provenance`, because a stray `.json` in either directory would be read as a result and
refused.

**Defending it.** "Two results that differ in what was run must be able to sit side by side, and a file must never be able to be mistaken for
what it is not. So the name says it, the reader trusts the content, and the note tells the person who renamed a file, or did not, what the reader
did about it."

## ADR-159c: The soak judges the latency level after its faults, and a soak measured before that is judged by today's criteria without a number in it being touched

**Context.** The soak (PB-RDY-005) had seven criteria and none of them was where the player sits relative to the live edge: the drift is a trend,
and a flat latency at any level has no slope (ADR-156 says so on purpose: "a player that sits 10 s behind steadily is not drifting (that is
PB-RDY-003's finding)"). The p95 and the maximum of the latency over the soak were printed as two advisory lines, "Judged by PB-RDY-002; here as
evidence". The first evidence on GitHub's runners is what that costs. **All 14 soaks are GO** under the criteria of commit `0d62c1d`, the 7 of
configuration A included, and in each of the 7 of A the file says on two lines of its own that the player sat above both limits for the rest of
the run:

| Soak of A (environment, engine, length) | median before the outage | p95 and maximum after the faults | reads above 10 s, from minute | to the end of |
| --- | --- | --- | --- | --- |
| gha-linux-x64 Chromium, 5 min | 6.10 s | 10.62 s | 3.9 (14 of 32) | 5.0 |
| gha-linux-x64 Firefox, 5 min | 6.15 s | 11.13 s | 3.9 (13 of 31) | 4.9 |
| gha-linux-x64 WebKit, 5 min | 6.18 s | 10.82 s | 3.9 (13 of 31) | 4.9 |
| gha-macos-arm64 WebKit, 5 min | 6.64 s | 11.08 s | 3.9 (13 of 31) | 4.9 |
| gha-linux-x64 Chromium, 30 min | 6.10 s | 12.47 s | 11.4 (170 of 258) | 30.0 |
| gha-linux-x64 Firefox, 30 min | 6.16 s | 11.39 s (maximum 11.40 s) | 11.5 (171 of 261) | 29.9 |
| gha-linux-x64 WebKit, 30 min | 6.13 s | 12.79 s | 11.3 (172 of 262) | 29.9 |

(The p95 limit is 8 s and the maximum limit 10 s. The reads of the 30-minute files are counted on the series as it is stored, which is thinned:
the lines of the files, computed from the whole series, count 314 or 315 reads outside the faults. The 5-minute series are whole.) The defaults go
0.6 to 2.8 s over the maximum and stay there from the end of the time the policy gives them to settle until the soak ends: about two thirds of the
reads of a release soak that are outside the faults. PB-RDY-003 says the same thing about the 65 s after an outage (the player never comes back),
and the soak is the only place that shows it past the first minute (for 18 minutes of a release soak). The file said `GO` for the soak and, on two
lines it labelled as evidence that decides nothing, `NO-GO` for the same measure.

The second case is the one that settles the question. The soak of the **candidate** on WebKit (Linux, 30 min) is GO on every criterion and
PB-RDY-003 is GO for it on the same engine (restored in 2.7 s). It came back from the outage at minute 9.9 (10.66 s at its peak to 6.99 s in
about 50 s, at a playback rate of 1.1, the media clock gaining 1.10 s per second). After the stale manifest at minute 20 (a stall of 5.5 s) it sat
at **12.49 s** (6.99 s plus the stall) from minute 20.2 to the end, nine and a half minutes, 86 of the 261 stored reads from minute 21.4 on, the
first read the criterion takes after its settling window: the player reported a playback rate of 1.1 and its media clock advanced at 1.00 s per
second, with 10 to 11 s of media buffered. Nothing but the advisory line said it: a failure to come back after a second kind of fault, over a
long hold, that PB-RDY-003 (one outage, 65 s) cannot see. Why the clock did not take the rate is not known. The other six soaks of the
candidate read 6.99 to 7.49 s (p95 and maximum within 0.07 s of each other) and are GO either way.

TEST_STRATEGY section 8 already says the soak monitors the latency, "its p95 and maximum". A check that monitors a measure against a limit and
decides nothing with it is a log.

**Decision.** (1) The two lines `soak.latency-p95` and `soak.latency-max` are **criteria** of PB-RDY-005, against the limits PB-RDY-002 has for the
same two readings (`latencyP95MaxMs` 8 s, `latencyMaxMs` 10 s), so the requirement is one and the soak is its longest witness. (2) What is read:
the reads of the in-page sampler after the warm-up, **outside every injected fault and the time the policy gives the player to settle after it**
(the stall-recovery limit and then the restoration limit, 74 s: the window PB-RDY-003 allows, and the same one the drift fit leaves out), so
that a player that is catching up is not judged while it does. (3) From at least 20 reads: fewer is INCONCLUSIVE, never GO or NO-GO (the same
minimum as PB-RDY-002). A CI soak has 31 to 32 reads left, a release soak 314 or 315. (4) The sentence of a NO-GO says how many reads were above
the maximum and the minute of the first, so that a level (the player did not come back, or came back and left again) is told from a blip, which
is the reason the line names `readsAboveMaximum` and `firstAboveMaximumMinute` in its `detail`. (5) `criteria.ts` (the measure texts of the two
limits), TEST_STRATEGY section 8 (the check, the checklist item 4 and the catalog row PB-RDY-005) and the title of the spec say it in the same
commit as this record, and the tables that are generated from `criteria.ts` were regenerated. (6) **A soak measured before this record is judged
by today's criteria, and nothing in it is touched.** The 14 files keep their stored `verdict` (GO), their stored lines and their
`scope: "advisory"`: that is what the harness measured and said at commit `0d62c1d`. `soakVerdictToday(report)` re-aggregates the stored
evaluations with those two lines counted as criteria and returns the verdict of today and the lines that make it differ; the checklist (item 4),
the sheet of a soak (`Judged by today's criteria`) and the manifest of the evidence use it and say which one they print. By today's criteria the
7 soaks of A are NO-GO (latency level) and, of the 7 of the candidate, 6 are GO and the WebKit 30-minute soak is NO-GO.

**Alternatives considered.** *No criterion, and a paragraph that says that the soak and PB-RDY-003 answer different questions.* The paragraph is true
and it is not enough: a reader of a GO soak does not read the lines below the verdict, and 7 files out of 7 for the defaults would carry a GO and
a NO-GO for one measure; the WebKit case above would be a GO. *A separate limit for the soak* (a relative one: the level against the session's own
level before the outage, or a tighter p95): there is no measurement that says what number it would be, and two limits for one requirement is
how a soak and a join come to disagree; the two readings of PB-RDY-003 (absolute and relative) agreed in all 24 runs of the readiness files, the 12
of A and the 12 of the candidate (ADR-159b). *Judging only the end of the soak* (the last minutes): a player that left the limit in the middle
and came back is a defect of the same kind, and the maximum has to see it; the cost is that one read above 10 s outside the windows is a NO-GO,
as it is in PB-RDY-002, and the sentence says how many there were. *The p95 only*: it would have caught every level in the evidence (a level is
what at least 5 % of the reads sit at: 16 of the 315 reads of a release soak, 80 s), and it would not see a stretch shorter than that far above
the maximum, which is a member behind the edge by more than the requirement for more than a minute; the requirement is a maximum as well as a
p95, in PB-RDY-002 and here. *Re-running the 14 soaks* with the new criterion: 14 jobs for a verdict that is a function of a series I already
have (for the 30-minute files the stored series is thinned and a recomputation from it would differ from what the harness computed from the
whole one: the stored lines are the faithful input, and they were computed by the same code, which the 8 CI files, whose series are whole,
confirm to the last digit). *Rewriting the stored verdicts or scopes*: it would make the files say something they did not say when they were
measured. That is never done to a number.

**Consequences.** Configuration A is NO-GO on two rows for one cause, a player that never returns to the edge after an outage (PB-RDY-003 reads it
in the 65 s after the outage, PB-RDY-005 in the minutes that follow): two rows agree, which is not two defects, and the sheets say so. The
nightly CI soak of A exits 1 until the defaults are replaced or the defect is fixed, as the readiness run of A does. The thinnest margin
among the soaks that pass is 0.58 s (the candidate on macOS, CI soak: p95 7.42 s against 8 s) and the thinnest NO-GO margin is 0.62 s (the
defaults on Chromium, CI soak: 10.62 s against 10 s); the margins are measurements of one run each and they are in docs/READINESS.md. The limits
are shared with PB-RDY-002: a change of one is a change of both, and the policy text says so. The criterion is about the level and says
nothing about the speed of the return, which PB-RDY-003 measures. **What a GO soak still does not say:** that the player restores its own level
after a fault within the 65 s PB-RDY-003 holds it for (the soak allows 74 s and then looks at the level only); that anything is true of an
event of hours (ADR-158); that the JS heap, which is read in Chromium after a forced collection, is the player's memory; that the stream was
anything but the synthetic one on localhost; that the candidate, whose level the soak now judges the same way, is the decision for it
(ADR-159d). The load of the machine at the start of a run is on the sheet when it is high, because a soak that starts on a booting runner is
a soak of the runner for its first minutes (the three macOS jobs of the evidence started at a load average of 62 to 81 on 3 CPUs and ended at 3 to
11; whether the load moved any number cannot be told from one run of each, and the manifest says so beside each file).

**Defending it.** "A verdict that says GO must mean that nothing in its own file contradicts it. In 7 files out of 7 the defaults were GO and,
on two lines the file called evidence, 0.6 to 2.8 s over the maximum for the rest of the run, and the one soak of the candidate that was GO while
it sat 12.49 s behind the edge for nine and a half minutes is the case no other check could have caught. So the level is a criterion with the
limits the product already has, read where the policy lets the player settle, and the files of the first evidence are judged by it without a
digit in them changing."
