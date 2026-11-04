# CI: the pipeline on GitHub Actions

Every pull request runs the stages of [TEST_STRATEGY.md section 6](../TEST_STRATEGY.md) as jobs of one workflow, [`ci.yml`](../.github/workflows/ci.yml), and the Jenkinsfile runs the same stages: a stage is the `npm run gate:*` script of the same name, so the two systems cannot drift apart without a test noticing. The decisions behind it are ADR-110 to ADR-114 in [decisions/ci.md](decisions/ci.md). **Status: the workflows are written, linted and unit-tested, and their commands were run locally; none of them has run on GitHub yet, so no time in this page is a measurement** (the last section says what that leaves open).

## The pipeline

```
pull_request  |  push to main  |  manual run                     (ci.yml)

  static ----- npm run gate:static                               ubuntu-24.04
  unit   ----- npm run gate:unit        (ffmpeg from apt)        ubuntu-24.04
  streams ---- restore .cache/streams (key: media code + ffmpeg 6), or generate, then publish
  |            the artifact `streams`                            ubuntu-24.04    (streams.yml)
  |
  +-- merge-gate (chromium)                    gate:merge -- --project=chromium         ubuntu-24.04
  +-- merge-gate (firefox)                     gate:merge -- --project=firefox          ubuntu-24.04
  +-- merge-gate (chromium-cpu4x)              gate:merge -- --project=chromium-cpu4x   ubuntu-24.04
  +-- merge-gate (webkit-linux, experimental)  gate:merge -- --project=webkit           ubuntu-24.04
  +-- merge-gate (webkit-macos)                gate:merge -- --project=webkit           macos-15
         each leg: download `streams`, install its one browser, build the player, run the gate,
                   write the job summary, upload the artifact `reports-<leg>`

  The jobs run in parallel. Only the five legs wait, and only for `streams`.

every night 04:41 UTC  |  manual run                            (nightly.yml)

  streams ---- the same workflow, the same cache
  |
  +-- release (<the same five legs>)   npm run test:e2e -- --grep "@merge|@release" --project=<project>

Arrive with their phase, as jobs that need `streams` (nothing of them exists yet):
  performance gate, flake gate (Phase 5), A/B runs (6), soak and readiness (7), triage (8).
```

## The jobs

Budgets are the design numbers of [TEST_STRATEGY.md section 6.3](../TEST_STRATEGY.md): a merge job of one engine 8 minutes on the design target (2 cores, 2 workers; the GitHub Linux runner has 4 vCPUs and the macOS runner 3, and the config uses 2 workers in CI), static plus unit 4 minutes together, a release job 15 minutes. The timeout is the net under the budget, not the budget.

| Job | Trigger | Runner | Budget (design) | Timeout | Artifacts | Reproduce locally |
| --- | --- | --- | --- | --- | --- | --- |
| `static` | pull request, push to `main`, manual | `ubuntu-24.04` | 4 min with `unit` | 10 min | none | `npm run gate:static` |
| `unit` | same | `ubuntu-24.04` | 4 min with `static` | 15 min | none | `npm run gate:unit` (needs ffmpeg on the `PATH`) |
| `streams` (restore or generate) | same, and the nightly | `ubuntu-24.04` | none in the strategy; about 1 min on a cache hit, 3 to 4 on a miss (generation is about 2 min on 4 cores: expected, not measured on a runner) | 15 min | `streams` (`.cache/streams`, 43 MB, 3 days) | `npm run generate:streams`, or `gh run download <run-id> --name streams --dir .cache/streams` |
| `merge-gate (chromium)`, `(firefox)`, `(chromium-cpu4x)`, `(webkit-linux, experimental)` | same | `ubuntu-24.04` | 8 min | 15 min | `reports-<leg>` (`reports/`, `test-results/`, 14 days) | `CI=true npm run docker:pw -- npm run gate:merge -- --project=<project>` (the streams must be in `.cache/streams`) |
| `merge-gate (webkit-macos)` | same | `macos-15` | 8 min (a slow 3-CPU runner: unmeasured) | 30 min | `reports-webkit-macos` | on a macOS host: `npx playwright install webkit`, then `CI=true npm run gate:merge -- --project=webkit` |
| `streams`, `release (<leg>)` of the nightly | `schedule` (04:41 UTC) and manual | as the gate | 15 min per engine (the release budget) | 30 min; 45 on macOS | `reports-<leg>` (30 days) | `CI=true npm run docker:pw -- npm run test:e2e -- --grep "@merge\|@release" --project=<project>` |

