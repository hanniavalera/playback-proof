# The readiness evidence decisions (ADR-159a to ADR-159e)

Architecture decision records for what was done with the first evidence of the live-event readiness checks and the soak: the 18 results that
GitHub's runners produced for commit `0d62c1d` (`docs/results/readiness` and `docs/results/soak`, described file by file in the
[manifest](../results/readiness/README.md) and analysed in [docs/READINESS.md](../READINESS.md)). They continue
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
([docs/READINESS.md](../READINESS.md), "Reading the result files"). Provenance that does not belong to the result schema (the run on GitHub, the
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

## ADR-159b: The limits are requirements and the margins are measurements: no limit was changed, and the absolute reading of PB-RDY-003 stays the criterion

**Context.** The limits of `LIVE_READINESS` were set before anything was measured, as what a live event needs (a join within 5 s, a latency within
8 s at the 95th percentile and 10 s at most, a stall of 14 s at most and the latency back within 60 s, a manifest refreshed at least once a
second and never more than 4 s apart, and for a soak the limits of ADR-155 to ADR-157). The first evidence puts every line of every run next to its limit
(the margins are generated into [docs/READINESS.md](../READINESS.md) from the files): a join of 57 to 404 ms against 5 s (4.60 to 4.94 s of margin); a
p95 latency of 6.07 to 6.39 s against 8 s (1.61 to 1.93 s) and the same maximum against 10 s (3.61 to 3.93 s); a stall after the outage of 3.91 to
4.96 s in the worst run against 14 s (9.04 to 10.09 s); the median gap of the manifest at 2.00 s against 1 s and the longest at 2.00 to 2.32 s against
4 s (1.68 to 2.00 s); and, for the candidate, the latency restored after 2.74 to 11.80 s against 60 s (48.20 to 57.26 s). The old text of two of the limits
promised that Phase 7 would replace the start limit "with a multiple of the measured join time" and would "measure what the default configuration and
the candidate really achieve". The owner's position is that the limits are product requirements and not fitted to this environment, that lowering
them to the measured values would be tuning the test to pass, and that they stay unless the data shows one is wrongly specified (unachievable or
meaningless). The data had to be argued with before anything was changed.

**Decision.** (1) **No limit was changed.** The two policy texts that promised a revision now say what happened (`criteria.ts`). (2) The test of "wrongly
specified" is applied to every line, and none fails it. *Unachievable*: every limit is met by some configuration in the evidence (the candidate is GO on every
line; the limit the defaults fail, the latency back within 60 s, is met by the candidate in 2.74 to 11.80 s). *Meaningless*: a limit is meaningless if nothing a player could do would cross it, or if crossing
it says nothing about an event. The lines that were crossed, PB-RDY-003 by the defaults in 12 runs out of 12 and, since ADR-159c, the latency level of the soak by the defaults in 7 soaks out of 7 and by
the candidate once, were crossed by what is a defect for an event. The lines that were never crossed (the start, the latency in steady state, the cadence) are a different case, and the data cannot show
that they would fail for a pathological player, because none was run: that each evaluator fails a value one step beyond its limit is a property of the unit tests (ADR-151), not of this evidence, and I did not run a
pathological player against the lab. (3) **The margins are recorded per check, engine and configuration, and
they are measurements of this lab**: localhost, a synthetic stream, one run per case, shared runners with five CPU models. They say how far from its limit each
line was; they do not say how far an event is from its. (4) **What these checks are for is stated in the document that holds the evidence: they detect regressions and pathologies
(a join of seconds instead of tens of milliseconds, a player that does not get back to the edge, a manifest that stops being refreshed). They have wide margins and
therefore low sensitivity: a start time that doubled would pass. Small regressions are the performance gate's job (PB-PERF-001), and no number here certifies real-world latency.**
(5) A limit is revised only on evidence that it is unachievable or meaningless, never because a measurement is far from it, and the revision comes with an ADR that names the
artifact. (6) **PB-RDY-003 stays decided by the absolute reading** (ADR-153 left the choice between it and the relative one to this phase and its measured values). In the 24
runs of the 8 files both readings gave the same verdict in every one. They err in opposite directions at the edge: the absolute reading has a thin margin where a healthy level plus
a stall lands near the maximum (WebKit on Linux: 6.17 s plus a stall of 4 s is 10.15 s, so the defaults fail it by 0.15 to 0.20 s) and a wide margin for the candidate (2.19 to 2.54 s
under the maximum when the observation ends); the relative reading (back within 2 s of the session's own level before the outage) has a wide margin for the defaults (they lost 3.99 s
and more against 2 s) and a narrow one for the candidate (it ends 1.38 to 1.43 s above its own level, 0.57 to 0.62 s inside the tolerance). Neither separates the two configurations better
in these data; they separate them equally in verdict. What decides is what each one says: the absolute reading is the requirement (a member further behind the edge than the maximum is outside
it), the relative one is the diagnosis (the player did not come back). The criterion is the requirement and the relative line is kept beside it as advisory evidence, so that the sheet
still says "did not come back" when the two disagree.

