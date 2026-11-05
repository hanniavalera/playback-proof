# The results tables of the README

The tables in the "Real results" section of [`README.md`](../README.md) are not written by hand. Each one sits between a pair of markers, is rendered from files committed in this repository, and `npm run docs:check` fails when it differs from what those files render to, so a number in the README cannot drift from the data it quotes.

```text
<!-- BEGIN:RESULTS_CODEC -->
...rendered by tools/results/codec.ts from docs/results/codec-matrix/*.json...
<!-- END:RESULTS_CODEC -->
```

```sh
npm run docs:check                          # fails when a block is missing, malformed, stale or cannot be rendered
npm run docs:check -- --write               # rewrites the generated blocks of README.md, TEST_STRATEGY.md and the readiness documents, then checks
npm run docs:check -- --print RESULTS_PERF  # prints one block (no name: all of them) and writes nothing
```

## The blocks

| Block | Reads | In the README | Renderer |
| --- | --- | --- | --- |
| `RESULTS_CODEC` | `docs/results/codec-matrix/*.json` | required | [`tools/results/codec.ts`](../tools/results/codec.ts) |
| `RESULTS_SUITES` | `TEST_STRATEGY.md` (the catalog), `tests/e2e` and `tests/live` (the specs), `.github/workflows/ci.yml` and `nightly.yml` (the legs, the `--grep` and `--grep-invert` they run, the performance legs), `tools/gate-merge.ts` (the tier tag of the merge gate) | required | [`tools/results/suites.ts`](../tools/results/suites.ts) |
| `RESULTS_PERF` | `perf/baselines/<env>/<profile>.json`, `docs/results/perf/**` (derivation, A/A summaries, the two sets measured on GitHub with the machine record of each job, the sensitivity summary, the gate reports of the pull request that slowed startup) | required | [`tools/results/perf.ts`](../tools/results/perf.ts) |
| `RESULTS_TRIAGE` | `docs/results/triage/triage-report.json`, `summarize-with-mock/triage-report.json` and `ci-demo/*.json` (the triage job on a red pull request) | required | [`tools/results/triage.ts`](../tools/results/triage.ts) |
| `RESULTS_JENKINS` | `docs/results/jenkins/build-<n>.json`, the `Jenkinsfile` | required | [`tools/results/jenkins.ts`](../tools/results/jenkins.ts) |
| `RESULTS_FLAKE` | the raw histories of `docs/results/flake/**/raw/**/*.jsonl`, counted with the tracker's own parser (the reports and the write-up beside them are not read: a report's window can be shorter than the collection) | required | [`tools/results/flake.ts`](../tools/results/flake.ts) |
| `RESULTS_READINESS` | `docs/results/readiness/*.json`, `docs/results/soak/*.json` and `docs/results/provenance`, joined by `src/lab/readiness/evidence.ts` | required | [`tools/results/readiness.ts`](../tools/results/readiness.ts) |
| `RESULTS_SOAK` | the same | required | [`tools/results/readiness.ts`](../tools/results/readiness.ts) |
| `RESULTS_AB` | the reports `docs/results/ab/*.report.json` (and the pipeline check in `docs/results/ab/pipeline-check/`, which is not tabulated), and the plans in `ab/prereg/` that they name | required | [`tools/results/ab.ts`](../tools/results/ab.ts) |

A renderer is a pure function of a `FileSet` (strings in, a string out, in [`tools/results/files.ts`](../tools/results/files.ts)). It reads JSON through a `Node`, which names the file and the path of whatever is wrong (`docs/results/jenkins/build-3.json: $.stages[2].durationMs: expected a number but found the string "12"`), and it throws a `ResultsError` for a file that is missing or malformed. `docs:check` turns that into a problem with the message, and never into a stack trace. A block with nothing to show returns an empty state that says so in words and carries no number.

## What `docs:check` says

| Situation | Result |
| --- | --- |
| A required block is missing from the README, or its markers are duplicated or out of order | Problem |
| A block's markers are there and the content differs from the rendering | Problem, with the first line that differs and the command that fixes it |
| A block's files are missing or malformed | Problem, naming the file and the field |
| An optional block has no markers and its files exist | A note: results exist that the README does not show |
| An optional block has no markers and no files | Nothing |

