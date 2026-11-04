# Design decisions

Architecture decision records for the lab, written so each one can be defended in a review: what the situation was, what was chosen,
what was rejected and why, and what it costs. New decisions are appended as the phases land.

## ADR-001: Stream formats and the browser matrix come from a real-decode probe, not from `isTypeSupported`

**Context.** The lab must run the same suites in Chromium, Firefox and WebKit using Playwright's bundled builds. Those builds differ in which codecs and
which media pipelines they have. A first probe (a real `MediaSource` append and play of small ffmpeg-generated files, in a fresh browser process per case)
showed:

- macOS (arm64): Chromium 156 and WebKit 27.2 play VP9 and H.264 video, AAC audio and VP9+Opus WebM; WebKit does not support Opus in MP4. Playwright's Firefox 157 does not start on this host (`Could not find profile folder`).
- Linux (arm64, the Playwright image): Chromium and Firefox play everything tried. **WebKit exposes `MediaSource`, answers `isTypeSupported` with `true` for
  every type, and cannot play any of it**: plain `<video src>` works for the same files, MSE playback ends with `MediaError 4: Failed to push buffer`, and
  it is intermittent (one of three attempts of one case played).

**Decision.**

1. The primary format is **CMAF fragmented MP4 with VP9 video and AAC audio**, packaged as DASH and as HLS from the same segments. It plays in Chromium (macOS and Linux), Firefox (Linux) and WebKit (macOS).
   VP9 is used for video because it is open and decodes in all three without proprietary codec licences.
