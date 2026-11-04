# The results tables of the README

The tables in the "Real results" section of [`README.md`](../README.md) are not written by hand. Each one sits between a pair of markers, is rendered from files committed in this repository, and `npm run docs:check` fails when it differs from what those files render to, so a number in the README cannot drift from the data it quotes.

```text
<!-- BEGIN:RESULTS_CODEC -->
...rendered by tools/results/codec.ts from docs/results/codec-matrix/*.json...
<!-- END:RESULTS_CODEC -->
```

```sh
npm run docs:check                          # fails when a block is missing, malformed, stale or cannot be rendered
npm run docs:check -- --write               # rewrites the blocks of README.md and TEST_STRATEGY.md, then checks
npm run docs:check -- --print RESULTS_PERF  # prints one block (no name: all of them) and writes nothing
```

## The blocks

| Block | Reads | In the README | Renderer |
| --- | --- | --- | --- |
| `RESULTS_CODEC` | `docs/results/codec-matrix/*.json` | required | [`tools/results/codec.ts`](../tools/results/codec.ts) |
| `RESULTS_SUITES` | `TEST_STRATEGY.md` (the catalog), `tests/e2e` and `tests/live` (the specs), `.github/workflows/ci.yml` and `nightly.yml` (the legs) | required | [`tools/results/suites.ts`](../tools/results/suites.ts) |
| `RESULTS_PERF` | `perf/baselines/<env>/<profile>.json`, `docs/results/perf/**` (derivation, A/A summaries, sensitivity summary) | required | [`tools/results/perf.ts`](../tools/results/perf.ts) |
| `RESULTS_TRIAGE` | `docs/results/triage/triage-report.json` and `summarize-with-mock/triage-report.json` | required | [`tools/results/triage.ts`](../tools/results/triage.ts) |
| `RESULTS_JENKINS` | `docs/results/jenkins/build-<n>.json`, the `Jenkinsfile` | required | [`tools/results/jenkins.ts`](../tools/results/jenkins.ts) |
| `RESULTS_FLAKE` | `docs/results/flake/**/report-*.json` | optional until the data lands | [`tools/results/flake.ts`](../tools/results/flake.ts) |
| `RESULTS_AB` | `docs/results/ab/**` | optional, renderer to write | [`tools/results/waiting.ts`](../tools/results/waiting.ts) |
| `RESULTS_READINESS` | `docs/results/readiness/<env>-<engine>.json` | optional, renderer to write | [`tools/results/waiting.ts`](../tools/results/waiting.ts) |
| `RESULTS_SOAK` | `docs/results/soak/<env>-<engine>-<minutes>m.json` | optional, renderer to write | [`tools/results/waiting.ts`](../tools/results/waiting.ts) |

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

Tests: [`tests/unit/docs/results-tables.test.ts`](../tests/unit/docs/results-tables.test.ts) renders every block from the real committed files and from synthetic ones; [`tests/unit/docs/results-mutations.test.ts`](../tests/unit/docs/results-mutations.test.ts) changes one number in a copy of a result file (or deletes or corrupts it) to see that the check fails with a message; [`tests/unit/docs/check-docs-cli.test.ts`](../tests/unit/docs/check-docs-cli.test.ts) runs the command itself on a copy of the repository (`PB_DOCS_ROOT` points it there) and looks at its exit code; [`tests/unit/docs/readme.test.ts`](../tests/unit/docs/readme.test.ts) checks the README (its blocks, links, anchors, the paths and scripts it names, the ADRs it cites) and the sentences of its prose that stand on a result file.

## Blocks that wait for data, and the shapes they expect

Until their files are committed, these blocks are not in the README. `RESULTS_AB`, `RESULTS_READINESS` and `RESULTS_SOAK` render an empty state when there are no files, and a problem that says no renderer exists when there are. Replace `waiting(...)` in the registry with the renderer when the data lands.

- `RESULTS_READINESS`: `docs/results/readiness/<envId>-<engine>.json`, a `ReadinessReport` ([`src/lab/readiness/report.ts`](../src/lab/readiness/report.ts), parsed by `parseReadinessReport`): `kind: "readiness"`, `envId`, `engine`, `generatedAt`, `commit`, `configurations[]` each with a `verdict` (GO, NO-GO, INCONCLUSIVE, N/A) and `checks[]`.
- `RESULTS_SOAK`: `docs/results/soak/<envId>-<engine>-<minutes>m.json`, a `SoakReport` (same file, `parseSoakReport`): `kind: "soak"`, `length` (`ci`, `release` or `short`), `verdict`, `evaluations[]`.
- `RESULTS_AB`: `docs/results/ab/**`. The shape is the A/B runner's report, which is not on `main` yet.
- `RESULTS_FLAKE`: `docs/results/flake/**/report-<engine>.json`, the output of `npm run flake:report -- --json` (`FlakeReport` in [`flake/report.ts`](../flake/report.ts)): `envId`, `history`, `limits`, `suites[]` (one per engine job: `builds`, `executions`, `flaky`, `failed`, `flakeRate`, `budget`, `verdict`) and `tests[]`. The renderer exists and is tested on synthetic reports; a test on the real files is added when they are committed.