The legs and what each one is for:

| Leg | Playwright project | Browser installed | Why it exists |
| --- | --- | --- | --- |
| `chromium` | `chromium` | Chromium | The engine every other engine is compared with. |
| `firefox` | `firefox` | Firefox | Plays every flavour on Linux; it does not start on the macOS development host, so this leg and Docker are where it runs. |
| `chromium-cpu4x` | `chromium-cpu4x` | Chromium | The low-end profile: the project's own `grep` (`@cpu`) is combined with the gate's `--grep @merge`, so it runs the throttled subset only. |
| `webkit-linux` (experimental) | `webkit` | WebKit | Linux WebKit's MSE playback is intermittent on the probe's page and passed 80 of 80 runs of the real player page in Docker on arm64; it runs as a required, flake-tracked experiment (ADR-113). |
| `webkit-macos` | `webkit` | WebKit | The realistic Apple media stack, the engine the primary stream is proven in. |

**Required checks.** Branch protection on `main` should require these seven names, exactly as they are printed: `static`, `unit`, `merge-gate (chromium)`, `merge-gate (firefox)`, `merge-gate (chromium-cpu4x)`, `merge-gate (webkit-linux, experimental)`, `merge-gate (webkit-macos)`. `streams / restore or generate` is implied by the five that need it. The performance and flake gates join the list when their jobs exist. The rule is the owner's to set; it is not in the repository. A renamed job stops being required until the rule is updated, so a rename is a change to the rule too.