2. A **WebM VP9+Opus** DASH fixture covers the open-codec path (Chromium, Firefox, WebKit on macOS).
3. WebKit playback suites run on **macOS** (locally and on GitHub's macOS runners). On Linux WebKit the MSE specs are skipped with the documented reason; the capability probe keeps reporting it so a fixed upstream build is noticed.
4. Firefox runs on Linux (CI, Jenkins, Docker). On the macOS development host it runs in Docker.
5. Tests choose a stream flavour from the **capability probe of the browser they run in** (it decodes real media), and fail loudly when no flavour plays and the combination is not a documented gap.

**Rejected.** "Use `isTypeSupported` and skip what is false": it reports `true` for everything on Linux WebKit, so it would have produced a red or flaky WebKit job and taught nothing.
"Install Chrome and Safari": it would stop testing the engines Playwright ships and make CI depend on proprietary installs. "Drop WebKit": it removes the engine with the most distinctive MSE behaviour.

**Consequences.** Three jobs per pull request instead of one, one of them on a more expensive runner. In return the matrix is honest: every gap has evidence in [CODEC_MATRIX.md](CODEC_MATRIX.md).

**Defending it.** "I measured it. Capability reporting and capability reality disagree in one engine, so the lab decodes a real clip before it trusts a codec. The matrix and the gaps are generated, not asserted."

**Update.** The committed probe results ([CODEC_MATRIX.md](CODEC_MATRIX.md)) refine point 3: on Linux WebKit the MSE verdict is intermittent rather than a flat failure, and it depends on how the page drives the element. See [ADR-031](decisions/codecs.md). The rest of this record stands.

## ADR-002: Network faults are injected by the test data service, not by the browser

**Context.** The scenarios need bandwidth caps, latency, error statuses, stalls, truncated bodies, and a live origin that stops publishing. Chromium's DevTools protocol can emulate network conditions; Firefox and WebKit cannot.

**Decision.** The service that serves the streams applies the faults. A fault is data (`src/shared/faults.ts`) attached to one session; throttling is one token bucket per session shared by concurrent responses.

**Alternatives.** CDP `Network.emulateNetworkConditions` (Chromium only; the cross-browser comparison would be a lie). OS-level shaping (`tc`, `pfctl`; needs root, differs per OS, not available on macOS CI runners without sudo). A proxy (another moving part, another place for jitter).

**Consequences.** Identical conditions in every engine and every CI system. Faults are observable in the same place they are applied (the request log). The service must be correct, so it has its own unit tests (including that the token bucket really holds the configured rate).

**Defending it.** "The unit of comparison across engines is the condition, so the condition has to be applied below the engine, once."

## ADR-003: One isolated session per test; virtual live clock over looped content

**Context.** Tests run in parallel and in three engines; live streams must run for as long as a soak test needs and be reproducible.

**Decision.** Every test creates a session: its own live clock, fault rules, token bucket and request log. Live content is a short pre-encoded loop; the service republishes it as a monotonic timeline by rewriting each fragment's `tfdt`. Session time starts at the session's creation, and tests move the world with events (a rule, a seek), not with sleeps.

**Alternatives.** Run ffmpeg in real time for live (non-deterministic, CPU hungry, skews the performance measurements the lab exists to take). Shared global state (tests would interfere). A fixed live manifest (cannot test the edge, latency or stalls).

**Consequences.** Determinism and parallelism at the cost of a small packager (the rewriter) that must itself be tested: it has unit tests against real ffmpeg output.

## ADR-004: Performance baselines are per environment, summarized by median and p90, and a regression must reproduce

**Context.** The gate must fail merges on real regressions and not on noise. Shared CI runners are noisy, laptops are different machines than CI, and averages hide tails.

**Decision.**

- Baselines are JSON files committed per environment id (`detectEnvId()`), per profile and per scenario: `perf/baselines/<env>/<profile>.json`. They are never compared across environments.
- Every scenario runs N times (default 10) in fresh browser contexts; the summary is the median and p90.
- A metric fails when the median is worse than the baseline by more than the relative threshold **and** an absolute floor (so a 5 ms change in a 40 ms metric cannot fail the build), or the p90 is worse by more than the wider p90 threshold. Rebuffer count and dropped-frame ratio use absolute budgets, since their baseline is usually zero.
- On a first failure the gate re-measures with fresh runs and fails the build only if the regression reproduces.
- The thresholds were set from measured run-to-run variation (the coefficient of variation of the baseline runs is committed with each baseline), not guessed.

**Alternatives.** One global baseline (meaningless across machines). Mean-based thresholds (tail blind). Fixed absolute limits (they fail on slow runners and pass real regressions on fast ones). Fail on the first violation (a noisy runner would block merges).

**Consequences.** Baselines need regenerating on a new machine class (there is a workflow for it) and the two-stage gate costs more time on a failing build only.

**Update.** The rule as built in Phase 5 ([ADR-120 to ADR-129](decisions/perf.md)) refines three points of the text above. The floor protects **both** statistics, not only the median. The "worse tail" is the p90 where higher is worse and the **p10 where lower is worse** (the frame rate). And a metric whose baseline is **noisier than a stability limit is tracked and reported, not gated**, which is what TEST_STRATEGY.md section 7.1 already says. The thresholds are assumptions until the baselines of Phase 5 part 2 measure the variation they are derived from.

## ADR-005: Tests wait on player events, with a cursor; no fixed sleeps

**Context.** Sleeps are the most common source of flaky media tests: too short fails on a slow runner, too long makes the suite slow and still races.

**Decision.** The player page records an event timeline and exposes `waitFor(name, { since })`. A test takes a cursor before an action, acts, and waits for events after the cursor, so an event that fires "too early" cannot be missed. Where the player cannot tell (what did the server see?), the test reads the service's request log. ESLint forbids `waitForTimeout` and `setTimeout` in specs.

**Alternatives.** `expect.poll` on metrics (polling hides ordering and adds latency). Playwright auto-waiting alone (it waits for DOM state, not media state).

**Consequences.** The player carries a small, tested instrumentation layer; in exchange every wait is as short as the event and as long as the system needs.

## More decisions

- [Test strategy (ADR-020 to ADR-027)](decisions/strategy.md): risk-based tiering and the merge threshold, the merge gate and its time budget, the flake and quarantine policy, how the readiness criteria were derived, what the lab refuses to claim, the catalog as a checked list of record, named fault profiles, and the experiment policy.
- [Codecs and the capability probe (ADR-030 to ADR-037)](decisions/codecs.md): why real-decode probing instead of `isTypeSupported`, verdicts measured under a named page profile, why an intermittent flavour counts as unsupported, how a documented gap is skipped with evidence, why the matrix is generated from validated JSON, the Docker runner, reproducible probe media.
- [The media pipeline (ADR-040 to ADR-049)](decisions/media.md): VP9 in CMAF, real-timing `SegmentTimeline`, the audio cutting rule and the equal-loop-length invariant, `tfdt` rewriting for a gapless live loop, no `sidx`, determinism and its limits, the content-addressed cache with atomic writes, the ClearKey stream.
- [Response delivery (ADR-050 to ADR-054)](decisions/server-delivery.md): the shared token bucket and why it lives in the service, fairness between concurrent responses, smooth pacing, back-pressure and disconnects, what the throttle does not model.
- [Static serving (ADR-055 to ADR-057)](decisions/server-static.md): resolve, `realpath` and a prefix check instead of string sanitising, decoding exactly once, what the module is not.
- [The player page and `window.__qa` (ADR-060 to ADR-069)](decisions/player.md): an event timeline with a cursor instead of polling, metrics as pure functions of the timeline, how seek-caused buffering is excluded, why live latency is measured to the availability end, configurations A and B as falsifiable hypotheses, what the hook does not measure.
- [The test data service (ADR-080 to ADR-091)](decisions/server.md): a hand-rolled `node:http` service, isolation by construction (everything a test can change lives in its session), the order of the media request pipeline, the request log listed from arrival, the live clock and the stall model as implemented, how several faults on one request combine, throttle wiring, errors and limits, one URL per resource, security choices and what they do not cover, start and stop and the CLI, what the service does not model and how it was checked (smoke, benchmark, mutations, and the memory step that is not flat).
- [The end-to-end support library (ADR-070 to ADR-079)](decisions/e2e.md): a typed handle on `window.__qa` instead of `page.evaluate` in specs, a session per test created and deleted by a fixture, documented gaps resolved from committed evidence (and the one override that runs Linux WebKit as an experimental engine against the probe's verdict), failure diagnostics as attachments with fixed names, waits on events and on the server's log with the one polling primitive in lab code and the one frame-counting primitive for negative observations, specs traced to the catalog with the compiler API, what the CPU throttle can and cannot say, what PB-ENV-001 checks, failures that point at the spec's line, and the order of the fixtures.
- [ClearKey and EME (ADR-104 to ADR-105)](decisions/e2e-eme.md): what the lab proves with ClearKey and what it does not (no commercial DRM, a public key, a data-URI license), the wrong key with the right key id as the control that reaches the decryption, what each engine really does (Chromium and Firefox decrypt in the browser's own module, WebKit only because the player decrypts, Linux WebKit has no EME at all), the Firefox key table that is shared by the pages of a context, why the spec asserts who decrypts and confirms a documented gap before it skips, and the mutations that turn it red.
- [The performance harness (ADR-120 to ADR-129)](decisions/perf.md): what is repeated (one browser process per batch, a fresh context per run, a warm-up that is recorded and discarded), the percentile definition and the summary, why the service is a child process, thresholds as data with a basis (assumptions until measured), noisy baselines that are tracked and not gated, a regression that must reproduce in a fresh batch, per-environment baselines that validate, the start rung as part of the measurement, exit codes that separate a regression from a problem, and what a lab number does and does not mean.
- [Flake tracking: how it works and how to use it](FLAKE.md): what a flake is, what the gate fails on and the decision each failure drives, a worked quarantine, where the history lives and why, what is excluded from the rates, what the rate cannot tell, and how the real data is collected.
- [Flake tracking decisions (ADR-130 to ADR-139)](decisions/flake.md): a reporter that records every attempt, what counts as a flake observation, the error signature that triage reuses, a history of JSON lines per environment, why it lives on an orphan git branch in CI (and not in an artifact, a database or a committed file) and how a lost push race is made again without force, the statistics behind the verdicts, the strict quarantine list, the gate and the decision each failure drives, the quarantine-aware merge wrapper and the collector, and what the numbers cannot tell and how the gate was mutation-checked.
- [The live suites (ADR-098 to ADR-100)](decisions/e2e-live.md): the playhead judged by two readings (the player's latency and the origin's published edge) because the hook has no seek range, refreshes counted on the origin's log and a pause measured in segments the origin published instead of seconds, what is deliberately not asserted and the two flakes the first stability series found in the specs themselves, the limits imported and the numbers of every run kept, the measured distribution against the limits (none contradicted, all loose), and six mutations that turned the six specs red.
- [The VOD suites (ADR-092 to ADR-094)](decisions/e2e-vod.md): where each tolerance of the playback specs comes from (the content and four engines, in one file, and the two bounds that a real run corrected), how the seek specs read the origin's log (a refetch that survives the adaptation climbing a rung, what Shaka does on a seek, and why "evicted" is a flush), how the metrics-integrity spec checks the instrument against the stream's frame rate, the origin's clock and the wall clock, and why a spec that asserts that nothing moves shows first that something moves.
- [The recovery suites (ADR-101 to ADR-103)](decisions/e2e-rec.md): a recovery test proves the fault fired (from the origin's request log, or its own state for a live stall) before it judges the recovery, oracles that are the outcome and the invariants of Shaka's failure path and not a sequence of requests (the ABR's climb pre-empts retries in engines that start on a low rung), time bounds written as arithmetic from the retry defaults, and the live conditions: the 10 s origin stall that the defaults recover from without bringing the latency back, and a stale manifest that outlives a short DVR window.
