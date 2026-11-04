# CI: the pipeline on GitHub Actions

Every pull request runs the stages of [TEST_STRATEGY.md section 6](../TEST_STRATEGY.md) as jobs of one workflow, [`ci.yml`](../.github/workflows/ci.yml), and the Jenkinsfile runs the same stages: a stage is the `npm run gate:*` script of the same name, so a parity test ([`tests/unit/ci/parity.test.ts`](../tests/unit/ci/parity.test.ts), ADR-173) compares the two files and neither can add a stage the other does not run, or change what it is given, without it being noticed. The decisions behind it are ADR-110 to ADR-114 in [decisions/ci.md](decisions/ci.md), and those of the flake gate ADR-170 to ADR-174 in [decisions/ci-flake.md](decisions/ci-flake.md). **Status: the merge gate, the streams job and the nightly have run on GitHub (pull request #1 and the pushes to `main` after it); the flake jobs (`flake`, `flake-record`) are written, linted and unit-tested, and their arguments were run against a real git repository, but they have not run on GitHub yet.** The budgets in this page are the design numbers; a time that was measured on a run says so (the last section says what is still open). The last green run of `main` when this was written (run 41787989882, 2026-11-04) took 4 minutes from its first job to its last: `static` 33 s, `unit` 68 s, `streams` 7 s (a cache hit), and the five legs 39 s (`chromium-cpu4x`), 1 min 48 s (`chromium`), 1 min 55 s (`firefox`), 2 min 33 s (`webkit-linux`) and 3 min 49 s (`webkit-macos`), each from its start to its end.

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

  alongside the legs, in parallel with them (needs: streams; a measurement on a machine of its own, never beside a leg):

  +-- perf (chromium)         gate:perf -- --paired --profile chromium         ubuntu-24.04
  +-- perf (chromium-cpu4x)   gate:perf -- --paired --profile chromium-cpu4x   ubuntu-24.04
         each leg: full history (the control is another commit), the one browser, the player built, then the head is compared
                   with the control measured on THIS machine minutes earlier; upload `perf-reports-<profile>`

  after the five legs (needs: merge-gate; they run when a leg is red, and not when the run was cancelled):

  +-- flake          npm run gate:flake -- --store git        judge this build against `ci-data`   ubuntu-24.04
  |                  contents: read, no stored credential; exit 1 on a verdict, 2 when it cannot judge
  +-- flake-record   the same, plus --record --push           write the build into `ci-data`       ubuntu-24.04
                     push to main only; contents: write on this job alone; never forced

  The jobs run in parallel. The five legs wait for `streams` and nothing else; the flake jobs wait for the five legs.

  after the legs and the flake judge, only when one of them is red (needs: merge-gate, flake; if: failure()):

  +-- triage         npm run gate:triage -- --from artifacts   cluster the failures by cause     ubuntu-24.04
                     contents: read; not a required check; exits 0 whatever it finds; skipped on a green run

every night 04:41 UTC  |  manual run  |  a pull request that changes nightly.yml       (nightly.yml)

  streams ---- the same workflow, the same cache
  |
  +-- release (<the same five legs>)   npm run test:e2e -- --grep "@merge|@release" --project=<project>
  |
  +-- flake (nightly)          the judge of ci.yml, for these runs (it runs on the pull request too)
  +-- flake-record (nightly)   the recorder of ci.yml; schedule and manual runs on main only
  +-- triage (nightly)         the triage of ci.yml, when a leg or the judge is red

by hand only (workflow_dispatch, read-only token)                                      (measure.yml)

  streams ---- the same workflow
  |
  +-- measure (<task>, <engine>, <runner>)   one long measurement on ubuntu-24.04 or macos-15, then the artifact
                                             measure-<task>-<label>-<runner>  (the section "Measurements on GitHub runners")

Arrives with the baselines of the runner: the performance gate. The A/B runs, the soak and the readiness checks are long measurements that
run by hand through `measure.yml`, not merge stages.
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
| `perf (chromium)`, `perf (chromium-cpu4x)` | pull request, push to `main`, manual (input `control_ref`, default `HEAD`: an A/A) | `ubuntu-24.04` | about 12 min of measuring in all (the chromium leg about 9.5, the throttled one about 3; the design budget of one pass is 12 min, TEST_STRATEGY.md section 6.3), setup not measured | 30 min | `perf-reports-<profile>` (`reports/perf/`, 14 days) | `npm run gate:perf -- --paired --control-ref HEAD^1 --profile chromium` (the control is another commit: see [PERF.md](PERF.md)) |
| `flake` | pull request (forks too), push to `main`, manual; not when the run is cancelled | `ubuntu-24.04` | "seconds" (TEST_STRATEGY.md section 6.1); about a minute with its setup: unmeasured | 10 min | none: the verdict is on the job summary | `gh run download <run-id> --pattern 'reports-*' --dir reports/flake`, then `npm run gate:flake -- --store git --git-identity "me <me@example.invalid>" --runs reports/flake/reports-chromium` (and the other legs of the environment): it reads `ci-data` of `origin` and writes nothing |
| `flake-record` | push to `main` only | `ubuntu-24.04` | as `flake` | 10 min | none | not against `ci-data`, on purpose; the same runs into a local history: `npm run gate:flake -- --store file --history-dir <dir> --record --runs <dir of run files>` |
| `streams`, `release (<leg>)` of the nightly | `schedule` (04:41 UTC), manual, and a pull request that changes `nightly.yml` (a schedule and a manual run exist only for a file on the default branch, so a change would otherwise be seen the night after the merge) | as the gate | 15 min per engine (the release budget) | 30 min, stop at 26; 45 on macOS, stop at 41 | `reports-<leg>` (30 days) | `CI=true npm run docker:pw -- npm run test:e2e -- --grep "@merge\|@release" --project=<project>` |
| `flake (nightly)` | the nightly's triggers, the pull request included; not when the run is cancelled | `ubuntu-24.04` | as `flake` | 10 min | none | as `flake`, with the `reports-<leg>` of the nightly run |
| `flake-record (nightly)` | `schedule` and a manual run **on `main`**; never the pull request | `ubuntu-24.04` | as `flake` | 10 min | none | as `flake-record` |
| `triage` | pull request, push to `main`, manual; only when `merge-gate` or `flake` failed (`if: failure()`), so it is skipped on a green run | `ubuntu-24.04` | none: it explains a red build and never decides one ([TRIAGE.md](TRIAGE.md)) | 10 min | `triage` (`reports/triage/`, 14 days) | `npm run gate:triage -- --from <directory of the downloaded reports-<leg> artifacts> --out reports/triage` |
| `triage (nightly)` | the nightly's triggers, when a leg or the judge failed | `ubuntu-24.04` | as `triage` | 10 min | `triage` | as `triage`, with the `reports-<leg>` of the nightly run |

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

**What a pull request does not run:** the nightly (`@release` tests; it runs once on a pull request that changes `nightly.yml`), the codec matrix ([`codec-matrix.yml`](../.github/workflows/codec-matrix.yml): on demand, and on pushes to the probe's own files; it installs ffmpeg with brew on macOS because the probe makes its own test clips), the soak, the readiness checks and the A/B runs (TEST_STRATEGY.md section 6.4), and the measurements of [`measure.yml`](../.github/workflows/measure.yml), which only start when somebody dispatches them.

## The flake gate

`flake` and `flake-record` run after the five legs and call `npm run gate:flake`. [FLAKE.md](FLAKE.md) is the mechanism, [TEST_STRATEGY.md section 7.2](../TEST_STRATEGY.md) the policy, and ADR-170 to ADR-174 in [decisions/ci-flake.md](decisions/ci-flake.md) the decisions below.

**What it judges.** Each job downloads the five `reports-<leg>` artifacts into `reports/flake` (`actions/download-artifact` with `pattern: reports-*` gives each artifact a directory named after it, and inside it is the workspace the leg uploaded: a leg's run file is at `reports/flake/reports-<leg>/reports/flake/run.json`, with `run-quarantined.json` beside it when a test is quarantined; the gate searches a directory at any depth) and calls the gate **once per environment**, because a history is per environment and the gate refuses to mix them: the four Linux legs are `gha-linux-x64`, the macOS leg is `gha-macos-arm64`. It judges this build's runs against the history of the environment and the quarantine list. A test above the quarantine trigger that is not quarantined, a test whose invalid runs are above their budget (quarantined or not), an engine job above its suite budget, an expired quarantine and an invalid list are exit 1, each printed with the decision it drives, and the report is appended to the job summary. A test or an engine job with fewer than 20 executions, scheduled executions or builds in the history only gets a note, so no rate can fail a build until the history is that long. Exit 2 means it could not judge (a leg left no run file, the history cannot be read): the job is red as well.

**Who may write.**

| Job | Runs for | Token | Credential kept in the workspace | Writes |
| --- | --- | --- | --- | --- |
| `flake` | every run that is not cancelled: pull request (forks too), push to `main`, manual run | `contents: read` | none (`persist-credentials: false`) | nothing: `ci-data` is fetched without a token (the repository is public) and `--record` is not given |
| `flake-record` | a push to `main`, nothing else | `contents: write`, on this job alone | the checkout's own, which the store pushes with | `ci-data`, as `github-actions[bot]`, never forced |

The default permission of the repository's token is `read` and stays so: the recorder asks for its write permission itself, and [`tests/unit/ci`](../tests/unit/ci) fails if a write permission appears in any other job, if the recorder's condition changes, or if the judge is given more than a read token.

**The first run on `main`.** There is no `ci-data` branch yet and nothing has to be created by hand. Until the first recording every judge reads an empty history (a missing branch is an empty history, not an error), so it passes with the note that there is not enough data. The first push to `main` after the merge runs `flake-record`: the store builds a commit with no parent that holds `history/gha-linux-x64.jsonl` and pushes it as the new branch `ci-data`, then the macOS call adds a second commit on top of it with `history/gha-macos-arm64.jsonl`; both are authored and committed as `github-actions[bot]`. Two jobs that both find no branch settle it with the store's retry (the loser fetches the winner's tip and appends there), and running the job again records nothing new. [`tests/unit/ci/flake-jobs.test.ts`](../tests/unit/ci/flake-jobs.test.ts) runs this sequence with the workflow's own arguments against a temporary bare repository. What has not been seen is the push of the bot, with the job's token, on GitHub.

**When a build is judged.** Both jobs wait for `merge-gate` and use `if: ${{ !cancelled() }}` (ADR-171): a leg that is red does not skip them, because a build that flaked is the one to judge, and a run that was cancelled (the next push to the pull request does that) does not start them. Nothing can skip `flake`, so it is also what turns red when the legs never ran.

**The nightly** has the same two jobs, named `flake (nightly)` and `flake-record (nightly)`: the required check `flake` is the job of `ci.yml`, and two checks of one name would be ambiguous. Their steps are the same (a unit test compares them; a reusable workflow would have renamed the check, since a called job is named `<caller job> / <called job>`). The judge runs for every run of the nightly, the one a pull request that changes `nightly.yml` triggers included, which is the only time its wiring is exercised before the merge. The recorder runs for the schedule and for a manual run **on `main`** (a manual run of another branch only judges) and never for the pull request. The runs of the nightly hold the `@release` tests as well as the `@merge` ones: the history gets the flake rates of the release tier, and its `@merge` tests count as builds of their engine job, like the merge gate's. Two limits. The nightly runs the plain `test:e2e`, not `gate:merge`, so a quarantined test is not run apart and non-blocking there: it fails the nightly like any other. And a push to `main` and a night can record at the same moment, which is the race the store retries (a unit test records a push and a night, one after the other, into one history).

**Jenkins** runs the same script in a `Flake` stage after `Merge gate` ([jenkins/README.md](../jenkins/README.md), ADR-174): the engines stash their run files, the stage lays them side by side, judges them against a file history on a volume of its own and records the builds of `main` only, whatever their result. It runs when an engine is red. **It has not run in a Jenkins**: ADR-174 lists what a real build must prove.

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

## Measurements on GitHub runners

[`measure.yml`](../.github/workflows/measure.yml) runs **one long measurement on a GitHub runner** when somebody dispatches it, so that the measurements that need a machine to themselves (a performance baseline, its A/A check, a soak) run there while the workstation does something else, and in the environments the merge gate runs in (`gha-linux-x64`, `gha-macos-arm64`). Those environments need baselines of their own, which can only be recorded on them (ADR-126). It starts by hand and by nothing else (no push, no pull request, no schedule), has a read-only token and uses no secret. The decisions: ADR-175 to ADR-177 in [decisions/ci-measure.md](decisions/ci-measure.md). **Status: written, linted, unit-tested and its scripts run locally; it has not been dispatched on GitHub yet** (the last section lists what that leaves open).

| Input | Values | What it does |
| --- | --- | --- |
| `task` | `perf-baseline`, `perf-aa`, `ab`, `readiness`, `soak`, `flake-collect` | Which measurement. A closed list: GitHub refuses any other value. |
| `runner` | `ubuntu-24.04` (default), `macos-15` | The machine, and with it the environment id. |
| `engine` | `chromium` (default), `firefox`, `webkit`, `chromium-cpu4x` | The browser to install (`chromium-cpu4x` installs Chromium) and what the task is given: `--profile` for the performance tasks, `--engine` for `readiness` and `soak`, `--project` for `flake-collect`. An A/B plan names its own engine, so for `ab` it only picks the browser. `ab`, `readiness` and `soak` have no `chromium-cpu4x`: the job says so and stops. |
| `args` | text | Extra arguments for the task, split on spaces into words and handed over as words: nothing evaluates them, so there is no quoting, and a JSON value must not contain a space. |
| `repeat` | 1 to 50, default 10 | `perf-aa` only: how many times the gate is run against its own baseline. |
| `timeout_minutes` | 1 to 340, default 60 | The job's limit. The task itself is stopped 10 minutes earlier, so that the machine record and the results are still uploaded. |
| `label` | text, default `run` | Names the artifact, `measure-<task>-<label>-<runner>`; anything but letters, digits, dots, dashes and underscores becomes a dash, and 60 characters are kept. |

**Dispatch.** `<ref>` is the branch whose code is measured. A dispatch runs the workflow file **of that ref**, so the branch has to contain `measure.yml` (merge `main` into it first), and GitHub only offers the first dispatch of a new workflow once the file is on the default branch.

```sh
# the baseline of one profile in the environment of the runner (one dispatch per profile and runner: chromium, chromium-cpu4x, firefox, webkit)
gh workflow run measure.yml --ref <ref> -f task=perf-baseline -f runner=ubuntu-24.04 -f engine=chromium -f label=base1 -f timeout_minutes=90

# the gate against its own baseline, ten times: the baseline of gha-linux-x64 for that profile has to be committed in <ref>
gh workflow run measure.yml --ref <ref> -f task=perf-aa -f runner=ubuntu-24.04 -f engine=chromium -f repeat=10 -f label=aa1 -f timeout_minutes=180

# an A/B experiment: the plan names the engine, `engine` only picks the browser to install
gh workflow run measure.yml --ref <ref> -f task=ab -f runner=ubuntu-24.04 -f engine=chromium -f args='--prereg ab/prereg/pipeline-check.json' -f label=pipeline-check -f timeout_minutes=90

# the readiness checks: the workflow adds --engine
gh workflow run measure.yml --ref <ref> -f task=readiness -f runner=ubuntu-24.04 -f engine=chromium -f args='--checks all' -f label=rdy1 -f timeout_minutes=90

# a soak: --minutes is required (ci is 5 minutes, release is 30)
gh workflow run measure.yml --ref <ref> -f task=soak -f runner=ubuntu-24.04 -f engine=chromium -f args='--minutes ci' -f label=soak-ci -f timeout_minutes=60

# thirty repetitions of the merge tier, recorded in flake/history
gh workflow run measure.yml --ref <ref> -f task=flake-collect -f runner=ubuntu-24.04 -f engine=chromium -f args='--runs 30 --grep @merge' -f label=collect1 -f timeout_minutes=180
```

The timeouts are guesses from the design budgets (a performance job 12 minutes, [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 6.3), not measurements. Give each dispatch its own `label` (put the engine in it): a third dispatch with the same task, label, runner and engine cancels the second one that is still waiting.

**Download.**

```sh
gh run list --workflow measure.yml --limit 10
gh run watch <run-id>
gh run download <run-id> --name measure-perf-baseline-base1-ubuntu-24.04 --dir results/measure-perf-baseline-base1-ubuntu-24.04
```

The artifact holds `perf/baselines`, `docs/results`, `flake/history`, `reports` and `test-results` under the paths the repository uses, so what the task wrote can be copied into a checkout and committed. `reports/measure-produced.txt` lists the files the task wrote or changed (the artifact also carries what `docs/results` and `perf/baselines` already held). The job's summary page prints the machine record and the download command. A run with a failing task still uploads: the artifact is there to find out why.

**What each runner is called.** The code names it, and the workflow overrides nothing (`PB_ENV_ID` is not set; [`src/shared/env.ts`](../src/shared/env.ts) builds the id from `RUNNER_OS` and `RUNNER_ARCH`): `ubuntu-24.04` is **`gha-linux-x64`** and `macos-15` is **`gha-macos-arm64`**. A baseline therefore lands in `perf/baselines/gha-linux-x64/<profile>.json` or `perf/baselines/gha-macos-arm64/<profile>.json`, a result in `docs/results/<kind>/<id>...`, and none of it can be mistaken for a workstation's (`local-darwin-arm64`) or a container's (`docker-linux-arm64`). Firefox has not been run on `macos-15` in this lab: the merge gate runs it on Linux only.

**For the performance gate, in this order.** `perf-baseline` for each profile; download; commit the files into `perf/baselines/<id>/`; then `perf-aa` on a ref that contains them (the gate refuses to judge without a baseline of its own environment and exits 2, so every pass would be untrusted). The A/A check is the one that matters on a runner: it measures how often the gate raises a false alarm when the baseline was recorded on another VM, which is exactly the situation of a pull request. `perf-aa` writes `docs/results/perf/<id>/<profile>-aa.json` and `.md`; its passes that exit 1 are results (false positives, counted), and the job only fails when a pass exits 2.

**A shared VM is noisier than a quiet workstation.** A hosted runner is a virtual machine on hardware that other jobs share: its neighbours, the CPU model behind it and the image change from one run to the next, and nothing here makes it quiet or pins it. The performance harness assumes a machine that is otherwise idle and says so when it was not (it records the load average around every batch). So a number from a runner is read together with three things, and without them it is not a result: its **environment id** (baselines of one environment are never compared with another's, ADR-126); its **own variation** (the baseline holds every run and the coefficient of variation of each metric, and the A/A check measures the false alarms); and the **machine record** of the run, `reports/measure-machine.txt`: the environment id the code computed, the commit, the CPU model and count, the memory, the OS and image version, the load before and after, and the versions of Node, npm, Playwright and ffmpeg. Two dispatches of one task can land on different hardware (the record shows the CPU model): do not average them as if they were one machine.

## What is validated, and what is not

Done on the development host (Apple M2 Pro, macOS 27.2, Docker Desktop), 2026-11-04:

- `actionlint` 1.7.12 finds nothing in any workflow (`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest`). It does not read the steps of a composite action: the steps of `.github/actions/setup` were checked by running actionlint over a copy of them wrapped in a workflow.
- `npm run test:unit` includes [`tests/unit/ci`](../tests/unit/ci): the policies of the workflows (timeouts, no `continue-on-error`, `contents: read`, GitHub-owned actions pinned to a major version, no `pull_request_target`, no secret), the agreement between files (legs and Playwright projects, the legs of the gate and the nightly, the cache key and the generator's imports, the artifact names, the `npm` scripts) and the job summary. Each of the main rules was checked to fail when broken (a file the generator imports left out of the cache key, a leg that differs between the gate and the nightly, a typo in a project name, an artifact renamed on one side only, a job without a timeout, a `continue-on-error`).
- The parity of the two CI systems: [`tests/unit/ci/parity.test.ts`](../tests/unit/ci/parity.test.ts) compares `ci.yml` and the Jenkinsfile (the gate scripts and their order, the projects of the merge gate, the options of each script, the modes of the flake gate, that every `npm run` names a script that exists), with the differences that are allowed written in one list. It was run over files with one mistake each (a renamed gate in either file, an engine left out, an option in one only, a script made an alias): each is reported. The macOS WebKit leg, `--global-timeout`, and what depends on the history store are the allowed differences (ADR-173).
- The commands of the Firefox leg ran in the Playwright image with `--cpus 2` and `CI=true`, on the five streams generated on the host: 3 of 3 `@merge` tests passed in 8.5 s with two workers. `--list` shows what each project selects: 3 tests in each engine and 1 in `chromium-cpu4x`.
- The flake jobs: `actionlint` 1.7.12 with `shellcheck` 0.11.0 (the native binaries) finds nothing in the workflows, and `npx prettier --check .github` passes. [`tests/unit/ci/flake-jobs.test.ts`](../tests/unit/ci/flake-jobs.test.ts) reads the arguments out of the workflow text, compares them with the legs of the matrix (one invocation per environment, each with the artifacts of its own legs), and runs them through the real gate against a temporary bare git repository laid out as the job lays out its workspace: a judge on an empty history writes nothing, the first recording creates `ci-data` as an orphan with one commit per environment, authored by the bot, and leaves `main` alone, a re-run adds nothing, and a leg without run files makes the gate exit 2. The same file runs `npm run gate:flake -- --help` and found a defect that no other check would have: the script was an alias of another one (`npm run flake:gate`), npm gives the arguments of an alias to itself, and every flag of the workflow would have been dropped. The script now runs the gate directly. The judging commands were also run, through `npm`, on the real `reports-<leg>` artifacts of the last green run of `main` (`gh run download`), against the real remote, which has no `ci-data`: both environments pass with "not enough data" and nothing is written. The recording commands were run on the same artifacts against a temporary bare repository: the first write creates `ci-data` as an orphan with one commit per environment, authored and committed as `github-actions[bot]`, a re-run adds nothing, and the `jq` check of the recorder passes. The two commands of the Jenkinsfile's `Flake` stage are run by the same test file against a history directory laid out as its unstash loop lays it out.
- The measurement workflow: `actionlint` with `shellcheck` finds nothing (a planted `SC2086` in a scratch workflow was found, so the shell checks were on), Prettier passes, and [`tests/unit/ci/measure.test.ts`](../tests/unit/ci/measure.test.ts) keeps its properties: only `workflow_dispatch`, `contents: read`, no expression in any script, an input only under keys that cannot be code, closed choices, a branch for each task that calls a script and a file that exist or are listed as pending with their branch, the artifact, the limits. It was run over copies with one mistake each, and over the file itself with an input pasted into a script. The scripts of the job were also run from the workflow's own text: the artifact name with hostile labels (`$(id)`, backticks, quotes, a newline, `::set-output`), the check of the inputs over valid and invalid values, the run step with `npm` and `npx` replaced by functions that print their arguments (the command of every task, the arguments as separate words and not expanded, the A/A loop with a pass that exits 1 and one that exits 2), the machine record on macOS, and the step that lists the files the task wrote, which had two bugs that only running it showed (a directory that does not exist made `find` fail the step, and appending to the machine record before listing the files made every file older than it).

**Not validated, because it needs a GitHub run:**

- The time of every job and of each setup step, the cache hit rates, and so every number in the budget column: [TEST_STRATEGY.md](../TEST_STRATEGY.md) section 6.3 holds design estimates until runs replace them.
- Whether `npx playwright install --with-deps <one browser>` works and is fast on `ubuntu-24.04` for each of the three (the probe job installed all three at once), and whether the browser cache saves anything (Playwright's own guide says it does not).
- Whether Linux WebKit passes the real player page on an x64 runner (the evidence is arm64 in Docker), and how often.
- The macOS leg: its time on a 3-CPU runner, and that `jq` is on the image (the setup action uses it to list the streams).
- That an artifact uploaded with `actions/upload-artifact@v7` (stored uncompressed, hidden directory included) downloads with `actions/download-artifact@v8` into the path the service reads, and that a second job of the run restores the cache entry the first one saved.
- Both flake jobs on GitHub: that `download-artifact` lays the files out as its source says (the layout above), that the fetch of `ci-data` works from a checkout that keeps no credential, that the push of the bot with the job's token creates the branch and is accepted (and that no rule added later forbids it), the time of the jobs, and how the gate's report renders on the job summary.
- What a required `flake` check does to a pull request whose legs were skipped by a failed `streams`: never observed (ADR-171). To see it, break `streams` on a throwaway branch and read the checks of its pull request.
- The `Flake` stage of the Jenkinsfile, in a Jenkins: that the file loads, that the stash and unstash carry the run files across the parallel workspaces, that the stage runs after a red engine, that the history volume is writable and keeps the file, and that a build of `main` is recognised as one. The round that wrote it had no Docker; ADR-174 lists what a real build must show.
- The measurement workflow on GitHub, which has never been dispatched: that the expressions of the job's and the step's `timeout-minutes` are accepted with a number input, that a step stopped at its limit lets the upload run, the Linux branch of the machine record (shellchecked and read, not run), that a dispatch on a branch reads the workflow file of that branch, and that the artifact name is accepted. And the task whose file is on another branch (`ab/run.ts` on `p6/ab`): the workflow was written against the command line read in that worktree (ADR-176), and nothing here ran it. `perf-baseline` and `perf-aa` have been dispatched since (five baselines, thirteen A/A jobs); `readiness` and `soak` had not been when this was written: the workflow was written against the command lines read in those worktrees (ADR-176), and nothing here ran them.
- That a reusable workflow called with `uses: ./.github/workflows/streams.yml` and a local composite action behave as the documentation says on a pull request from the same repository.
- Whether Playwright's own stop at the limit behaves on a runner as it did on the development host (a 6 s limit on two tests wrote the report with the errors of the run and both tests marked as not run), and whether the upload step runs after a job that the runner itself timed out.
- The rendering of the job summary.
- That a run that is re-run replaces its artifacts cleanly (`overwrite: true`).

## Adding a job

A stage that gets its own script in `package.json` gets its own job in `ci.yml` (and its call in the Jenkinsfile): `gate:triage` was added this way after `gate:flake`, and `gate:perf` gets its job when the baselines of the runner are committed. A script that a pipeline gives arguments (`npm run gate:x -- --flag`) runs its command itself and is not an alias of another npm script: npm gives the arguments of an alias to itself, and they never reach the command (`gate:flake` and `gate:perf` had that defect, and both now run their command itself). A job that needs the streams says `needs: streams`, checks out, and calls `./.github/actions/setup` with `streams: 'true'`. The nightly's soak, readiness and A/B jobs go after `streams` in [`nightly.yml`](../.github/workflows/nightly.yml), where the comment says so. `npm run test:unit` fails if a new workflow asks for a write permission outside `flake-record`, uses a third-party action, runs a job without a timeout, or calls an `npm` script that does not exist. A job that really needs to write is a decision: `flake-record` is the one so far, named in the test with its reason, and its job, not the whole workflow, carries the permission.