**Alternatives considered.** *Lowering the limits to a multiple of what was measured* (the promise in the old text): a join limit of, say, 5 times the worst join would be about 2 s on
this evidence and would pass a join of seconds on a loaded runner as a failure of the runner, and fail nothing an event would care about; it would make GO mean "as fast as this lab", and the
margin would be spent before the first change. *Tightening only the lines with a wide margin* is the same fitting on fewer lines. *Relaxing the line the defaults fail* hides the defect the check exists
to find. *A limit per environment*: the policy of a requirement does not depend on the runner (the performance gate has a baseline per environment because it detects change, not because it
states a requirement). *Making the relative reading the criterion*: it would make the requirement a function of the session's own history, and a player that starts at 3 s and falls to 9 s would
pass or fail by how far it fell and not by whether it is within what the event needs. The cost of the absolute reading is real and is the point above: **it depends on the healthy level.** On a stream whose
healthy level is 4 s, defaults that lose 4 s and never come back end at 8 s and pass PB-RDY-003 while the relative line says NO-GO. In this lab the healthy level is 6.1 s and the absolute reading
works; if the healthy level changes (a lower-latency stream), the two readings must be compared again, which the advisory line makes visible.

**Consequences.** The checks of PB-RDY-001, -002 and -004 will pass in this lab unless something is pathologically wrong, which is their role. The margins that are thin are the ones to read, and they are
in the generated table: the defaults' NO-GO on WebKit (0.15 s), the candidate's soak p95 against 8 s on macOS (0.58 s) and its dropped frames there (0.49 % against 1 %), and the NO-GO of the 5-minute soak of
the defaults on Chromium (0.62 s over the maximum). A reviewer who reads "huge margins" as "the limits are too loose" is answered by (4): they are requirements, and the loose margin is a property of the lab.

**Defending it.** "A limit is what the event needs and a margin is how well this lab does against it. If I lowered the limit to the measurement, the check would pass because I had built it to pass,
and the day a real regression came it would fail for the noise of a runner. So the limits are the requirements, the margins are in a table made from the files, and the one line that fails is the one that
shows a defect."

## ADR-159d: The readiness result of a candidate is evidence for a decision, not the decision: the A/B decision of TEST_STRATEGY section 8 is not made

**Context.** The candidate `live-sync` is GO on every readiness check on every engine, and the defaults are NO-GO. TEST_STRATEGY section 8 has an item on its go/no-go checklist that says
"every configuration change since the last event has an A/B decision on record: ship, or keep A (an inconclusive result means keep A)", and section 12 says what such a decision is: a
pre-registration file committed before any data (the metrics and conditions, the number of sessions per arm, never fewer than thirty and set from the variance of an A/A run, the practical-significance
threshold and the decision rule), sessions of A and B interleaved, an A/A run first (PB-AB-001) to know the false-positive rate of the harness, an effect size with a confidence interval, and a decision rule
(ship B only if it is better on a primary metric with the interval beyond the threshold and not worse on the other; anything else is inconclusive and keeps A). Its two primary metrics are the start under
`high-latency` and the rebuffering under `bandwidth-drop`: a live-latency experiment is not in the policy, so it would be a new pre-registration and, for the metrics, a decision of the owner. The
readiness runs are none of that.

**Decision.** The readiness result of a candidate is **not** the A/B decision, and the checklist item stays open for it. What the readiness evidence is: one knob (`streaming.liveSync.enabled`), one candidate,
one synthetic stream on localhost, one run per engine of three outages each, with no pre-registered metric, no effect size and no interval; the soaks of the defaults and of the candidate of one engine ran on
different CPU models in 6 of 6 pairs on Linux (a readiness run evaluates both in one job, so there they share the machine); and the candidate's side effects were found in the soaks, not designed for: its stall at a stale manifest is 3.3 to 5.8 s longer than the defaults' (5.43, 6.18 and
5.49 s against 1.54, 0.40 and 2.21 s), it settles 0.6 to 0.9 s above its level before the first fault, and on WebKit on Linux it did not get back from the stale manifest. **What would be the decision** is an A/B
pre-registration on live latency in the style of PB-AB-002 and PB-AB-003: a primary metric (the latency that the session ends at after an injected origin stall, and its time back to the edge), the guard metrics that
the evidence names (the stall at a stale manifest, the start time, the rebuffer ratio), the practical threshold, an A/A run first, and the decision rule, written and committed before the run. **It has not been run.**
The sheets keep saying that a candidate's verdict is evidence and never changes an exit code; the exit code is the verdict of A.

