# A/B testing of player configurations

This lab can answer one question with numbers instead of an opinion: **does the tuned configuration of the player (B) start faster or stall less than the library defaults (A), under a stated network?** It does so the way an experiment should be run: the plan is written and committed first, the harness has to pass an A/A check before anyone is allowed to believe it, the two arms are interleaved in time, the report says what was found and what it cannot say, and a result that cannot be trusted says so instead of pointing in a direction.

> **No A/B result of this lab has been measured yet.** The harness is built and tested (the statistics against an independent implementation, the verdict rule and the validity gates with mutation checks, the whole pipeline with a fake browser, and once for real with a six-session pipeline check that is labelled plumbing only, not evidence: [docs/results/ab](results/ab/README.md)). The pilots and the experiments are Part 2 of Phase 6. Until the A/A check has passed in an environment, no verdict is published for it.

## B is several settings together

Configuration A is the library with no overrides. Configuration B overrides **four settings at once** (`src/player/configs.ts`, ADR-064 in [decisions/player.md](decisions/player.md)):

| Setting | Shaka's default | Configuration B |
| --- | --- | --- |
| `abr.useNetworkInformation` | true | false |
| `abr.defaultBandwidthEstimate` | 1000 kbps | 500 kbps |
| `abr.switchInterval` | 8 s | 4 s |
| `streaming.bufferingGoal` | 10 s | 20 s |

The experiments compare **the two configurations as they are shipped**, not the settings one by one: arms of "A plus one setting" were considered and are not built. So the report cannot say, and no sentence of a plan or of a report may say, that an effect comes from one of the settings. (The validator refuses a plan whose text names one of them, and a test fails if a report names one outside the table of the arms and the one sentence that says all four are in play.) One consequence is visible in the data: A starts on the 720p rung in Chromium and B on 240p everywhere, so a startup difference may be the first rung and nothing else; the report counts the start rung of every session and says so.

## How to read a result

An experiment ends in one of **four verdicts**, never conflated, each driving one action:

| Verdict | What the data show | What it drives |
| --- | --- | --- |
| **B better** | The whole 95 % interval of a primary metric lies beyond the smallest effect worth acting on, in B's favour, after correction for several metrics, and no other primary metric can be worse than that threshold. | Ship B. |
| **A better** | B is worse than that threshold on a primary metric and the interval excludes zero. | Do not ship B. |
| **Equivalent within the margin** | The whole interval of every primary metric lies inside plus or minus the margin. The only verdict that may say there is no meaningful difference. | Keep A. |
| **Inconclusive** | The interval is too wide to decide. The report says how many more sessions per arm the observed spread would need. | Keep A, collect more sessions. |

**Not finding a difference is not evidence that there is none.** A result that is not significant and has a wide interval is *inconclusive*, and the report says so in those words. The margin and the smallest effect worth acting on are one number, the practical threshold written in the plan with the reason for it, and never below what the design can tell from noise.

**Separately, a run is valid or it is not.** The lab passes an experiment when it was valid, not by the direction of its result: the plan was committed before the run, the sessions are the planned schedule, every page proved the configuration of its arm, the service proved the network condition in every session, few sessions failed and alike in both arms, the machine was quiet when the run started, and the A/A check of this environment had passed. A run that is not valid prints "the verdict below must not be acted on, whichever way it points". The exit code follows validity (0 valid, 1 a valid A/A run in which the harness failed its own check, 2 not valid or could not start).

## How an experiment goes

