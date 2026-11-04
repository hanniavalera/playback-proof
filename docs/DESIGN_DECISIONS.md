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
