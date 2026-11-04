# CI: the pipeline on GitHub Actions

Every pull request runs the stages of [TEST_STRATEGY.md section 6](../TEST_STRATEGY.md) as jobs of one workflow, [`ci.yml`](../.github/workflows/ci.yml), and the Jenkinsfile runs the same stages: a stage is the `npm run gate:*` script of the same name, so the two files can be compared by a parity test (the Jenkins phase adds it) and neither can add a stage the other does not run without it being noticed. The decisions behind it are ADR-110 to ADR-114 in [decisions/ci.md](decisions/ci.md), and those of the flake gate ADR-170 to ADR-172 in [decisions/ci-flake.md](decisions/ci-flake.md). **Status: the merge gate, the streams job and the nightly have run on GitHub (pull request #1 and the pushes to `main` after it); the flake jobs (`flake`, `flake-record`) are written, linted and unit-tested, and their arguments were run against a real git repository, but they have not run on GitHub yet.** The budgets in this page are the design numbers; a time that was measured on a run says so (the last section says what is still open). The last green run of `main` when this was written (run 41787989882, 2026-11-04) took 4 minutes from its first job to its last: `static` 33 s, `unit` 68 s, `streams` 7 s (a cache hit), and the five legs 39 s (`chromium-cpu4x`), 1 min 48 s (`chromium`), 1 min 55 s (`firefox`), 2 min 33 s (`webkit-linux`) and 3 min 49 s (`webkit-macos`), each from its start to its end.

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

  after the five legs (needs: merge-gate; they run when a leg is red, and not when the run was cancelled):

  +-- flake          npm run gate:flake -- --store git        judge this build against `ci-data`   ubuntu-24.04
  |                  contents: read, no stored credential; exit 1 on a verdict, 2 when it cannot judge
  +-- flake-record   the same, plus --record --push           write the build into `ci-data`       ubuntu-24.04
                     push to main only; contents: write on this job alone; never forced

  The jobs run in parallel. The five legs wait for `streams` and nothing else; the flake jobs wait for the five legs.

every night 04:41 UTC  |  manual run  |  a pull request that changes nightly.yml       (nightly.yml)

  streams ---- the same workflow, the same cache
  |
  +-- release (<the same five legs>)   npm run test:e2e -- --grep "@merge|@release" --project=<project>
  |
  +-- flake (nightly)          the judge of ci.yml, for these runs (it runs on the pull request too)
  +-- flake-record (nightly)   the recorder of ci.yml; schedule and manual runs on main only

Arrive with their phase, as jobs that need `streams` (nothing of them exists yet):
  performance gate (Phase 5), A/B runs (6), soak and readiness (7), triage (8).
```

## The jobs

Budgets are the design numbers of [TEST_STRATEGY.md section 6.3](../TEST_STRATEGY.md): a merge job of one engine 8 minutes on the design target (2 cores, 2 workers; the GitHub Linux runner has 4 vCPUs and the macOS runner 3, and the config uses 2 workers in CI), static plus unit 4 minutes together, a release job 15 minutes. The timeout is the net under the budget, not the budget. A job that the runner kills at its timeout leaves no Playwright report, so every browser leg also passes `--global-timeout` with the job's timeout less four minutes (the "stops at" figures below): Playwright ends a run that is too long itself and still writes the report and the attachments (ADR-114).

| Job | Trigger | Runner | Budget (design) | Timeout | Artifacts | Reproduce locally |
| --- | --- | --- | --- | --- | --- | --- |
| `static` | pull request, push to `main`, manual | `ubuntu-24.04` | 4 min with `unit` | 10 min | none | `npm run gate:static` |
| `unit` | same | `ubuntu-24.04` | 4 min with `static` | 15 min | none | `npm run gate:unit` (needs ffmpeg on the `PATH`) |
| `streams` (restore or generate) | same, and the nightly | `ubuntu-24.04` | none in the strategy; about 1 min on a cache hit, 3 to 4 on a miss (generation is about 2 min on 4 cores: expected, not measured on a runner) | 15 min | `streams` (`.cache/streams`, 43 MB, 3 days) | `npm run generate:streams`, or `gh run download <run-id> --name streams --dir .cache/streams` |
| `merge-gate (chromium)`, `(firefox)`, `(chromium-cpu4x)`, `(webkit-linux, experimental)` | same | `ubuntu-24.04` | 8 min | 15 min (Playwright stops its own run at 11) | `reports-<leg>` (`reports/`, `test-results/`, 14 days) | `CI=true npm run docker:pw -- npm run gate:merge -- --project=<project>` (the streams must be in `.cache/streams`) |
| `merge-gate (webkit-macos)` | same | `macos-15` | 8 min (a slow 3-CPU runner: unmeasured) | 30 min (Playwright stops at 26) | `reports-webkit-macos` | on a macOS host: `npx playwright install webkit`, then `CI=true npm run gate:merge -- --project=webkit` |
| `flake` | pull request (forks too), push to `main`, manual; not when the run is cancelled | `ubuntu-24.04` | "seconds" (TEST_STRATEGY.md section 6.1); about a minute with its setup: unmeasured | 10 min | none: the verdict is on the job summary | `gh run download <run-id> --pattern 'reports-*' --dir reports/flake`, then `npm run gate:flake -- --store git --git-identity "me <me@example.invalid>" --runs reports/flake/reports-chromium` (and the other legs of the environment): it reads `ci-data` of `origin` and writes nothing |
| `flake-record` | push to `main` only | `ubuntu-24.04` | as `flake` | 10 min | none | not against `ci-data`, on purpose; the same runs into a local history: `npm run gate:flake -- --store file --history-dir <dir> --record --runs <dir of run files>` |
| `streams`, `release (<leg>)` of the nightly | `schedule` (04:41 UTC), manual, and a pull request that changes `nightly.yml` (a schedule and a manual run exist only for a file on the default branch, so a change would otherwise be seen the night after the merge) | as the gate | 15 min per engine (the release budget) | 30 min, stop at 26; 45 on macOS, stop at 41 | `reports-<leg>` (30 days) | `CI=true npm run docker:pw -- npm run test:e2e -- --grep "@merge\|@release" --project=<project>` |
| `flake (nightly)` | the nightly's triggers, the pull request included; not when the run is cancelled | `ubuntu-24.04` | as `flake` | 10 min | none | as `flake`, with the `reports-<leg>` of the nightly run |
| `flake-record (nightly)` | `schedule` and a manual run **on `main`**; never the pull request | `ubuntu-24.04` | as `flake` | 10 min | none | as `flake-record` |

The legs and what each one is for:

| Leg | Playwright project | Browser installed | Why it exists |
| --- | --- | --- | --- |
| `chromium` | `chromium` | Chromium | The engine every other engine is compared with. |
| `firefox` | `firefox` | Firefox | Plays every flavour on Linux; it does not start on the macOS development host, so this leg and Docker are where it runs. |
| `chromium-cpu4x` | `chromium-cpu4x` | Chromium | The low-end profile: the project's own `grep` (`@cpu`) is combined with the gate's `--grep @merge`, so it runs the throttled subset only. |
| `webkit-linux` (experimental) | `webkit` | WebKit | Linux WebKit's MSE playback is intermittent on the probe's page and passed 80 of 80 runs of the real player page in Docker on arm64; it runs as a required, flake-tracked experiment (ADR-113). |
| `webkit-macos` | `webkit` | WebKit | The realistic macOS media stack, the engine the primary stream is proven in. |

**One worker on the macOS runner.** The first real run on `macos-15` (three CPUs) with two workers failed six specs that had passed on the development host and on every Linux leg: the clock of a `seeked` event was 0.3 to 0.4 s past the target, a wait for 8 s of media time returned at 11.4 s, a join was 8.3 s behind the live edge against a limit of 8 s, 12 to 21 frames were dropped where none are on a fast machine, and one stream stalled for 7.9 s at the start. Two WebKit instances with their helper processes and the service on three CPUs starve each other, and event delivery lags by an amount no tolerance measured on a faster machine can absorb. The macOS legs therefore run with `PB_WORKERS=1` (a `workers` key of the leg, read by the Playwright config); the Linux legs have four vCPUs and keep two. The specs' own tolerances were made relative to the lag they observe, where the lag is the thing measured (see the VOD, live and recovery decisions).

**Required checks.** Branch protection on `main` should require these eight names, exactly as they are printed: `static`, `unit`, `merge-gate (chromium)`, `merge-gate (firefox)`, `merge-gate (chromium-cpu4x)`, `merge-gate (webkit-linux, experimental)`, `merge-gate (webkit-macos)`, `flake`. `streams / restore or generate` is implied by the five that need it. `flake` is more than the flake gate: nothing can skip it, so when no leg ran (`streams` failed and the legs were skipped) it fails for want of run files, and it is the check that notices a merge gate that did not run (ADR-171). `flake-record` is **not** required: it runs only for a push to `main`, where nothing waits for it, and a pull request never has it. The performance gate joins the list when its job exists. The rule is the owner's to set; it is not in the repository. A renamed job stops being required until the rule is updated, so a rename is a change to the rule too.

**What a pull request does not run:** the nightly (`@release` tests; it runs once on a pull request that changes `nightly.yml`), the codec matrix ([`codec-matrix.yml`](../.github/workflows/codec-matrix.yml): on demand, and on pushes to the probe's own files; it installs ffmpeg with brew on macOS because the probe makes its own test clips), the soak, the readiness checks and the A/B runs (TEST_STRATEGY.md section 6.4).

## The flake gate

`flake` and `flake-record` run after the five legs and call `npm run gate:flake`. [FLAKE.md](FLAKE.md) is the mechanism, [TEST_STRATEGY.md section 7.2](../TEST_STRATEGY.md) the policy, and ADR-170 to ADR-172 in [decisions/ci-flake.md](decisions/ci-flake.md) the decisions below.

**What it judges.** Each job downloads the five `reports-<leg>` artifacts into `reports/flake` (`actions/download-artifact` with `pattern: reports-*` gives each artifact a directory named after it, and inside it is the workspace the leg uploaded: a leg's run file is at `reports/flake/reports-<leg>/reports/flake/run.json`, with `run-quarantined.json` beside it when a test is quarantined; the gate searches a directory at any depth) and calls the gate **once per environment**, because a history is per environment and the gate refuses to mix them: the four Linux legs are `gha-linux-x64`, the macOS leg is `gha-macos-arm64`. It judges this build's runs against the history of the environment and the quarantine list. A test above the quarantine trigger that is not quarantined, an engine job above its suite budget, an expired quarantine and an invalid list are exit 1, each printed with the decision it drives, and the report is appended to the job summary. A test or an engine job with fewer than 20 executions or builds in the history only gets a note, so no rate can fail a build until the history is that long. Exit 2 means it could not judge (a leg left no run file, the history cannot be read): the job is red as well.

**Who may write.**

| Job | Runs for | Token | Credential kept in the workspace | Writes |
| --- | --- | --- | --- | --- |
| `flake` | every run that is not cancelled: pull request (forks too), push to `main`, manual run | `contents: read` | none (`persist-credentials: false`) | nothing: `ci-data` is fetched without a token (the repository is public) and `--record` is not given |
| `flake-record` | a push to `main`, nothing else | `contents: write`, on this job alone | the checkout's own, which the store pushes with | `ci-data`, as `github-actions[bot]`, never forced |

The default permission of the repository's token is `read` and stays so: the recorder asks for its write permission itself, and [`tests/unit/ci`](../tests/unit/ci) fails if a write permission appears in any other job, if the recorder's condition changes, or if the judge is given more than a read token.

**The first run on `main`.** There is no `ci-data` branch yet and nothing has to be created by hand. Until the first recording every judge reads an empty history (a missing branch is an empty history, not an error), so it passes with the note that there is not enough data. The first push to `main` after the merge runs `flake-record`: the store builds a commit with no parent that holds `history/gha-linux-x64.jsonl` and pushes it as the new branch `ci-data`, then the macOS call adds a second commit on top of it with `history/gha-macos-arm64.jsonl`; both are authored and committed as `github-actions[bot]`. Two jobs that both find no branch settle it with the store's retry (the loser fetches the winner's tip and appends there), and running the job again records nothing new. [`tests/unit/ci/flake-jobs.test.ts`](../tests/unit/ci/flake-jobs.test.ts) runs this sequence with the workflow's own arguments against a temporary bare repository. What has not been seen is the push of the bot, with the job's token, on GitHub.

**When a build is judged.** Both jobs wait for `merge-gate` and use `if: ${{ !cancelled() }}` (ADR-171): a leg that is red does not skip them, because a build that flaked is the one to judge, and a run that was cancelled (the next push to the pull request does that) does not start them. Nothing can skip `flake`, so it is also what turns red when the legs never ran.

**The nightly** has the same two jobs, named `flake (nightly)` and `flake-record (nightly)`: the required check `flake` is the job of `ci.yml`, and two checks of one name would be ambiguous. Their steps are the same (a unit test compares them; a reusable workflow would have renamed the check, since a called job is named `<caller job> / <called job>`). The judge runs for every run of the nightly, the one a pull request that changes `nightly.yml` triggers included, which is the only time its wiring is exercised before the merge. The recorder runs for the schedule and for a manual run **on `main`** (a manual run of another branch only judges) and never for the pull request. The runs of the nightly hold the `@release` tests as well as the `@merge` ones: the history gets the flake rates of the release tier, and its `@merge` tests count as builds of their engine job, like the merge gate's. Two limits. The nightly runs the plain `test:e2e`, not `gate:merge`, so a quarantined test is not run apart and non-blocking there: it fails the nightly like any other. And a push to `main` and a night can record at the same moment, which is the race the store retries (a unit test records a push and a night, one after the other, into one history).

## How the data moves

1. **Streams.** `streams.yml` restores `.cache/streams` from the cache under the key `streams-v1-<os>-<arch>-ffmpeg6-<hash>`, where the hash covers every file the generator imports (`src/server/media/**`, `src/shared/streams.ts`, `tools/generate-streams.ts`: a unit test computes the import closure and checks it). On a miss it installs ffmpeg from apt (Ubuntu 24.04's 6.1: the job fails if the major version differs from the one in the key), generates the streams with `--verify`, and saves the cache. On either path it uploads the directory as the artifact `streams` and lists every stream with its content hash in the job summary.
2. **The legs** download that artifact into `.cache/streams` (`./.github/actions/setup` with `streams: 'true'`), print the same list, install their one browser (cached by the Playwright version: `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`; `--with-deps` on Linux), build the player and run the stage. The service starts through Playwright's `webServer` and refuses to start if a stream is missing. **Equal content hashes in the logs of two legs mean that two engines played the same bytes.** No leg runs ffmpeg and macOS installs none.
3. **Reports.** Each leg uploads `reports/` and `test-results/` as `reports-<leg>`, also when the run failed. `reports/playwright.json` is the Playwright JSON report; the lab's failure diagnostics (`qa-events.json`, `qa-metrics.json`, `qa-info.json`, `page-console.json`, `session-detail.json`, `request-log.json`, [CONTRACTS.md section 7.2](CONTRACTS.md)) are attachments of the failed result stored inside it, base64 encoded; the screenshot, the error context and the trace are files under `test-results/`. `reports/html` is the HTML report. The flake gate reads the run files in them (`reports/flake/run*.json`, see "The flake gate" above), and the failure triage of a later phase will read the rest.
4. **The job summary.** After the stage, [`tools/ci-summary.ts`](../tools/ci-summary.ts) reads `reports/playwright.json` and writes the counts, the environment the run reported, the experimental-engine note, and one table each for the tests that failed, that passed only on a retry and that were skipped (with the skip's reason, or "no reason recorded") to the job's page. It never changes the job's result. Running `npx tsx tools/ci-summary.ts --title demo` on a local report prints the same text.

## Reproducing a job locally

The Linux legs run on the host runner (x64), which a laptop cannot reproduce. The closest thing is the Playwright image, which is what [`tools/docker/pw.sh`](../tools/docker/pw.sh) starts, with these differences: the CPU architecture (arm64 on an Apple-silicon Mac, x64 on the runner), the Node (the image's 24 against the pipeline's 22) and the environment id (`docker-linux-arm64`, so the committed evidence of that environment decides which flavours play and which engines are gaps).

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
- The flake jobs: `actionlint` 1.7.12 with `shellcheck` 0.11.0 (the native binaries) finds nothing in the workflows, and `npx prettier --check .github` passes. [`tests/unit/ci/flake-jobs.test.ts`](../tests/unit/ci/flake-jobs.test.ts) reads the arguments out of the workflow text, compares them with the legs of the matrix (one invocation per environment, each with the artifacts of its own legs), and runs them through the real gate against a temporary bare git repository laid out as the job lays out its workspace: a judge on an empty history writes nothing, the first recording creates `ci-data` as an orphan with one commit per environment, authored by the bot, and leaves `main` alone, a re-run adds nothing, and a leg without run files makes the gate exit 2. The same file runs `npm run gate:flake -- --help` and found a defect that no other check would have: the script was an alias of another one (`npm run flake:gate`), npm gives the arguments of an alias to itself, and every flag of the workflow would have been dropped. The script now runs the gate directly.

**Not validated, because it needs a GitHub run:**

- The time of every job and of each setup step, the cache hit rates, and so every number in the budget column: [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 6.3 holds design estimates until runs replace them.
- Whether `npx playwright install --with-deps <one browser>` works and is fast on `ubuntu-24.04` for each of the three (the probe job installed all three at once), and whether the browser cache saves anything (Playwright's own guide says it does not).
- Whether Linux WebKit passes the real player page on an x64 runner (the evidence is arm64 in Docker), and how often.
- The macOS leg: its time on a 3-CPU runner, and that `jq` is on the image (the setup action uses it to list the streams).
- That an artifact uploaded with `actions/upload-artifact@v7` (stored uncompressed, hidden directory included) downloads with `actions/download-artifact@v8` into the path the service reads, and that a second job of the run restores the cache entry the first one saved.
- Both flake jobs on GitHub: that `download-artifact` lays the files out as its source says (the layout above), that the fetch of `ci-data` works from a checkout that keeps no credential, that the push of the bot with the job's token creates the branch and is accepted (and that no rule added later forbids it), the time of the jobs, and how the gate's report renders on the job summary.
- What a required `flake` check does to a pull request whose legs were skipped by a failed `streams`: never observed (ADR-171). To see it, break `streams` on a throwaway branch and read the checks of its pull request.
- That a reusable workflow called with `uses: ./.github/workflows/streams.yml` and a local composite action behave as the documentation says on a pull request from the same repository.
- Whether Playwright's own stop at the limit behaves on a runner as it did on the development host (a 6 s limit on two tests wrote the report with the errors of the run and both tests marked as not run), and whether the upload step runs after a job that the runner itself timed out.
- The rendering of the job summary.
- That a run that is re-run replaces its artifacts cleanly (`overwrite: true`).

## Adding a job

A stage that gets its own script in `package.json` gets its own job in `ci.yml` (and its call in the Jenkinsfile): `gate:perf` and `gate:triage` when `perf/` and `triage/` exist (`gate:flake` was added this way). A script that a pipeline gives arguments (`npm run gate:x -- --flag`) runs its command itself and is not an alias of another npm script: npm gives the arguments of an alias to itself, and they never reach the command (`gate:flake` had that defect, and `gate:perf` still has the alias form). A job that needs the streams says `needs: streams`, checks out, and calls `./.github/actions/setup` with `streams: 'true'`. The nightly's soak, readiness and A/B jobs go after `streams` in [`nightly.yml`](../.github/workflows/nightly.yml), where the comment says so. `npm run test:unit` fails if a new workflow asks for a write permission outside `flake-record`, uses a third-party action, runs a job without a timeout, or calls an `npm` script that does not exist. A job that really needs to write is a decision: `flake-record` is the one so far, named in the test with its reason, and its job, not the whole workflow, carries the permission.