**Alternatives considered.** *Treating the readiness GO as the decision*: it has no pre-registered metric or interval, the runs are single, and the comparison is confounded by the machine; the strategy's rule
("an inconclusive result means keep A") would, applied to it, keep A. *Running the A/B now*: it was not asked for, it needs a pre-registration first, and I did not check whether the A/B harness can run a live
stream. *Dropping the candidate because of its side effects*: they are what the A/B is for, and the readiness checks do not weigh a longer stale-manifest stall against a latency that comes back.

**Consequences.** The go/no-go sheet for the build as it ships is NO-GO (A fails PB-RDY-003, and the release soak of A fails the latency level), and the one configuration that passes the checks cannot be shipped on this evidence
under the strategy's own rule. Which of the two is accepted for an event (fix A by the A/B route, or accept the defect knowingly) is not decided here. The readiness evidence is an input to the pre-registration: it gives the size of
the effect to expect (4 to 5 s against about 1.4 s) and the guard metric to watch.

**Defending it.** "A candidate that passes a check the defaults fail is a reason to run the decision, not the decision. The strategy defines what a decision is, and this is not that, so the sheet says
'evidence for a decision' and the item stays open."

## ADR-159e: A run that starts on a busy machine says so; nothing waits for it and nothing is excluded

**Context.** The three macOS jobs of the evidence started on a runner that had just booted: the harness read a 1-minute load average of 66.39 (readiness), 81.33 and 62.65 (soaks) on 3 CPUs before its runs and
3.07, 9.84 and 10.91 after them; the workflow's own `uptime` printed 67.93 to 88.23 with the runner up for 1 to 2 minutes. The harness read `os.loadavg()` before and after every run and stored it in the file
(`load`), and did nothing else with it: no wait, no refusal, nothing in a verdict, and no judgement: the sheet printed the two readings as numbers without saying that 66 on 3 CPUs is not an ordinary
machine, and the lines of the checklist said nothing about them. The Linux runners read 0.27 to 1.89 before their runs
and 0.14 to 2.36 after, on 4 CPUs.

**Decision.** (1) A run is **busy at the start** when its 1-minute load average before the run is above one per CPU (`BUSY_LOAD_PER_CPU`; `isBusy`): more work is runnable than there are processors to run it.
The sheet of a run prints a line for it, the checklist line of a result carries ` [busy at the start: load 66.4 on 3 CPUs]`, and the manifest says it per file. (2) **Only the start is judged.** At the end the load
includes the run's own browser, service and harness (2.36 on 4 CPUs after a 30-minute soak), which is the run and not the machine. (3) **Nothing waits, nothing is excluded, no verdict depends on it.** The evidence
does not show the load moving a verdict (the macOS verdicts equal Linux's, and the highest dropped-frame ratio of the 14 soaks belongs to the macOS soak that started at the lower of the two loads), and excluding the busy
runs would exclude every macOS result there is.

**Alternatives considered.** *Waiting for a quiet machine before the run* (an option such as `--wait-quiet-sec`): it would make a re-run on a fresh macOS runner meaningful (the load fell from 66 to 3 during the
11 minutes of the readiness job), but it changes what a run is: a run that waits starts later, needs a bound, a record of how long it waited and a rule for a machine that never quiets, and nothing claimed here needs it.
It is not built, and a second macOS run is not requested for that reason (docs/READINESS.md, "What to measure next"). *Refusing to start on a busy machine*: on a CI runner it fails a job for a
condition the job cannot fix. *Normalising a number by the load*: there is no model that says how a load of 66 changes a latency. *A threshold other than one per CPU*: arbitrary either way; the Linux jobs (0.27 to
1.89 on 4 CPUs) are all under it and the macOS ones (62 to 81 on 3) are far over it, so the evidence does not depend on where it is put between them.

**Consequences.** The macOS rows are read as "measured on a runner that began busy": they confirm the verdicts and they are not a baseline, and they are never compared with the Linux rows. Whether the load moves a
number cannot be told from one run of each, and a quiet macOS run would need the wait first.

**Defending it.** "A reader must not have to open a JSON file to find out that the run began on a machine that was still booting. So the run says so where the verdict is read, and it goes no further than saying: I have
no evidence that the load changed an answer, and a rule that dropped or delayed the macOS runs would have thrown away the only ones there are."