**What a pull request does not run:** the nightly (`@release` tests), the codec matrix ([`codec-matrix.yml`](../.github/workflows/codec-matrix.yml): on demand, and on pushes to the probe's own files; it installs ffmpeg with brew on macOS because the probe makes its own test clips), the soak, the readiness checks and the A/B runs (TEST_STRATEGY.md section 6.4).

## How the data moves

1. **Streams.** `streams.yml` restores `.cache/streams` from the cache under the key `streams-v1-<os>-<arch>-ffmpeg6-<hash>`, where the hash covers every file the generator imports (`src/server/media/**`, `src/shared/streams.ts`, `tools/generate-streams.ts`: a unit test computes the import closure and checks it). On a miss it installs ffmpeg from apt (Ubuntu 24.04's 6.1: the job fails if the major version differs from the one in the key), generates the streams with `--verify`, and saves the cache. On either path it uploads the directory as the artifact `streams` and lists every stream with its content hash in the job summary.
2. **The legs** download that artifact into `.cache/streams` (`./.github/actions/setup` with `streams: 'true'`), print the same list, install their one browser (cached by the Playwright version: `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`; `--with-deps` on Linux), build the player and run the stage. The service starts through Playwright's `webServer` and refuses to start if a stream is missing. **Equal content hashes in the logs of two legs mean that two engines played the same bytes.** No leg runs ffmpeg and macOS installs none.
3. **Reports.** Each leg uploads `reports/` and `test-results/` as `reports-<leg>`, also when the run failed. `reports/playwright.json` is the Playwright JSON report; the lab's failure diagnostics (`qa-events.json`, `qa-metrics.json`, `qa-info.json`, `page-console.json`, `session-detail.json`, `request-log.json`, [CONTRACTS.md section 7.2](CONTRACTS.md)) are attachments of the failed result stored inside it, base64 encoded; the screenshot, the error context and the trace are files under `test-results/`. `reports/html` is the HTML report. The flake tracker and the failure triage of later phases read these files.
4. **The job summary.** After the stage, [`tools/ci-summary.ts`](../tools/ci-summary.ts) reads `reports/playwright.json` and writes the counts, the environment the run reported, the experimental-engine note, and one table each for the tests that failed, that passed only on a retry and that were skipped (with the skip's reason, or "no reason recorded") to the job's page. It never changes the job's result. Running `npx tsx tools/ci-summary.ts --title demo` on a local report prints the same text.

## Reproducing a job locally

The Linux legs run on the host runner (x64), which a laptop cannot reproduce. The closest thing is the Playwright image, which is what [`tools/docker/pw.sh`](../tools/docker/pw.sh) starts, with these differences: the CPU architecture (arm64 on an Apple machine), the Node (the image's 24 against the pipeline's 22) and the environment id (`docker-linux-arm64`, so the committed evidence of that environment decides which flavours play and which engines are gaps).

```
# the streams of a CI run (or: npm run generate:streams, with ffmpeg installed on the host)
gh run download <run-id> --name streams --dir .cache/streams

# one leg, with the CI settings (two workers, one retry, no test.only)
CI=true npm run docker:pw -- --cpus 2 npm run gate:merge -- --project=firefox

# what the job summary would say
npx tsx tools/ci-summary.ts --title "merge-gate (firefox)"
```

A leg that fails only on GitHub is reproduced with the streams of that run and the report of that leg (`gh run download <run-id> --name reports-<leg>`).

## What is validated, and what is not

Done on the development host (Apple M2 Pro, macOS 27.2, Docker Desktop), 2026-11-04:

- `actionlint` 1.7.12 finds nothing in any workflow (`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest`). It does not read the steps of a composite action: the steps of `.github/actions/setup` were checked by running actionlint over a copy of them wrapped in a workflow.
- `npm run test:unit` includes [`tests/unit/ci`](../tests/unit/ci): the policies of the workflows (timeouts, no `continue-on-error`, `contents: read`, GitHub-owned actions pinned to a major version, no `pull_request_target`, no secret), the agreement between files (legs and Playwright projects, the legs of the gate and the nightly, the cache key and the generator's imports, the artifact names, the `npm` scripts) and the job summary. Each of the main rules was checked to fail when broken (a file the generator imports left out of the cache key, a leg that differs between the gate and the nightly, a typo in a project name, an artifact renamed on one side only, a job without a timeout, a `continue-on-error`).
- The commands of the Firefox leg ran in the Playwright image with `--cpus 2` and `CI=true`, on the five streams generated on the host: 3 of 3 `@merge` tests passed in 8.5 s with two workers. `--list` shows what each project selects: 3 tests in each engine and 1 in `chromium-cpu4x`.

**Not validated, because it needs a GitHub run:**

- The time of every job and of each setup step, the cache hit rates, and so every number in the budget column: [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 6.3 holds design estimates until runs replace them.
- Whether `npx playwright install --with-deps <one browser>` works and is fast on `ubuntu-24.04` for each of the three (the probe job installed all three at once), and whether the browser cache saves anything (Playwright's own guide says it does not).
- Whether Linux WebKit passes the real player page on an x64 runner (the evidence is arm64 in Docker), and how often.
- The macOS leg: its time on a 3-CPU runner, and that `jq` is on the image (the setup action uses it to list the streams).
- That an artifact uploaded with `actions/upload-artifact@v7` (stored uncompressed, hidden directory included) downloads with `actions/download-artifact@v8` into the path the service reads, and that a second job of the run restores the cache entry the first one saved.
- That a reusable workflow called with `uses: ./.github/workflows/streams.yml` and a local composite action behave as the documentation says on a pull request from the same repository.
- Whether the upload step runs after a job hits its timeout, and the rendering of the job summary.
- That a run that is re-run replaces its artifacts cleanly (`overwrite: true`).

## Adding a job

A stage that gets its own script in `package.json` gets its own job in `ci.yml` (and its call in the Jenkinsfile): `gate:perf`, `gate:flake`, `gate:triage` when `perf/`, `flake/` and `triage/` exist. A job that needs the streams says `needs: streams`, checks out, and calls `./.github/actions/setup` with `streams: 'true'`. The nightly's soak, readiness and A/B jobs go after `streams` in [`nightly.yml`](../.github/workflows/nightly.yml), where the comment says so. `npm run test:unit` fails if a new workflow asks for a write permission, uses a third-party action, runs a job without a timeout, or calls an `npm` script that does not exist.