1. **Write the plan** (`ab/prereg/<id>.json`, schema in [CONTRACTS.md](CONTRACTS.md) section 9.2): the metrics and which of them decide, the condition as written-out fault rules (**finite links only**: the player ignores downloads that take under 5 ms, so a link the estimator cannot hear would compare the speed of the machine), the sessions per arm (at least 30, even), the threshold with its basis, the decision rule, the seed. **Commit it.** The runner refuses to run a plan git cannot show to be committed and unmodified, and the results carry its text and its sha256.
2. **Pass the A/A check** (PB-AB-001). Both arms run the same configuration through the runner, and the A/A calibration splits that pool at random 2000 times and applies the whole pipeline to each split: every split that comes out significant is a false positive, and the check passes when the data do not show that rate to be above 5 %. The plan of an experiment names the committed A/A report (`aaCheck`), and the runner stops, exit 2, if it is missing or did not pass in this environment.
3. **Size the design** (`npm run ab -- --power <pilot results> --only-a`): the minimum detectable effect and the verdicts a design can reach. The threshold of an experiment is never below the minimum detectable effect of the pilot.
4. **Run it** (`npm run ab -- --prereg ab/prereg/<id>.json`, alone, on a quiet machine): one browser per condition, a fresh context and a service session per session, the arms interleaved in blocks of two with the first arm alternating (A B, B A, A B), the first blocks a warm-up that is recorded and left out, failures recorded and never retried, and every session proving what it ran: the page reports its configuration, the service reports the rules it held and how many requests each one fired on.
5. **Read the report** (`docs/results/ab/<id>.<environment>.<start>.report.md`), and regenerate it from the raw results any time with `npm run ab -- --report <raw results>`: the same bytes, no browser.

## What a report contains

The verdict and whether the run was valid, with the seven gates and what each checked; the decision rule applied step by step; for every primary metric the effect (a Hodges-Lehmann shift, or the difference of the shares of sessions that stalled), its 95 % interval, Cliff's delta, the test, the adjusted p-value and the threshold; the distribution of each arm; the start rungs; the sessions, failed ones included; the secondary metrics (described, never decisive); everything else that was recorded, labelled exploratory with raw p-values; the **limits** (one engine, localhost and synthetic content, one condition, B being several settings together, what an interval means, that in Chromium a stall is counted when the audio runs out and not when the picture freezes, and that part of a startup difference may be the first rung); the design and the plan as registered; and the environment, date, commit and load of the machine.

## The statistics, in one paragraph

Nothing assumes a shape: startup times are skewed and most sessions never stall. The test is Mann-Whitney U (exact where that is cheap and where ties are heavy), the effect is the Hodges-Lehmann shift with a seeded percentile bootstrap interval, the stall metric is a share (Fisher's exact test, Newcombe's interval), and the p-values of the primary metrics are adjusted with Holm's method. They are written out in TypeScript so that every number can be traced, **and checked against scipy and numpy** on committed vectors (`ab/vectors`; python is in no gate and no CI job), against brute-force enumeration, against published examples and against mutations that each have to fail a test. The reasoning is in [decisions/ab.md](decisions/ab.md) (ADR-140 to ADR-149).

## Commands

| Command | What it does |
| --- | --- |
| `npm run ab -- --prereg ab/prereg/<id>.json` | Runs the experiment of a plan: validates, refuses without a committed plan, runs, writes the raw results and the report, prints the verdict and the validity. |
| `npm run ab -- --report <raw>` | Writes the report again from the raw results. |
| `npm run ab -- --calibrate <raw> [--only-a]` | The A/A calibration of the pool of sessions of a results file. |
| `npm run ab -- --power <raw> [--only-a]` | Minimum detectable effect, power curve and the verdicts a design can reach. |

Exit codes: 0 valid (any of the four verdicts), 1 a valid A/A run in which the harness failed its own check, 2 not valid or could not start, 130 interrupted (nothing written). Ports 4720 to 4729. The full contract is [CONTRACTS.md](CONTRACTS.md) section 9.2.

## README-ready summary

> **A/B testing of player configurations.** Two configurations of the Shaka player (the library defaults, and a tuned candidate that changes four settings together) are compared on pre-registered metrics, startup time under high latency and rebuffering on a link that drops, in interleaved sessions with the network condition proved by the test service in every session. The harness passes its own A/A check first; a result is one of four verdicts (A better, B better, equivalent within the margin, inconclusive), and the lab passes a run for being valid, not for what it found. Statistics are written out in TypeScript and cross-checked against scipy. See [docs/AB.md](AB.md).
