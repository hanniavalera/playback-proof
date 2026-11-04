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

**Decision.** (1) A name carries what distinguishes the runs that must be able to be kept side by side. A soak: environment, engine, length, the
protocol when it is not DASH, the candidate when it is not A (`gha-linux-x64-chromium-30m-live-sync.json`; `custom` carries the first eight
characters of a SHA-256 of its patch, with the keys in a fixed order, so that two different `--config-json` never share a name). A readiness
file: environment, engine and the protocol when it is not DASH; it holds the configurations of one run, A first. **A keeps the names it always
had.** (2) The writers take the name from what they write (`soakFileNameOf(report)`, `readinessFileNameOf(report)`), so that the name of a file and
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