## Adding a block

1. Write one function in `tools/results/<name>.ts`: `(files: FileSet) => Rendered`. Return `emptyState(...)` when there is nothing to show.
2. Register it in `RESULT_BLOCKS` in [`tools/results-tables.ts`](../tools/results-tables.ts): its name, a title, the files it reads, whether the README must hold it.
3. Put the marker pair where the table belongs in `README.md` and run `npm run docs:check -- --write`.

Tests: [`tests/unit/docs/results-tables.test.ts`](../tests/unit/docs/results-tables.test.ts) renders every block from the real committed files and from synthetic ones; [`tests/unit/docs/results-mutations.test.ts`](../tests/unit/docs/results-mutations.test.ts) changes one number in a copy of a result file (or deletes or corrupts it) to see that the check fails with a message; [`tests/unit/docs/check-docs-cli.test.ts`](../tests/unit/docs/check-docs-cli.test.ts) runs the command itself on a copy of the repository (`PB_DOCS_ROOT` points it there) and looks at its exit code; [`tests/unit/docs/readme.test.ts`](../tests/unit/docs/readme.test.ts) checks the README (its blocks, links, anchors, the paths and scripts it names, the ADRs it cites) and the sentences of its prose that stand on a result file or on the state of the repository, recomputing the numbers it quotes from the committed files.

## The readiness tables: two generators, one data path

`docs/READINESS.md` and the manifest of `docs/results/readiness/README.md` have a generator of their own, [`tools/results-docs.ts`](../tools/results-docs.ts) (`npm run results:docs`, `-- --write` to rewrite), written with the readiness evidence: it joins every result file to the GitHub run, runner and machine record that made it ([`src/lab/readiness/evidence.ts`](../src/lab/readiness/evidence.ts), [ADR-159a](decisions/readiness-evidence.md)) and refuses a file that is not the one its job uploaded (SHA-256), a name that is not the one its content gets, and a machine record of another commit or environment. The README's `RESULTS_READINESS` and `RESULTS_SOAK` blocks are rendered through that same module, from the same files: the README shows the verdicts and the counts, `docs/READINESS.md` the whole analysis, and no number is computed twice.

Both are checked by `npm run docs:check`: the README's blocks by the registry above, `docs/READINESS.md` by calling `resultsDocsProblems` of `results-docs.ts`, so one command checks (and with `--write` rewrites) every generated block of the repository. `npm run results:docs` stays for the readiness work on its own, and `tests/unit/readiness/evidence.test.ts` keeps its tables fresh in the unit suite too. A result file edited by hand fails both documents with the same message (`the file is not what the job uploaded`).

## The A/B block: verdicts only from the reports

`RESULTS_AB` reads what the harness wrote, the `.report.json` of each run (schema 1, `kind: "ab-report"`), and the plan each report names for what a condition was (`ab/prereg/<id>.json`). The verdict, the validity gates, the sessions attempted, failed and analysed, the medians or counts of each arm, the effect with its 95 % interval, and the A/A calibration (splits declared significant) are printed as the reports hold them; the human-written narrative of the run stays in [`docs/results/ab/README.md`](results/ab/README.md). The renderer refuses what would let an estimate pass for a finding: an exploratory report that carries a verdict, a pre-registered one that has none, a pipeline check that says it is evidence, a `valid` flag that its gates contradict, an interval that is not 95 %, sessions that do not add up, an A/A pilot without its calibration, and a condition that its plan does not know. It also writes down, from the counts, what the reader would otherwise have to work out: that an experiment whose A has no events can only show harm, and that an A/A check whose pool has no variation could not have failed.

## No block waits for data

Every block is required. A block for results that are in flight can still be registered with `required: false`: until the README holds its markers, `docs:check` says in a note (and does not fail) that results exist which the README does not show, and fails if the markers are there and the block cannot be rendered or is stale.
