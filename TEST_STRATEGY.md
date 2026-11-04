# Test strategy: Playback Proof

How we decide that a build of a web video player is fit to merge and fit to release, and what we do when a test fails.

> **Status.** Phase 1: the strategy and the policy numbers every later phase is built to. It is written before the components exist, so it says what the lab does and will do, not what it has measured. **Nothing in this document is a measurement.** Every number is either rendered from code (`src/shared`, with the kind of basis it has: fact, arithmetic or assumption) or computed from the catalog below, and the real results arrive with their phase, each with its environment, date and commit. Built so far: the contracts and shared types (Phase 0) and this strategy with its policy code and documentation checks (Phase 1).

Contents: [1 Purpose](#1-purpose-scope-and-non-goals) · [2 The lab](#2-the-lab-on-one-page) · [3 Member scenarios](#3-member-scenarios) · [4 Risk ranking](#4-risk-ranking) · [5 Levels and environments](#5-test-levels-and-environments) · [6 Gates](#6-what-gates-a-merge-and-what-gates-a-release) · [7 Performance and flake policy](#7-performance-and-flake-policy) · [8 Live readiness](#8-live-event-readiness) · [9 Catalog](#9-test-catalog) · [10 What a failure drives](#10-what-a-failure-drives) · [11 Test data and fault profiles](#11-test-data-and-fault-profiles) · [12 Experiments](#12-experiments-ab-policy) · [13 Gaps and limits](#13-known-gaps-limitations-and-risks-of-the-strategy-itself) · [14 Traceability](#14-traceability-how-this-document-stays-true)

Companion documents: [docs/CONTRACTS.md](docs/CONTRACTS.md) (interfaces, URL layout, API, `window.__qa`), [docs/METRICS.md](docs/METRICS.md) (what every metric means), [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) (ADR-001 to ADR-005) and [docs/decisions/strategy.md](docs/decisions/strategy.md) (ADR-020 to ADR-027: the decisions behind this document).

## 1. Purpose, scope and non-goals

**Purpose.** We gate merges on the smallest set of tests that covers the biggest risks inside a fixed time budget (section 6.3), and we gate releases on everything else. Every test is in the suite because a risk ranked above a line (section 4); every test has a decision attached to its failure (sections 9 and 10); every number that decides a gate comes from one file ([`src/shared/criteria.ts`](src/shared/criteria.ts)) and says where it comes from. The document is written so that a team could adopt it: it is opinionated where a choice had to be made, and it says what it cannot do.

**System under test.** An open-source MSE player, Shaka Player 5.3.3, embedded in a minimal page (`src/player`) that exposes the test hook `window.__qa`, playing streams from a deterministic test data service. We test the integration: does the player, configured the way we configure it, start, seek, adapt, recover and stay live in Chromium, Firefox and WebKit? We do not test Shaka Player's internals, and we do not test the browsers.

**In scope.**

- VOD and simulated live events, over DASH and HLS (CMAF fragmented MP4 with VP9 and AAC) and an open-codec WebM path (VP9 and Opus, DASH).
- Start, play to the end, pause and resume, every kind of seek.
- Adaptive bitrate on a network that changes, and recovery from CDN and origin faults (failed, slow and truncated segments, a dead rung, a dead manifest, a live origin that stalls, a stale live manifest).
- Performance (startup, rebuffering, frame rate) as baselines and regression gates, including a CPU-throttled low-end profile; A/B comparison of two player configurations.
- Live-event readiness (start, latency, stall recovery, manifest cadence, soak), flake tracking with a quarantine policy, and failure triage.

**What the lab cannot tell you.** These are non-goals, not oversights. Each one needs a different instrument than a localhost lab.

| Question you might ask | Why the lab cannot answer it | What would |
| --- | --- | --- |
| Will members enjoy it in production? | Production quality of experience needs real audiences. The lab runs on localhost, with software decoding and synthetic test patterns. | Field telemetry at scale. |
| Does it survive a real CDN? | There is no CDN: no caching behaviour, multi-CDN failover, TLS or HTTP-version effects, real round trips or packet loss. Faults are simulated at the origin, identically for every engine. | Staging traffic through the real delivery path; chaos tests there. |
| Does it work on the television in the living room? | There are no real devices: no hardware decoders, memory limits, vendor browsers or remote-control input. The low-end class is stood in for by a 4x CPU throttle that exists in Chromium only. | A device lab. |
| Is DRM ready? | The only key system is ClearKey (the stretch goal, PB-EME-001: [what it proves and what it does not](docs/decisions/e2e-eme.md)). No commercial DRM, no license servers, no robustness levels. | The vendors' own test suites and real license infrastructure. |
| Do video and audio look and sound right? | The lab checks that frames are decoded and presented and that the clock moves. It does not judge picture or sound quality or perceived audio and video sync. | Perceptual metrics and human review. |
| Captions, ads, picture-in-picture, accessibility? | Not covered at all. | Dedicated suites. |

Also out of scope: low-latency chunked live (the simulation uses 2 s segments), multi-audio and language switching, offline playback, casting, and any ladder above 720p. "Engine" below means the build Playwright ships (Chromium, Firefox, WebKit), not a consumer browser product.

Numbers the lab produces are laboratory measurements: they compare builds and configurations under identical conditions. They are never presented as production quality of experience, and never compared across environments (ADR-004).

## 2. The lab on one page

```
ffmpeg test patterns ──▶ test data service ◀────── HTTP ──────▶ player page
(testsrc2, sine)         · one session per test                   · Shaka Player 5.3.3
                         · fault engine: throttle, latency,       · window.__qa: events, metrics, actions
                           404/5xx, stalls, live stall,
                           stale manifest
                         · live clock over a looped source
                         · request log
                                  ▲                                        ▲
                                  │ what the player fetched                │ what the player says it did
                                  └─────────────────────┬──────────────────┘
                                                        │
              Playwright suites ──  chromium · firefox · webkit · chromium with a 4x CPU throttle
              harnesses ──────────  performance · A/B · readiness and soak
                                                        │
              flake history · performance baselines · failure triage ──▶ CI gates (GitHub Actions, Jenkins)
```

| Part | What it does | Built in |
| --- | --- | --- |
| Test data service (`src/server`) | Serves deterministic VOD and simulated live streams over DASH and HLS from ffmpeg test patterns. Every test gets its own session: its own live clock, fault rules, token bucket and request log. Faults are applied by the service, so the condition is identical in every engine. | Phase 2 |
| Player page (`src/player`) | Shaka Player with two configurations (A: library defaults; B: a tuned candidate) and `window.__qa`: an event timeline with a cursor, a metrics snapshot, and actions that resolve on the resulting event. | Phase 2 |
| Playwright suites (`tests/e2e`, `tests/live`) | The catalog (section 9) in Chromium, Firefox and WebKit, plus a CPU-throttled Chromium project. Tagged `@merge` or `@release`. | Phases 3 and 7 |
| Harnesses (`perf/`, `ab/`, `tests/live`) | Performance runs against committed baselines, A/B comparison, readiness checks and the soak. They use the Playwright library API and run alone on a quiet machine. | Phases 5 to 7 |
| Flake tracking (`flake/`) | A reporter that records every attempt, a history, the flake rate per test, a quarantine list and the gate. | Phase 5 |
| Failure triage (`triage/`) | Clusters failures by root cause with deterministic signatures; an optional language-model summary when a key is configured. It never decides a verdict. | Phase 8 |
| CI | GitHub Actions and a Jenkinsfile that call the same `gate:*` scripts. | Phase 4 |

**Principles.** Risk before coverage: tests earn their place through the ranking, not through a coverage number. Conditions are data: a fault profile is a named list of rules, applied below the engine, so a rerun sees the same condition. Two observation channels: what the player says it did (`window.__qa`) and what the server saw (the request log); where they can disagree, a test checks that they do not (PB-ABR-007). Events, not sleeps: specs wait on player events with a cursor (ADR-005) and ESLint forbids fixed sleeps. Every failure has a decision. No invented numbers.

The interfaces between these parts are in [docs/CONTRACTS.md](docs/CONTRACTS.md), the definition of every metric in [docs/METRICS.md](docs/METRICS.md), and the architecture decisions in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md).

## 3. Member scenarios

A member is a person watching (a subscriber). These are the things members do, what they live through when it breaks, and which device and engine class matters. The last column says where it is tested.

| What the member does | When it breaks, the member | Device and engine class that matters | Tested by |
| --- | --- | --- | --- |
| Presses play | Stares at a spinner or a black frame, gets an error, or waits seconds longer than before. | Every engine. The slow device class feels startup first. | PB-VOD-001, PB-VOD-002, PB-VOD-013, PB-ENV-001, PB-PERF-001, PB-PERF-004 |
| Scrubs (seeks) | Sees the picture freeze after the jump, lands in the wrong scene, or loses playback after skipping around quickly. | Desktop engines (dragging a scrubber). Television and set-top classes (repeated jumps from a remote, slow seeks). | PB-VOD-006 to PB-VOD-010 |
| Pauses and resumes | Sees the picture keep running while paused, or resumes in the wrong place or after a stall. In live, a long pause must resume inside the DVR window. | Every engine. | PB-VOD-004, PB-VOD-005, PB-LIVE-006 |
| Finishes or replays a title | Gets no end of title, or a replay that is stuck at the end. | Every engine. | PB-VOD-003, PB-VOD-011 |
| Watches on a weak or changing connection | Stalls again and again instead of dropping quality, or stays on low quality after the network recovers. | Every engine: the adaptation logic is in the player, the network stack differs per engine. | PB-ABR-001 to PB-ABR-007, PB-PERF-003 |
| Chooses a quality | Gets a stall or an error from a menu choice. | Every engine. | PB-ABR-004, PB-ABR-005 |
| Meets a CDN hiccup in the middle of a title | Sees an endless stall or an error screen where a retry or a lower quality would have been invisible. | Every engine; error handling differs in each network stack. | PB-REC-001 to PB-REC-007 |
| Watches a live event | Falls behind the action (and hears about the goal from another screen), sees the picture die minutes in when the window slides, or has the player's memory grow over a long match. | Long sessions on desktop Chromium and television classes; every engine for latency and window logic. | PB-LIVE-001 to PB-LIVE-004, PB-RDY-001 to PB-RDY-005 |
| Joins late (the kick-off crowd, or mid-event) | Lands far behind the live edge, cannot rewind inside the DVR window, or cannot get back to live. | Every engine: this is where live-edge arithmetic is exposed. | PB-LIVE-001, PB-LIVE-005 |
| Lives through an origin outage during a live event | Sees a frozen picture for everyone at once, or a picture that returns but stays further behind. | Every engine. | PB-REC-008, PB-REC-009, PB-RDY-003 |
| Is on a slow device (a low-end television or set-top box) | Waits long for the first frame, sees judder from dropped frames, or waits seconds for a seek. | The low-end class. **Simulated by a 4x CPU throttle through the DevTools protocol, in Chromium only.** | PB-PERF-004, and the rows whose engines include `chromium-cpu4x` (PB-VOD-001, PB-VOD-007, PB-LIVE-001) |

**Device classes and their stand-ins.**

| Class | Stand-in in the lab | What the stand-in can and cannot say |
| --- | --- | --- |
| Desktop Chromium-class | Playwright Chromium (Linux in CI, macOS locally) | The engine's MSE and codec behaviour, real decode. Not a consumer browser product. |
| Desktop Firefox-class | Playwright Firefox (Linux in CI; Docker on a macOS host) | The engine's behaviour. Does not start on the macOS development host. |
| Desktop WebKit-class | Playwright WebKit (macOS only) | A WebKit build, not Safari: the same engine, not the same product or media stack. Its Linux build cannot play MSE content, so Linux WebKit is a documented gap (section 13). |
| Low-end television or set-top box | Chromium with `Emulation.setCPUThrottlingRate` at 4x | Main-thread slowness: page boot, parsing, our own per-frame work. Not hardware decoders, memory limits, the network stack of a device, or input latency. Firefox and WebKit have no equivalent. |

## 4. Risk ranking

We rank scenarios by risk and let the ranking decide what gates a merge. Risk is a judgment before there is data, so the rubric is written down and the judgments are explained; evidence revises them (below).

### 4.1 The rubric

**Likelihood (L)**: how likely is an ordinary change (a player configuration change, a library or browser upgrade, a change to the page) to break this behaviour?

| L | Level | Definition |
| --- | --- | --- |
| 1 | Remote | Built only on browser primitives: nothing we write or configure can change the outcome. |
| 2 | Unlikely | Our configuration touches it, but it is simple and deterministic, and a break would show up in many other tests too. |
| 3 | Possible | Our code, configuration or the player version takes part; deterministic on a clean network; a change to any of them can break it. |
| 4 | Likely | Timing-, network- or engine-dependent logic (buffering, adaptation, retries, seeking): a small change or an engine update can break it while the happy path still passes. |
| 5 | Frequent | Several of those at once (seek races, live-edge arithmetic across manifest updates) or known engine quirks: expect it to break whenever anything nearby changes. |

**Impact (I)**: what does a member live through when it breaks, and how many sessions are affected?

| I | Level | Definition |
| --- | --- | --- |
| 1 | Invisible | Nobody watching would notice: a metric or a log line is wrong. |
| 2 | Minor | Noticeable but harmless: a slightly longer wait or a brief dip in quality; the member carries on. |
| 3 | Degraded | Viewing continues but is visibly worse for some sessions: one extra stall, a seek that lands a few seconds off, quality stuck low for a while. |
| 4 | Broken or systemic | Playback stops, hangs or shows an error so that the member must retry or give up on the title; or every session is measurably worse (slower start, more stalls, lower quality). |
| 5 | Blocked | The member cannot start, or cannot keep watching a live event, and it is not one title: an engine, a device class, or everyone. |

A defect that makes the lab's own measurements or conditions wrong (the metrics hook, the fault engine, the live clock) is scored at its real cost: impact 4 when it can mislead one verdict, impact 5 when every baseline and verdict built on it is void. A gate that cannot fail is a silent hole.

### 4.2 Score and tiering rule

Score = likelihood x impact (1 to 25). Ties are ranked by impact: we would rather miss a frequent annoyance than an outage. The thresholds, and the rule for each lane (the `Runs in` column of the catalog), are rendered from [`src/shared/criteria.ts`](src/shared/criteria.ts):

<!-- BEGIN:RISK_TIERS -->
| Threshold | Score | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| Merge threshold | 15 | Risk score (likelihood x impact) from which a test in the `e2e` or `perf` lane gates a merge. | Assumption: 15 = 3 x 5: a possible (L3) blocker (I5) gates a merge, and so does a likely (L4) interruption (I4 gives 16). A possible interruption or a likely degradation (3 x 4 = 4 x 3 = 12) does not. Lowering it to 12 would double the merge tier and leave its job without headroom (ADR-020). |
| Release threshold | 8 | Risk score from which a test in the `e2e` or `perf` lane gates a release. Below it a scenario is exploratory: not automated. | Assumption: 8 = 2 x 4: an unlikely (L2) interruption (I4), or a possible (L3) minor degradation (I3 gives 9). Below it a failure is a nuisance a person finds by hand faster than a suite finds it. |

| Runs in | What runs there | Tier rule |
| --- | --- | --- |
| `e2e` | Playwright browser tests (`tests/e2e`) | score 15 or more: merge; 8 to 14: release; below 8: not an automated test |
| `perf` | The performance harness (`perf/`): repeated runs against baselines | score 15 or more: merge; 8 to 14: release; below 8: not an automated test |
| `unit` | Vitest, including the service tests that run real ffmpeg (`tests/unit`) | always merge: it costs milliseconds, so it gates every merge whatever its score |
| `live` | Readiness checks and the soak (`tests/live`) | always release: it needs minutes of wall-clock on a quiet machine, so it cannot gate a pull request |
| `ab` | The A/B runner (`ab/`) | always release: it needs minutes of wall-clock on a quiet machine, so it cannot gate a pull request |
<!-- END:RISK_TIERS -->

In words: a test whose score is at or above the merge threshold gates every pull request; between the two thresholds it gates a release; below the release threshold the scenario is not automated (it is exploratory). Cost then overrides in two places. A unit test costs milliseconds, so it gates every merge whatever its score. A readiness run or an experiment needs minutes of wall-clock and a quiet machine, so it can only gate a release, even when its score is high; the cheaper rows of the same risk gate the merge instead. `npm run docs:check` applies the rule to every catalog row (section 14), so a tier that disagrees with its score cannot be committed.

**Scores change with evidence.** A test that fails for a product reason (not a flake, not the environment) raises the likelihood of its area. An escape (a defect found at release or in production that a merge-tier test should have caught) raises it too, and moves a test up a tier. An area with no product failure in a long run of builds may lose a point of likelihood, never of impact. Every change is a pull request to this document, with the evidence.

### 4.3 The ranked scenario areas

Highest risk first. The line is drawn by the rule above: the areas whose gate says `merge` or `merge+release` are what gates a pull request; the others are found by the nightly and release runs. The `Catalog rows` column lists the tests that answer to each area with the risk the catalog gives them. `npm run docs:check` verifies this table against the catalog: the order, every arithmetic, every cited risk, every gate, and that every catalog row answers to exactly one area.

<!-- BEGIN:RISK_RANKING -->
| Rank | Scenario area | Top risk | Gate | Why it ranks here | Catalog rows |
| --- | --- | --- | --- | --- | --- |
| 1 | Live join and edge placement | 4x5=20 | merge+release | Kick-off is when the whole audience joins at once, a failed join cannot be retried later, and the edge arithmetic (service clock, availability, presentation delay) is easy to get wrong. | PB-LIVE-001 (4x5=20), PB-RDY-001 (4x5=20) |
| 2 | Live origin stall recovery | 4x5=20 | merge+release | Origins do stall; a player that does not come back leaves everyone on a frozen picture of an event that is still happening. | PB-REC-008 (4x5=20), PB-RDY-003 (4x5=20) |
| 3 | Live window and manifest refresh | 4x5=20 | merge+release | The playhead must stay inside a window that slides every segment; a refresh bug kills playback minutes in, not at join, so only a test that watches several refreshes can see it. | PB-LIVE-003 (4x5=20), PB-LIVE-004 (3x5=15), PB-RDY-004 (4x5=20) |
| 4 | Seeking under stress | 5x4=20 | merge | Seeking while requests are in flight is the most race-prone path in an MSE player (abort, re-buffer, append), and a hang there needs no network fault to appear. | PB-VOD-009 (5x4=20) |
| 5 | Seeking within and beyond the buffer | 4x4=16 | merge | Every scrub is a seek; the unbuffered case re-plans segment fetches and differs per engine. | PB-VOD-006 (4x4=16), PB-VOD-007 (4x4=16) |
| 6 | Segment errors mid-title | 4x4=16 | merge | A CDN hiccup is the commonest real-world fault; the member should see nothing or one stall, never an error screen. | PB-REC-001 (4x4=16), PB-REC-002 (4x4=16) |
| 7 | Adapting to falling bandwidth | 4x4=16 | merge | Staying on a rung the network cannot carry turns into stall after stall; the adaptation is timing-dependent and sensitive to configuration. | PB-ABR-002 (4x4=16) |
| 8 | Live latency | 4x4=16 | merge+release | Latency is the number a live-event owner is paged about; a player that slowly slips behind the edge shows spoilers on other screens. | PB-LIVE-002 (4x4=16), PB-RDY-002 (4x4=16) |
| 9 | Startup time | 4x4=16 | merge+release | Every session pays for startup; it moves with any change to buffering, manifest handling or the page, and only repeated runs can see a small shift. | PB-PERF-001 (4x4=16), PB-AB-002 (4x4=16) |
| 10 | Rebuffering | 4x4=16 | merge+release | Rebuffering is what members feel most, and a changing network is where configurations differ, so the same condition feeds the gate and the experiment. | PB-PERF-003 (4x4=16), PB-AB-003 (4x4=16) |
| 11 | Frame rate and dropped frames | 4x4=16 | merge | Dropped frames are the first thing to move when a change adds per-frame work to the page or selects a heavier rung. | PB-PERF-002 (4x4=16) |
| 12 | Starting a title | 3x5=15 | merge | If playback does not start nothing else matters; DASH and HLS are different parsers over the same media. | PB-VOD-001 (3x5=15), PB-VOD-002 (3x5=15) |
| 13 | Low-end devices | 3x5=15 | merge | Slow devices are where per-frame cost shows first; a 4x CPU throttle in Chromium is the only stand-in the lab has, and it magnifies any regression. | PB-PERF-004 (3x5=15) |
| 14 | Engine capability drift | 3x5=15 | merge | If an engine stops decoding a flavour, every playback result from that job is meaningless; the probe says so first. | PB-ENV-001 (3x5=15) |
| 15 | Trust in the player hook's numbers | 3x5=15 | merge | If `window.__qa` is wrong, every baseline, verdict and readiness number built on it is wrong in a way no other test would notice. | PB-VOD-012 (3x5=15) |
| 16 | Faithfulness of the lab's own conditions | 3x5=15 | merge | Faults, the live clock and the manifests: if the lab applies the wrong condition, the player gets blamed for the lab's bug. | PB-LAB-001 (3x5=15), PB-LAB-002 (3x5=15), PB-LAB-003 (3x5=15) |
| 17 | Long live sessions | 3x5=15 | release | Drift, leaks and rare stalls show up after minutes, and an event lasts hours. Above the line by score, but a soak costs minutes of wall-clock and cannot gate a pull request (section 13). | PB-RDY-005 (3x5=15) |
| 18 | The rest of the VOD lifecycle | 3x4=12 | release | Finishing a title, resuming, rewinding far, replaying: member-visible and engine-sensitive, but each fails alone and a nightly run finds it within a day. | PB-VOD-003 (3x4=12), PB-VOD-005 (3x4=12), PB-VOD-008 (3x4=12), PB-VOD-011 (3x4=12) |
| 19 | Hard recovery paths | 3x4=12 | release | Persistent and partial failures: a dead rung, a truncated body, a dead manifest or origin, a stale manifest. Rare, but the failure mode is a hang. | PB-REC-003 (3x4=12), PB-REC-005 (3x4=12), PB-REC-006 (3x4=12), PB-REC-007 (3x4=12), PB-REC-009 (3x4=12) |
| 20 | Quality recovery and slow starts | 4x3=12 | release | Climbing back up, slow starts on a weak link, a late segment, rewinding live: viewing gets worse, it does not break. | PB-ABR-001 (3x4=12), PB-ABR-003 (4x3=12), PB-ABR-006 (4x3=12), PB-REC-004 (4x3=12), PB-LIVE-005 (4x3=12) |
| 21 | Trust in observation and statistics | 3x4=12 | merge+release | Two observation channels that disagree, an experiment harness that finds differences between identical configurations, or a wrong p-value each silently ship or block the wrong thing. | PB-ABR-007 (3x4=12), PB-AB-001 (3x4=12), PB-LAB-004 (3x4=12) |
| 22 | Stream determinism | 2x5=10 | merge | If the same spec yields different streams, timing assumptions and baselines are void: unlikely, but total. | PB-ENV-002 (2x5=10) |
| 23 | Encrypted media (ClearKey, stretch) | 2x5=10 | release | Protected playback is blocked if it breaks, but the lab only covers ClearKey, a smoke test of the key exchange and not a commercial DRM. | PB-EME-001 (2x5=10) |
| 24 | Secondary paths | 3x3=9 | merge+release | The open-codec path, a manual quality choice, pausing live, skipping into the last seconds, triage clustering: real but narrow, or with a fallback. | PB-VOD-010 (3x3=9), PB-VOD-013 (3x3=9), PB-ABR-004 (3x3=9), PB-LIVE-006 (3x3=9), PB-LAB-005 (3x3=9) |
| 25 | Pause, pinned playback and lab hygiene | 2x4=8 | merge+release | A browser primitive, the pin control the performance runs depend on, and the checks of the documents and the profiles: unlikely to break and cheap to check. | PB-VOD-004 (2x4=8), PB-ABR-005 (2x4=8), PB-LAB-006 (2x4=8), PB-LAB-007 (2x4=8) |
| 26 | Page visibility: a hidden tab | 3x2=6 | exploratory | Real browsers throttle hidden tabs and headless Playwright pages are not throttled the same way, so a test would not measure the real thing. Checked by hand in a headed browser when timers or visibility handling change. | - |
| 27 | Playback rate, volume, fullscreen and resize | 2x2=4 | exploratory | Browser primitives with a trivial surface in a minimal page: a person finds a break in seconds. Checked by hand before a release when the page changes. | - |
<!-- END:RISK_RANKING -->

**Reading the list.** Every area above the line has a merge-gate row except one: long live sessions (area 17). Its risk needs a soak, which costs minutes, so the compensating control is the nightly CI soak, and the price is a window of up to a day in which a leak or drift regression can sit on `main` (section 13). Areas 26 and 27 are below the line on purpose: they are not in the catalog, so nothing pretends to test them; they are charter-based manual sessions before a release, when the page changes.

## 5. Test levels and environments

### 5.1 Levels

| Level | Tool | What it covers | Where it runs | Gate |
| --- | --- | --- | --- | --- |
| Static | `tsc`, ESLint, Prettier, `docs:check`, `codec-matrix --check` | Types, lint (including no fixed sleeps in specs), formatting, and the integrity of the documents, including the generated codec matrix. | Every pull request | Merge (`gate:static`) |
| Unit and service integration | Vitest (`tests/unit`) | The lab itself: the media pipeline against real ffmpeg output, the fault engine over a real socket, the live clock and `tfdt` rewriting, manifests, statistics, flake math, triage signatures, the docs tooling. | Every pull request | Merge (`gate:unit`) |
| Browser end-to-end | Playwright test runner | The player in each engine: areas VOD, ABR, LIVE, REC, ENV and EME. | `@merge` on every pull request; `@release` nightly and before a release | Merge and release |
| Performance | The harness (`perf/`) on the Playwright library API | Startup, frame rate, rebuffering and the low-end profile: repeated runs, median and p90, against committed baselines. | Own job, serial, one browser at a time | Merge (`gate:perf`) |
| A/B experiments | The A/B runner (`ab/`) | Two player configurations on startup and rebuffering under identical conditions. | On demand, before a configuration ships | Release |
| Readiness and soak | `tests/live` | The live-event criteria (section 8). | CI soak nightly; release soak before a release | Release |

**Oracles: how a test knows.** There are three, and no fourth. Player events and state (`qa.waitFor`, `qa.metrics()`): what the player says it did. The request log: what the server saw (which segment after a seek, which rung after a throttle, how often a failed request was retried), independent of the player. Metrics against baselines, for performance: never against an absolute number, because absolute numbers depend on the machine. We never compare pixels: "frames were decoded and presented" is checked, "the picture looks right" is not (section 1). Where two oracles can disagree, a test checks that they do not (PB-ABR-007).

### 5.2 Environments

The matrix below is the design; the CI jobs arrive in Phase 4. Chromium and Firefox run on Linux, WebKit runs on macOS. Linux WebKit's MSE playback is broken in Playwright's build (`MediaError 4: Failed to push buffer`, intermittently, while `isTypeSupported` answers `true` for everything): see section 2 of [docs/CONTRACTS.md](docs/CONTRACTS.md) and ADR-001.

| Environment | Chromium | Firefox | WebKit | `chromium-cpu4x` | Used for |
| --- | --- | --- | --- | --- | --- |
| GitHub Actions, Linux | yes | yes | no (documented gap) | yes | The merge gate for three of the four projects, the performance gate, nightly and release jobs. |
| GitHub Actions, macOS | not needed | no | yes | no | The WebKit merge job, WebKit performance and release jobs. |
| Jenkins, Linux agent (run locally with docker-compose) | yes | yes | experimental (Linux WebKit; the macOS job has no local equivalent) | yes | The same `gate:*` stages as GitHub Actions: parity of the pipeline, not extra coverage ([jenkins/README.md](jenkins/README.md)). |
| Development host, macOS (arm64) | yes | no (does not launch: "Could not find profile folder") | yes | yes | The inner loop. |
| Docker, Linux (the Playwright image, arm64 here) | yes | yes | no | yes | Firefox from a macOS host, and reproducing CI locally (`npm run docker:pw`). |

Performance baselines are keyed by environment and profile (`perf/baselines/<env>/<profile>.json`, ADR-004) and never compared across environments.

**Which stream an engine plays comes from a real-decode capability probe, never from `MediaSource.isTypeSupported` alone.** The probe decodes a real clip through MSE in each engine (ADR-001); the generated matrix of what played where is `docs/CODEC_MATRIX.md` (produced by the codec probe of Phase 1). A spec that cannot run because of a documented gap is skipped by the shared fixture with the reason from that matrix; a silent skip is a bug. PB-ENV-001 runs the probe in every job, so a changed engine or runner image is reported as an environment failure and not as a pile of playback failures.

## 6. What gates a merge and what gates a release

### 6.1 The merge gate

A pull request merges when every stage below is green. The stage names are the `npm run gate:*` scripts that GitHub Actions and the Jenkinsfile both call.

| Stage | What runs | It passes when | Budget |
| --- | --- | --- | --- |
| `gate:static` | Typecheck, lint, format check, docs check, and the freshness of the generated codec matrix (`codec-matrix --check`: `docs/CODEC_MATRIX.md` is what the committed probe results render to). | All clean. | Static plus unit together (below). |
| `gate:unit` | Vitest. | Every test passes, and there are tests. | |
| `gate:merge` | The `@merge` Playwright tests, one job per engine (chromium, firefox, webkit) and one for the throttled Chromium project (`@cpu`). | Every test passes after at most one retry. A pass on retry is not a pass: it is recorded as a flake (section 7). | Per engine job, below. |
| `gate:perf` | The performance scenarios of the catalog against the baselines of this environment. | No gated metric regresses, or a regression does not reproduce on the automatic re-measure (ADR-004). | Per performance job, below. |
| `gate:flake` | The flake history of the merge-tier tests. | The suite flake rate is within the budget, no test is above the quarantine trigger without being quarantined, and no quarantine has expired. | Seconds. |
| `gate:triage` | Clusters the failures of a red build by root cause. | It is not a gate: it never decides a verdict and never turns a red build green. | |

**Entry:** a pull request opened or updated against `main`; CI starts from a clean checkout of the merge commit, restores or generates the streams, and waits for the service's `/health`. **Exit:** every stage above green, which branch protection is set up to require once the CI exists (Phase 4): static, unit, one merge job per engine, the throttled project, performance, flake.

### 6.2 The release gate

A release candidate is a commit on `main` whose merge gate is green. It is released when all of the following hold, or each exception is written down with an owner:

- Every `@merge` and `@release` browser test passes in every engine, and the `@cpu` subset in the throttled project.
- The performance gate passes on the release environment (with a baseline refresh first if the machine class changed).
- The nightly CI soak has been green since the last release, and the release soak passes in every engine (section 8).
- The live readiness checks pass in every engine, and for a live event the go/no-go checklist of section 8 is signed.
- Every configuration change in the release has an A/B decision on record (section 12).
- The quarantine list has no merge-tier entry, and every other entry has an owner, a reason and a date that has not passed; the known-gaps list (section 13) was read.

### 6.3 Time budgets

The design target is the smallest common CI runner: two cores and two Playwright workers, with warm caches. The budgets and the estimates behind them are rendered from [`src/shared/criteria.ts`](src/shared/criteria.ts):

<!-- BEGIN:GATE_BUDGETS -->
| Budget or parameter | Value | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| CI runner cores (design target) | 2 | The runner class the budgets are sized for. | Assumption: The smallest common CI runner class. A larger runner only adds headroom. |
| Playwright workers in CI | 2 | Parallel browser tests in one job. | Fact: playwright.config.ts: `workers` is 2 when `CI` is set (override with `PB_WORKERS`). |
| Timeout of one browser test | 45 s | Playwright `timeout`: a test that has not finished by then fails. | Fact: playwright.config.ts: `timeout: 45_000`. |
| Retries in CI | 1 | A failed test is re-run this many times; a pass on retry is recorded as a flake. | Fact: playwright.config.ts: `retries` is 1 when `CI` is set. |
| Static checks plus unit tests | 240 s | Wall-clock of `gate:static` and `gate:unit` together. | Assumption: Four minutes. Typecheck, lint, format and the docs check take tens of seconds each; Vitest includes the tests that run real ffmpeg. Measured in Phase 4 once the job exists. |
| Merge job, one engine | 480 s | Wall-clock of the `@merge` browser job of one engine on the design-target runner (2 cores, 2 workers). | Assumption: Eight minutes: about where a pull request author stops waiting and starts something else. The jobs of the engines run in parallel, so the pull request waits for the slowest. |
| Performance gate job | 720 s | Wall-clock of one performance job (one environment, its profiles) when no metric fails. | Assumption: Twelve minutes. Performance runs are serial (one browser at a time) and must not share the machine; the table in section 6 adds up the scenarios. Measured locally (the workstation of the baselines, not a CI runner): the runs of the job "chromium and chromium-cpu4x" add up to 365 s with their warm-ups (282 s for the three scenarios of Chromium, 83 s for the throttled profile), about 6 to 7 minutes with the starts of the service and of four browsers; to be re-measured in CI. |
| Performance re-measure | 360 s | Extra time allowed when a metric fails and the gate re-measures it with fresh runs. | Assumption: One scenario of N runs at the slowest per-run estimate (10 x 23 s = 230 s) plus margin. Only a failing build pays it. Measured locally: the slowest scenario, PB-PERF-003, takes 200 s for its warm-up and ten runs; to be re-measured in CI. |
| Release job, browser tests, one engine | 900 s | Wall-clock of the `@merge` plus `@release` browser tests of one engine (the soak and the readiness checks run in their own jobs). | Assumption: Fifteen minutes: the release gate runs nightly and before a release, so it can afford about twice the merge budget. |
| Job setup | 90 s | Checkout, `npm ci` from the cache, browser from the cache or image, stream cache restore, service start. | Assumption: Warm caches. Cold caches cost more and are a CI-infrastructure problem, not a test-count problem. |
| Failure allowance | 90 s | Time added to a browser job for one failing test. | Arithmetic: One test that runs into its timeout (45 s) and again on its retry: timeout x (1 + retries). |
| Average browser test (for the ceiling) | 20 s | Average wall-clock of one browser test, used only to turn the merge budget into a ceiling. | Assumption: Conservative: the per-area estimates run from 8 s to 28 s. The catalog is checked against those estimates, not against this average. |
| Ceiling: merge-tier browser tests per engine | 30 | Most `@merge` browser tests one engine may carry. | Arithmetic: (merge job - setup - failure allowance) x workers / average test = (480 - 90 - 90) x 2 / 20. |
| Browser test under the 4x CPU throttle | 1.5x | How much longer a browser test takes in the `chromium-cpu4x` project. | Assumption: The throttle slows main-thread work fourfold (page boot, manifest parsing, our instrumentation) but not the media clock or the network, so a whole test is slower by less than 4x. Measured in Phase 3. |
| Runs per performance scenario | 10 | Fresh-context runs behind every median and p90. | Fact: ADR-004 in docs/DESIGN_DECISIONS.md: every scenario runs N times, default 10. |

**Expected wall-clock of one browser test, by area** (design estimates, replaced by measured durations in Phase 3)

| Area | Estimate | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| VOD | 12 s | One VOD browser test. | Assumption: 3 s page and player boot + 1.5 s startup + about 6 s of real-time media waits (a 3 s play window, a seek, a second window) + 1.5 s teardown and slack. |
| ABR | 28 s | One ABR browser test. | Assumption: 3 s boot + 1.5 s startup + 8 s until the throttle starts + 12 s for the adaptation to react (the Shaka 5.3.3 default minimum switch interval is 8 s) + 3.5 s slack. |
| LIVE | 20 s | One live browser test. | Assumption: 3 s boot + 2 s join + 12 s of observation (six manifest refreshes at the 2 s update period) + 3 s slack. |
| REC | 20 s | One recovery browser test. | Assumption: 3 s boot + 1.5 s startup + the fault itself (a retry back-off of 1 to 3 s; for the live case a 10 s origin stall) + 4 s recovery + slack. |
| ENV | 8 s | One environment browser test. | Assumption: 3 s boot + about 3 s for the in-page decode probe + slack. |
| EME | 12 s | One ClearKey browser test. | Assumption: Like VOD, plus the license round trip (a local key, no network). |

**Expected wall-clock of one run of a performance scenario** (design estimates for the CI runner; each basis also gives the duration measured on the development workstation, to be re-measured in CI)

| Scenario | Estimate | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| PB-PERF-001 startup | 5 s | One run. | Assumption: 3 s boot + 1.5 s startup + 0.5 s teardown. Measured locally (the workstation of the baselines, not a CI runner): 0.15 s per run on Chromium, 0.25 to 0.40 s on Firefox and WebKit, the first run of a batch (the warm-up) twice that; to be re-measured in CI, where the page boot is the unknown. |
| PB-PERF-002 frame rate | 12 s | One run. | Assumption: 3 s boot + 1.5 s startup + 2 s warm-up + a 5 s measured media window + 0.5 s teardown. Measured locally: 7.3 s per run on Chromium and in the container, 7.4 to 7.6 s on Firefox and WebKit (the 7 s of media plus the boot); to be re-measured in CI. |
| PB-PERF-003 rebuffering | 23 s | One run. | Assumption: 3 s boot + 1.5 s startup + 8 s until the throttle + about 10 s to observe the adaptation + 0.5 s teardown. Measured locally: 18.2 s per run on Chromium, 18.3 to 18.6 s on the other engines (the scenario plays 18 s of media); to be re-measured in CI. |
| PB-PERF-004 low-end profile | 15 s | One run under the 4x CPU throttle. | Assumption: 6 s boot and startup (the throttle slows both) + 2 s warm-up + a 5 s measured window + 2 s teardown. Measured locally: 7.5 s per run under the throttle; to be re-measured in CI. |
<!-- END:GATE_BUDGETS -->

The arithmetic for the catalog below: a browser job takes (the sum of its tests' expected seconds / workers) + setup + a failure allowance, and a performance job is serial. This table is computed from the catalog on every docs check, and the check fails when a job is over its budget or an engine is over the ceiling, so the merge tier cannot grow past its budget unnoticed:

<!-- BEGIN:MERGE_BUDGET -->
| Job | Tests | Test-seconds | Estimated wall-clock | Budget | Headroom |
| --- | --- | --- | --- | --- | --- |
| merge chromium | 15 | 248 s | 304 s (5.1 min) | 480 s (8.0 min) | 176 s (37 %) |
| release chromium | 37 | 672 s | 516 s (8.6 min) | 900 s (15.0 min) | 384 s (43 %) |
| merge firefox | 15 | 248 s | 304 s (5.1 min) | 480 s (8.0 min) | 176 s (37 %) |
| release firefox | 37 | 672 s | 516 s (8.6 min) | 900 s (15.0 min) | 384 s (43 %) |
| merge webkit | 15 | 248 s | 304 s (5.1 min) | 480 s (8.0 min) | 176 s (37 %) |
| release webkit | 36 | 660 s | 510 s (8.5 min) | 900 s (15.0 min) | 390 s (43 %) |
| merge chromium-cpu4x | 3 | 66 s | 213 s (3.5 min) | 480 s (8.0 min) | 267 s (56 %) |
| release chromium-cpu4x | 3 | 66 s | 213 s (3.5 min) | 900 s (15.0 min) | 687 s (76 %) |
| perf chromium + chromium-cpu4x | 4 | 550 s | 640 s (10.7 min) | 720 s (12.0 min) | 80 s (11 %) |
| perf firefox | 3 | 400 s | 490 s (8.2 min) | 720 s (12.0 min) | 230 s (32 %) |
| perf webkit | 3 | 400 s | 490 s (8.2 min) | 720 s (12.0 min) | 230 s (32 %) |

Browser jobs: wall-clock = test-seconds / 2 workers + 90 s setup + 90 s failure allowance. Performance jobs: serial, runs x seconds per run + 90 s setup. Ceiling: 30 merge-tier browser tests per engine; the most loaded engine carries 15.
<!-- END:MERGE_BUDGET -->

Expected seconds per test are design estimates and Phase 3 replaces them with measured durations. The performance rows are design estimates for the 2-CPU CI runner too: the durations measured on the development workstation (Phase 5: 0.15 s, 7.3 s, 18.2 s and 7.5 s per run for PB-PERF-001 to PB-PERF-004, so about 365 s of runs for the job "chromium + chromium-cpu4x" against the 640 s estimated above) are in the basis of each row, and are to be re-measured in CI before the estimates are lowered. If a test does not fit, the options are, in this order: make it cheaper (assert on the request log instead of waiting for media time; shorten the window); move it to the release tier by lowering its score with an argument; split the job; and only then change the budget, with an ADR. The ceiling and the thresholds were chosen together (ADR-020, ADR-021).

### 6.4 What is deliberately kept out of the merge gate

| Kept out | Why not on every pull request | Where it runs instead |
| --- | --- | --- |
| Release-tier browser tests (below the merge threshold) | Lower risk, and several are slow (replay, long rewinds, recovery paths that wait for retries). A failure is as actionable a day later, and the budget has no room for them. | Nightly and before a release. |
| The soak and the readiness checks | Minutes of wall-clock each. A drift or a leak is a property of the build, not of the diff, so a per-pull-request failure could not be attributed to it. | CI soak nightly, release soak before a release. |
| A/B experiments | They need dozens of sessions per arm on a quiet machine, and the verdict is statistical (ship, keep, inconclusive), not pass or fail. | On demand, before a configuration ships. |
| The full codec matrix | A fresh browser process per case and repeated attempts: minutes, and it changes only when a browser or a runner image changes. | Weekly, and on every Playwright upgrade. PB-ENV-001 is the cheap proxy that stays in the merge gate. |
| Language-model triage summaries | They never decide a verdict and need a key. | Red builds only, optional. |
| Performance comparison across environments | Meaningless (ADR-004). | Never. |
| WebKit playback on Linux | A documented gap: its MSE playback is broken in Playwright's build. | Skipped with the reason; the probe keeps reporting it. |

## 7. Performance and flake policy

The mechanisms are built in Phase 5 (how they work and how to use them: [docs/FLAKE.md](docs/FLAKE.md)); this is the policy they implement.

### 7.1 Performance

- **Baselines** are committed per environment, profile (`chromium`, `chromium-cpu4x`, `firefox`, `webkit`) and scenario, with the coefficient of variation of the baseline runs. They are never compared across environments (ADR-004).
- **Each scenario runs N times** in fresh browser contexts (N is in the budget table), alone on the machine. The summary is the **median and the p90**: the mean hides the tail, and a title that sometimes takes four times as long is what members complain about.
- **A metric regresses** when its median is worse than the baseline by more than a relative threshold **and** an absolute floor (so five milliseconds on a forty-millisecond metric cannot fail a build), or its p90 is worse by more than the p90 threshold (a share of the baseline p90, which is the larger value). Rebuffer count and dropped-frame ratio use absolute budgets, since their baseline is usually zero.
- **A regression must reproduce.** On a first failure the gate re-measures with fresh runs and fails the build only if the regression reproduces. The thresholds that depend on variation come from the measured run-to-run variation of the baselines, not from guesses (the ones that cannot, because nothing varied, say so below).
- **What gates.** PB-PERF-001 to PB-PERF-004 state the intent for every engine. An engine and metric pair gates only once its baseline is stable enough to tell a regression from noise (a baseline CV of at most 15 %); until then it is tracked and reported on every build but does not block. That is a result of the baselines, not something this document can promise: on the six recorded profiles ([docs/PERF.md](docs/PERF.md)) startup gates on Chromium, WebKit and the throttled profile on the workstation and on Chromium in the container, and is **tracked** on Firefox and WebKit in the container (CV 15.3 % and 56.7 %); frame rate, dropped frames and rebuffering gate wherever they run. A CI runner has its own baseline, and the same rule decides what gates there.

The thresholds are policy numbers like the others, rendered from the same file. **The ones that depend on run-to-run variation (the startup shares and floors, the stability limit, the warm-up count) are derived from the variation measured in the committed baselines** (their basis says `measured` and names the artifact, [docs/results/perf/threshold-derivation.md](docs/results/perf/threshold-derivation.md)). **The others are still assumptions**: the frame rate, the dropped-frame ratio and the rebuffering metrics were exactly the same in every baseline run, so there was no variation to derive a number from; their basis says so and what the A/A and sensitivity checks found ([docs/results/perf](docs/results/perf)). A relative rule judges the median and the worse tail (p90, or p10 for the frame rate) with a share each, and both must also clear one absolute floor; a budget is an absolute increase over the baseline. A metric whose baseline is noisier than the stability limit does not gate: on the recorded baselines those are Firefox and WebKit startup in the Playwright container.

<!-- BEGIN:PERF_POLICY -->
| Threshold or parameter | Value | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| Runs per performance scenario | 10 | Fresh-context runs behind every median and p90. | Fact: ADR-004 in docs/DESIGN_DECISIONS.md: every scenario runs N times, default 10. |
| Warm-up runs per batch | 1 | The first run of every batch (one scenario, one browser process) is executed like the others, recorded in the baseline and the report, and excluded from the median and p90. | Measured: The first run in a fresh browser process pays for things the later ones do not (cold code and file caches, the first decode, the first connection). Measured in docs/results/perf/threshold-derivation.md: the discarded warm-up startup was 4.6x the median of the ten measured runs on local Chromium, 3.2x on local WebKit, 2.3x under the 4x throttle, 2.0x on Chromium and on WebKit in the container and 1.3x on Firefox in the container. Limit of the claim: in the container WebKit's first two measured runs were still slow (516 and 258 ms against 146 to 183 ms for the rest), which is why its startup is tracked and not gated. |
| Stability limit: baseline CV | 15 % | A metric judged by a relative rule gates only while the coefficient of variation of its baseline runs is at or below this; above it the metric is tracked and reported, not gated. | Measured: TEST_STRATEGY.md section 7.1: a metric gates only once its baseline is stable enough to tell a regression from noise. Startup CV of the recorded baselines (docs/results/perf/threshold-derivation.md): 4.0 % local Chromium, 6.8 % local WebKit, 6.4 % under the 4x throttle, 13.3 % Chromium in the container, 15.3 % Firefox in the container, 56.7 % WebKit in the container. The thresholds below cover the pairs up to 13.3 %; the limit is that CV rounded up to the next 5 %, so Firefox and WebKit startup in the container are tracked, not gated. |
| Startup (PB-PERF-001): median, share | 30 % | `startupMs`: the median of the batch may be worse than the baseline median by at most this share of it (and the floor). | Measured: Derived in docs/results/perf/threshold-derivation.md: noise = 3 x sqrt(2) x the standard error of the median of ten runs, i.e. how far two batches of the same code may be apart; 6.4 % of the baseline median on local Chromium, 14.2 % on local WebKit, 23.2 % on Chromium in the Playwright container (the noisiest profile that gates). 1.25 x 23.2 % = 29 %, rounded up to 30 %: the extra quarter is the uncertainty of a spread estimated from ten runs. |
| Startup (PB-PERF-001): p90, share | 30 % | `startupMs`: the p90 of the batch may be worse than the baseline p90 by at most this share of it (and the floor). | Measured: Same derivation for the p90 of ten runs (essentially the second slowest run; the simulated standard error of ten normal runs is 0.46 sigma against 0.37 sigma for the median): noise 9.3 % of the baseline p90 on local Chromium, 12.3 % on local WebKit, 22.6 % in the container; 1.25 x 22.6 % = 28 %, rounded up to 30 % (docs/results/perf/threshold-derivation.md). The tail share is not wider than the median share because the p90 of the noisiest profile is itself larger than its median. |
| Startup (PB-PERF-001): floor | 5 ms | `startupMs`: a median or p90 that is worse by this much or less never fails, whatever the share. | Measured: The noise of the quietest gated pair (local Chromium, 3.6 ms for the p90, docs/results/perf/threshold-derivation.md) times 1.25, rounded up: a change that small is within what the quietest profile does by itself. The share covers every measured pair, so the floor binds only on a baseline smaller than 17 ms, which none of the six profiles has. |
| Low-end startup (PB-PERF-004): median, share | 30 % | `startupMs` under the 4x CPU throttle: the median share, as for PB-PERF-001. | Assumption: The same share as PB-PERF-001, on purpose: one stability limit (15 %) governs every rule, so a throttled baseline at the limit needs this share, and the baselines of the CI runners (gha-linux-x64, gha-macos-arm64) are expected to be noisier than this workstation: a metric whose own baseline is too noisy is tracked there by the same rule, so noise is handled per environment and not by a rule of its own for each profile. The one throttled baseline measured here (local Chromium, CV 6.4 %) needs only 10.2 % (x 1.25 = 15 %, docs/results/perf/threshold-derivation.md), so a tighter low-end gate (15 %) was possible on this workstation and was not taken, for the sake of one policy; on this profile the margin is 2.9 times (ADR-124). |
| Low-end startup (PB-PERF-004): p90, share | 30 % | `startupMs` under the 4x CPU throttle: the p90 share, as for PB-PERF-001. | Assumption: As for the median: the measured need of the throttled p90 is 11.7 % (x 1.25 = 15 %), the policy uses the startup share (one policy, one limit: ADR-124). |
| Low-end startup (PB-PERF-004): floor | 20 ms | `startupMs` under the 4x CPU throttle: the floor, as for PB-PERF-001. | Measured: The noise of the throttled baseline (13.4 ms for the p90, docs/results/perf/threshold-derivation.md) times 1.25, rounded up. The throttled median is 111.5 ms, so the share (33 ms) is the larger of the two. |
| Frame rate (PB-PERF-002): median, share | 5 % | `fps` (frames presented per media second): the median may be below the baseline median by at most this share of it (and the floor). Lower is worse; a higher rate never fails. | Assumption: The content is 30 fps and a healthy run reads about 30 (docs/METRICS.md), so a spread of a few percent is already a visible drop: 5 % is 1.5 fps. Not derived from variation, because there was none: the rate was 30.0 fps in all 50 baseline runs of the five profiles that run PB-PERF-002 and in the 10 of the throttled profile (docs/results/perf/threshold-derivation.md), and it did not move in any completed A/A pass (docs/results/perf). The gate has not been seen to fire: no regression that could be injected moved the frame rate (an 8x CPU throttle left it at 30 fps, docs/results/perf/sensitivity/summary.md). |
| Frame rate (PB-PERF-002): p10, share | 10 % | `fps`: the p10 (the worse tail, since lower is worse) may be below the baseline p10 by at most this share of it (and the floor). | Assumption: Twice the median share: with ten runs the p10 is essentially the second worst run, a coarser statistic than the median. Unlike the startup tail this could not be checked against variation, because there was none: the p10 was 30 fps in every baseline run (docs/results/perf/threshold-derivation.md). |
| Frame rate (PB-PERF-002): floor | 1 fps | `fps`: a median or p10 that is lower by this much or less never fails. | Assumption: One frame per second of 30 (3 %): over the five-second window (150 frames) that is five frames, far more than the one or two by which where the window starts and ends can change the count (the decoded count was 150 in every baseline run but one of 149 and four of 151, docs/results/perf/threshold-derivation.md). Set by the resolution of the measurement, not by noise: no baseline run varied. |
| Dropped frames (PB-PERF-002): median, budget | 1 % | `droppedRatio` (dropped / decoded over the measured window): the median may be above the baseline median by at most this much, in absolute ratio. | Assumption: One percent: the lab policy for a dropped-frame ratio over a whole soak (LIVE_READINESS.maxDroppedFrameRatio), applied here to the increase over the baseline of a five-second window (1.5 frames of the 150). The baseline was zero: no dropped frame in any of the 60 baseline runs (50 at 720p on five profiles, 10 under the throttle, docs/results/perf/threshold-derivation.md), so there is no variation to derive a budget from, and no completed A/A pass had one. The budget has not been seen to fire: an 8x CPU throttle dropped no frame at 720p either (docs/results/perf/sensitivity/summary.md). |
| Dropped frames (PB-PERF-002): p90, budget | 3 % | `droppedRatio`: the p90 may be above the baseline p90 by at most this much. | Assumption: Three times the median budget (4.5 frames of 150): the p90 of ten runs is essentially the second worst run, so one unlucky run moves it. The baseline p90 was zero on every profile. |
| Low-end dropped frames (PB-PERF-004): median, budget | 2 % | `droppedRatio` under the 4x CPU throttle: the median budget, as for PB-PERF-002. | Assumption: Twice the unthrottled budget: the throttle exists to magnify per-frame cost, so the same regression shows as more dropped frames and the same noise as more too. The throttled baseline (10 runs) had no dropped frame, and a throttle of 8x, twice the profile's own, still dropped none (docs/results/perf/sensitivity/summary.md): the budget has not been seen to fire. |
| Low-end dropped frames (PB-PERF-004): p90, budget | 5 % | `droppedRatio` under the 4x CPU throttle: the p90 budget. | Assumption: The tail of the throttled profile: wider than its median budget, for the reason given for PB-PERF-002. The throttled baseline p90 was zero. |
| Rebuffering (PB-PERF-003): count, median budget | 0 | `rebufferCount` under `bandwidth-drop`: the median may be above the baseline median by at most this many rebuffers. | Assumption: Zero: the median count may not rise. With ten runs that means at least half of them now rebuffer more than the typical baseline run, a shift of the whole distribution and not one slow run (the median ignores one run). A batch that got there by chance is absorbed by the re-measure. The baseline was zero: no rebuffer in any of the 50 baseline runs of the five profiles that run PB-PERF-003 (docs/results/perf/threshold-derivation.md), so there is no variation to derive from; no pass of the A/A check on local Chromium (5 passes, 55 runs) moved it, and holding one video segment back for 8 s gave a median of 3 rebuffers and failed this rule in both batches (docs/results/perf/sensitivity/summary.md). |
| Rebuffering (PB-PERF-003): count, p90 budget | 1 | `rebufferCount`: the p90 may be above the baseline p90 by at most this many rebuffers. | Assumption: One extra rebuffer in the tail of the batch: the tail of ten integer counts moves by a whole rebuffer when one slow run happens, which is noise at this size. The p90 was 4 in the late-segment sensitivity run. |
| Rebuffering (PB-PERF-003): duration, median budget | 250 ms | `rebufferMs` (total stalled time): the median may be above the baseline median by at most this long. | Assumption: A quarter of a second, an eighth of a 2 s segment: small enough to catch one more short stall, large enough to sit above timer granularity. The baseline was 0 ms in every run; the late-segment run stalled for a median of 7,990 ms, about 32 times the budget. |
| Rebuffering (PB-PERF-003): duration, p90 budget | 1,000 ms (1 s) | `rebufferMs`: the p90 may be above the baseline p90 by at most this long. | Assumption: One second: half a segment of 2 s, and four times the median budget for the wider spread of a tail. The p90 was 11,180 ms in the late-segment run. |
| Rebuffering (PB-PERF-003): ratio, median budget | 1 % | `rebufferRatio` (stalled time over stalled plus playing time since the first frame): the median may be above the baseline median by at most this much. | Assumption: One percent: about a fifth of a second over the 18 s of media the scenario plays, consistent with the duration budget. The baseline was 0 in every run; the late-segment run had a median of 0.306. |
| Rebuffering (PB-PERF-003): ratio, p90 budget | 5 % | `rebufferRatio`: the p90 may be above the baseline p90 by at most this much. | Assumption: Five percent: about one second over the 18 s of media the scenario plays, consistent with the duration budget of the tail. The p90 was 0.381 in the late-segment run. |
<!-- END:PERF_POLICY -->

### 7.2 Flake

A flaky test is the most expensive kind: it costs the time of a failing test and teaches the team to ignore red. The policy numbers are rendered from the same file as the others, with the binomial arithmetic behind them:

<!-- BEGIN:FLAKE_POLICY -->
| Policy number | Value | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| Window | 30 | The last N executions of a test (for its own rate) and the last N builds (for the suite rate). | Assumption: Large enough that bad luck rarely condemns a healthy test: a test that flakes 1% of the time shows two flaky outcomes in 30 runs only 3.6% of the time. Small enough that a fixed test leaves the window within weeks. |
| Minimum runs before a test is judged | 20 | A test with fewer executions in the window has no verdict (it is reported as "not enough data"). | Assumption: Below 20 runs one flaky outcome is already 5% or more: too little evidence for a blocking decision. |
| Quarantine trigger, per test | 5 % | Flake rate (METRICS.md: passed only after a retry / executions) of one test over the window; above it the test must be fixed or quarantined, and the flake gate fails until one of the two happens. | Assumption: Above 5% means two flaky outcomes in a 30-run window (2/30 = 6.7%; one is 3.3%). A test that flakes 5% of the time is caught in 45% of windows, one at 10% in 82%, one at 20% in 99%: the worst offenders go first and the healthy ones are left alone. |
| Flake budget of the gate, per engine job | 2 % | Retried-then-passed executions / all executions of the merge-tier browser tests of one engine over the window; above it the flake gate fails. | Assumption: The goal is well under 1% (at 1% per test a merge job of about 15 tests needs a retry in 14% of builds, at 2% in 26%). 2% is the red line: it still tolerates one moderately flaky test, and it fails when flakiness spreads across tests, which points at the environment rather than at one test. |
| Quarantine, maximum age | 14 days | Days from the quarantine date to its expiry, for a release-tier test. | Assumption: Two weeks: long enough to reproduce and fix a timing problem in a media test, short enough that a quarantined test cannot be forgotten. |
| Quarantine, maximum age, merge-tier test | 7 days | Days from the quarantine date to its expiry, for a merge-tier test; it must be fixed or replaced by then. | Assumption: A quarantined merge-tier test leaves a hole in the gate over a high-risk scenario (score 15 or more), so the hole is kept short. |
<!-- END:FLAKE_POLICY -->

1. **Retries are recorded, never hidden.** CI retries a failed test once. A reporter records every attempt. A test that failed and then passed is a flake: **a retried pass is not a pass.** Flake rate per test = passed-after-retry / executions (METRICS.md).
2. **Judgment.** A test is judged once it has the minimum number of executions in the window. Above the trigger rate it must be fixed or quarantined, and the flake gate stays red until one of the two has happened. The suite as a whole has a budget: above it the gate fails, even if no single test crosses the trigger, because flakiness that is spread across tests points at the environment.
3. **Quarantine** is an entry in a committed list with the test id, an **owner**, a **reason** (with the evidence that the failure is non-deterministic: the same commit failed and passed), the date it started and an **expiry date** within the maximum age.
4. **A quarantined test still runs**, in a non-blocking job, and its results keep accumulating. It returns to its gate after one full clean window. **It is never silently deleted:** retiring a test means removing its row from the catalog in a pull request that says why, and its id is never reused (section 9).
5. **A quarantined merge-tier test must be fixed or replaced by its expiry.** "Replaced" means a cheaper, deterministic test of the same risk (typically asserting on the request log rather than on timing). When the expiry passes, the gate fails. There are no renewals: a merge-tier quarantine is a hole in the gate over a high-risk scenario, and we keep it short.
6. **Nobody reruns a red job until it is green.** Rerunning is for infrastructure failures (section 10), and it reruns the job, not the test.

## 8. Live-event readiness

A live event is the one case where there is no second chance: nobody can rewatch it, and everyone arrives together. Readiness is therefore judged against numbers, not against a feeling that the tests are green. The numbers live in [`src/shared/criteria.ts`](src/shared/criteria.ts) and the table is generated from it. **They are initial policy** (Phase 1): each is marked as a fact, as arithmetic from the stream's constants (2 s segments, a 15-segment DVR window, a 6 s presentation delay, a 2 s manifest update period), or as an assumption. Phase 7 validates them against real measurements and revises them with evidence; a limit that the default player cannot meet is a finding, not a number to relax. Metric definitions are in [docs/METRICS.md](docs/METRICS.md).

<!-- BEGIN:LIVE_CRITERIA -->
| Criterion | Limit | How it is measured | Where the number comes from |
| --- | --- | --- | --- |
| Joins sampled | 5 | Fresh sessions joined one after another at different positions inside a segment interval (PB-RDY-001). | Assumption: Five is enough to expose a systematic start problem and keeps the check near 40 s. The worst join is judged, because a member only experiences their own. |
| Start time, worst join | 5,000 ms (5 s) | `startupMs` (load-requested to firstframe) of every sampled join; the maximum is compared. | Assumption: About 2.5 segments. A join on localhost is a handful of small requests, so the limit is loose on purpose: it fails a join that is plainly broken under event conditions, while the performance gate (PB-PERF-001) detects small regressions. Phase 7 replaces it with a multiple of the measured join time. |
| Latency target | 6,000 ms (6 s) | A reference, not a limit: where the playhead sits behind the live edge. | Arithmetic: The `suggestedPresentationDelay` of the live manifest: three segments of 2 s. |
| Latency, p95 | 8,000 ms (8 s) | p95 of the `latencyMs` samples over the measurement window after the first frame. | Arithmetic: Target plus one segment: the stream is GOP-aligned to the segment, so a start, seek or catch-up position is only defined to within one segment. |
| Latency, maximum | 10,000 ms (10 s) | Largest `latencyMs` sample outside an injected fault window. | Arithmetic: Target plus two segments: one segment of positioning granularity and one of manifest-refresh lag. Beyond it the player is further behind than the system can explain. |
| Injected origin stall | 10,000 ms (10 s) | A scenario parameter, not a limit: how long PB-REC-008 and PB-RDY-003 stop the origin from publishing. | Assumption: Longer than the 6 s presentation delay, so the buffer is certain to drain and the player really stalls; short enough to be a realistic origin hiccup. |
| Stall recovery | 14,000 ms (14 s) | From `buffering-start` to the next `playing` during the injected stall; the worst of the repeated runs is judged. | Arithmetic: The origin outage plus two segments: one manifest-refresh interval and one segment fetch after the origin returns. The player may stall for less than the outage (it has buffer), never for more than this. |
| Latency restored after a stall | 60,000 ms (60 s) | Time from recovery (`playing`) until `latencyMs` is back within the maximum above. | Assumption: A member who lived through an outage should be back at the live edge within about a minute (30 segments). Phase 7 measures what the default configuration and the candidate really achieve: a limit the default cannot meet is a finding, not a number to relax. |
| Manifest update period | 2,000 ms (2 s) | A reference, not a limit: the update period the origin advertises. | Fact: docs/CONTRACTS.md section 3: DASH `minimumUpdatePeriod` PT2S; the HLS target duration is the same 2 s. |
| Manifest refresh, longest gap | 4,000 ms (4 s) | Longest gap between consecutive manifest (or media playlist) requests in the request log, outside injected faults. | Arithmetic: Two update periods: one period of tolerance for fetch time and timer granularity. Two missed periods means the player has stopped tracking the window. |
| Manifest refresh, shortest median gap | 1,000 ms (1 s) | Median gap between consecutive manifest requests, outside injected faults. | Arithmetic: Half the period. Polling twice as fast as advertised doubles the load on the origin, and at the scale of a live event every member polls. |
| Soak warm-up | 60 s | Excluded from the drift, ratio and heap baselines of a soak. | Arithmetic: Two DVR windows (2 x 30 s): the window has turned over twice, the bandwidth estimate and the JIT have settled. |
| Soak, CI | 5 min | Duration of the short soak that runs in the nightly pipeline. | Assumption: 300 s covers 10 DVR windows and 12 source loops: enough to see loop-boundary, window-slide and drift problems, cheap enough to run every night. |
| Soak, release | 30 min | Duration of the soak that must pass before a release. | Assumption: 1800 s covers 60 DVR windows and 75 source loops, about as long as one job can hold a runner. A real event is longer, so the result is an extrapolation (TEST_STRATEGY.md section 13). |
| Unrecovered stalls | 0 | Buffering episodes that last longer than the stall recovery limit or never end, over the soak. | Assumption: Zero tolerance: a stall that outlasts the limit is a hung player. |
| Critical errors | 0 | Shaka errors with severity 2 in `qa.metrics().errors` over the soak. | Assumption: A critical error ends a viewing session. Recoverable errors are counted and reported, and must be explained by an injected fault. |
| Rebuffer ratio | 0.5 % | Rebuffer ratio (METRICS.md) over the soak after the warm-up, outside injected faults. | Assumption: 0.5%: 1.5 s of stall in the 5-minute soak, 9 s in the 30-minute one. The expected value on a clean localhost session is zero; the allowance absorbs a loaded shared runner. |
| Latency drift | 1,000 ms (1 s) | Median `latencyMs` of the last quarter of the soak minus the median of the first quarter after the warm-up. | Assumption: Half a segment. A trend that large means the playhead is slipping relative to the edge; smaller differences are within what segment-granular positioning and timer jitter explain. |
| JS heap growth (Chromium only) | 20 MB | JS heap after a forced collection (DevTools protocol) at the end of the soak minus the value after the warm-up. | Assumption: The player keeps kilobytes of bookkeeping per segment, so 20 MB over 30 minutes is far beyond a normal sawtooth after collection: crossing it means a leak. The 5-minute soak uses the same number, so it only catches gross leaks; the release soak catches slow ones. |
| Dropped frame ratio | 1 % | Dropped / decoded frames (METRICS.md) over the soak. | Assumption: A round number for "a few frames in a hundred". On a clean localhost run the expected value is near zero, so the limit guards against regressions rather than against a perceptual threshold. |
<!-- END:LIVE_CRITERIA -->

**The checks.** PB-RDY-001 judges the stream start, PB-RDY-002 the live-edge latency over a window, PB-RDY-003 the stall recovery after an injected origin stall (the `originStall` profile factory, section 11), PB-RDY-004 the manifest cadence, and PB-RDY-005 the soak, with a short run in the nightly pipeline and a long run before a release. The functional versions of the same risks gate the merge (PB-LIVE-001 to PB-LIVE-004, PB-REC-008); these judge the numbers.

**What is monitored during the soak.** Samples are taken on media-time milestones from player events, not on timers (ESLint forbids timers in `tests/live`).

- **Rebuffers:** every `buffering-start` and `buffering-end` pair: the count, the total duration, the ratio, and any episode longer than the stall-recovery limit (an unrecovered stall).
- **Latency drift:** `latencyMs` at every few seconds of media time, its p95 and maximum, and the drift (the median of the last quarter minus the median of the first quarter after the warm-up); every `live-edge-seek` event is logged.
- **JS heap growth, Chromium only:** heap usage after a forced collection at the end of the warm-up and at the end, with the whole series kept, so that a steady climb (a leak) can be told from a one-off. Firefox and WebKit have no equivalent and are judged on the other signals.
- **Dropped frames:** the `getVideoPlaybackQuality` counters and their ratio over the soak.
- **Errors:** every Shaka error with its severity and code, console errors and uncaught page errors. Anything outside an injected fault window fails the soak.
- **The request log:** the manifest cadence (median and longest gap), non-2xx responses by kind, and retries of the same segment.

The release soak also injects, at two fixed points, one origin stall and one stale manifest. The stalls attributable to them are judged by the stall-recovery limit and are excluded from the rebuffer ratio.

**The go/no-go checklist** a live-event owner signs. Any No-go reason maps to a criterion above or to a known gap in section 13.

- [ ] The build is identified: commit, Shaka Player version, player configuration (A or B), and the stream flavour each engine plays.
- [ ] The merge gate was green on that commit in every engine, and the release browser tests are green: no `@release` failure and no merge-tier quarantine.
- [ ] PB-RDY-001 to PB-RDY-004 pass in every engine against the table above, with the artifacts attached.
- [ ] The release soak passed in every engine: no unrecovered stall, no critical error, rebuffer ratio, latency drift and dropped frames within their limits, and heap growth within its limit in Chromium.
- [ ] Origin-stall recovery was demonstrated on this build (PB-REC-008 and PB-RDY-003), and latency was restored within its limit.
- [ ] Every configuration change since the last event has an A/B decision on record: ship, or keep A (an inconclusive result means keep A).
- [ ] No quarantined test in the live, recovery or readiness areas. The known-gaps list was read, and every gap that touches a device class the event targets (for example: no real-device evidence, WebKit on macOS only) is accepted in writing by the event owner.
- [ ] Rollback is ready: the previous known-good build and configuration A (the library defaults) can be deployed within minutes, and who decides and who executes is named.
- [ ] Outside the lab: production monitoring and alerting for the event exist. The lab cannot tell what real members experience; what pages someone is latency, rebuffering and start failures.
- [ ] The decision and the evidence links are recorded: Go, or No-go with the criterion or gap that decided it.

## 9. Test catalog

The list of record. Phase 3 and later implement exactly these ids, and the docs check compares the catalog with the specs (section 14). Ids are stable: never renumbered, never reused. The id starts the test title (`test('PB-VOD-001 starts and reaches 3 s of media time', { tag: '@merge' }, ...)`). The areas:

<!-- BEGIN:AREA_LEGEND -->
| Area | Title | Covers | Lives in | Phase |
| --- | --- | --- | --- | --- |
| `VOD` | VOD playback | DASH and HLS video on demand: start, play to the end, pause and resume, every kind of seek, metrics integrity, the open-codec WebM path | `tests/e2e` | 3 |
| `ABR` | Adaptive bitrate | Climbing, downshifting and upshifting with the network, manual and pinned rungs, startup on a weak link | `tests/e2e` | 3 |
| `LIVE` | Live playback | Joining near the live edge, bounded latency, manifest refresh, HLS live, the DVR window, pause in live | `tests/e2e` | 3 |
| `REC` | Recovery | Segment and manifest failures, a bad rung, slow and truncated segments, live origin stall, stale live manifest | `tests/e2e` | 3 |
| `RDY` | Live readiness | Stream start, live-edge latency, stall recovery, manifest cadence and the soak, judged against the numeric criteria | `tests/live` | 7 |
| `PERF` | Performance | Startup, frame rate, rebuffering and the low-end profile, repeated runs against committed baselines | `perf/` | 5 |
| `AB` | Experiments | A/A sanity run and A/B comparison of two player configurations on startup and rebuffering | `ab/` | 6 |
| `ENV` | Environment | Real-decode capability probe per engine, deterministic streams | `tests/e2e` and `tests/unit` | 2 and 3 |
| `EME` | Encrypted media | ClearKey playback (stretch goal) | `tests/e2e` | 3 (stretch) |
| `LAB` | The lab itself | Self-tests of the fault engine, live clock, manifests, statistics, flake math, triage and the docs tooling | `tests/unit` | with each component |
<!-- END:AREA_LEGEND -->

**Columns.** `Risk` is likelihood x impact = score (section 4). `Tier` is `merge` or `release` and follows from the risk and the lane (section 4.2). `Engines` is a comma-separated list from `chromium`, `firefox`, `webkit`, `chromium-cpu4x`, or `all` (= chromium, firefox and webkit; `webkit` means WebKit on macOS); `none` is for unit tests, which use no browser. `Runs in` is one of `e2e`, `live`, `perf`, `ab`, `unit`. `A failure means` states what the failure means and the decision it triggers: for every row the answer to "what decision does this test's failure drive".

**Tags.** A browser-lane row with tier `merge` carries `@merge`, and one with tier `release` carries `@release`; a row whose engines include `chromium-cpu4x` also carries `@cpu`. The content tags of docs/CONTRACTS.md section 7 (`@live`, `@hls`, `@dash`, `@eme`, `@soak`) say what a test plays and are chosen by the spec. A scenario marked `(stretch)` may legitimately have no implementation yet; it is never dropped silently.

<!-- BEGIN:TEST_CATALOG -->
| ID | Area | Scenario | Risk | Tier | Engines | Runs in | A failure means |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-VOD-001 | VOD | DASH VOD (`vod-cmaf`) starts: first frame presented, 3 s of media time reached, no error | 3x5=15 | merge | all, chromium-cpu4x | e2e | Members cannot start a title in this engine, or only on a fast machine. Blocks the merge: fix or revert; read PB-ENV-001 first to rule out a capability change. |
| PB-VOD-002 | VOD | HLS VOD (`vod-cmaf` over HLS) starts: first frame presented, 3 s of media time reached, no error | 3x5=15 | merge | all | e2e | HLS members cannot start; the HLS path is a separate parser over the same segments. Blocks the merge: diff the request log against the DASH run (PB-VOD-001) to find the request that diverged. |
| PB-VOD-003 | VOD | Plays a short title to the end (`vod-cmaf-short`): `ended` fires near the duration, no rebuffer, no error | 3x4=12 | release | all | e2e | Members hit a hang or a missing end event at the end of a title. Blocks the release: check the last segment's request and the end-of-stream handling in the trace. |
| PB-VOD-004 | VOD | Pause stops the media clock: no media-time advance and no `playing` event while paused | 2x4=8 | release | all | e2e | The picture keeps running while the member believes it is paused. Blocks the release: a deterministic regression in the pause path, so bisect the day's merges. |
| PB-VOD-005 | VOD | Resume continues from the paused position: no jump, no seek, no rebuffer | 3x4=12 | release | all | e2e | Members lose their place or stall after resuming. Blocks the release: compare the media time before the pause and after the resume in `qa.events()`. |
| PB-VOD-006 | VOD | Seek forward inside the buffered range: `seeked` fires and playback continues from the target with no rebuffer | 4x4=16 | merge | all | e2e | Scrubbing inside the loaded stretch hangs or lands in the wrong place. Blocks the merge: look at the seeking and seeked pair and the position after it in `qa.events()`. |
| PB-VOD-007 | VOD | Seek to an unbuffered position: `seeked`, playback from the target, and the request log shows the segment that covers it and no refetch of earlier ones | 4x4=16 | merge | all, chromium-cpu4x | e2e | Scrubbing into unloaded content hangs, lands wrong, or refetches segments it already had. Blocks the merge: compare the segment numbers in the request log with the target time. |
| PB-VOD-008 | VOD | Seek backward to a position the buffer has already evicted: playback resumes from the target | 3x4=12 | release | all | e2e | Rewinding far fails once old data has been evicted. Blocks the release: check eviction and the refetch in the request log. |
| PB-VOD-009 | VOD | Rapid repeated seeks: five seeks issued back to back, the last target wins, playback resumes, no error | 5x4=20 | merge | all | e2e | Skipping around (a remote control, a scrubber drag) freezes the player or ends in an error. Blocks the merge: this is a race, so keep the trace of the first failing attempt and never rerun until green. |
| PB-VOD-010 | VOD | Seek into the last segment: playback runs on to `ended` | 3x3=9 | release | all | e2e | Members who skip to the credits get no end or a hang. Blocks the release: check the last segment's duration handling in the request log and the trace. |
| PB-VOD-011 | VOD | Play after ended: `play()` restarts from the beginning without reloading | 3x4=12 | release | all | e2e | Replaying a finished title is stuck at the end. Blocks the release: check the state transition after `ended` in `qa.events()`. |
| PB-VOD-012 | VOD | Metrics integrity on a clean network: decoded frames above zero, dropped no more than decoded, presented frames agree with decoded, no rebuffer, startup defined, no error | 3x5=15 | merge | all | e2e | The lab's own instrument is wrong in this engine, so baselines, A/B verdicts and readiness numbers taken with it are void. Blocks the merge and marks that engine's performance results invalid until fixed. |
| PB-VOD-013 | VOD | Open-codec path (`vod-webm`, DASH): starts and plays 3 s | 3x3=9 | release | all | e2e | Members on the open-codec path cannot play (the CMAF flavour is a fallback in most engines). Blocks the release: check PB-ENV-001 for a capability change first. |
| PB-ABR-001 | ABR | Climbs to the top rung on an unconstrained network and stays there | 3x4=12 | release | all | e2e | Members on a good connection watch lower quality than they could. Blocks the release: compare the bandwidth estimates in the `variant-changed` events with the declared bandwidths. |
| PB-ABR-002 | ABR | Downshifts when bandwidth drops mid-playback (`bandwidth-drop`): at most one rebuffer, settles on a rung the network can carry | 4x4=16 | merge | all | e2e | Members on a weakening connection get stall after stall instead of lower quality. Blocks the merge: read the `variant-changed` events against the rung per segment in the request log. |
| PB-ABR-003 | ABR | Upshifts after the bandwidth recovers (the throttle is removed once the downshift has happened) | 4x3=12 | release | all | e2e | Members stay at low quality after the network recovers. Blocks the release: check how long after the throttle was removed the first upshift happened. |
| PB-ABR-004 | ABR | Manual rung change (`selectVariantByHeight`) is seamless: no rebuffer, no error, continuous playhead | 3x3=9 | release | all | e2e | A quality menu choice causes a stall or an error. Blocks the release: the pin control is also used by the performance runs, so run PB-ABR-005 as well. |
| PB-ABR-005 | ABR | ABR disabled stays on the pinned rung even when the network cannot carry it (`constrained-1500`, pinned at 720p) | 2x4=8 | release | all | e2e | The lab's pin control does not hold, so frame-rate baselines measure the wrong rung. Blocks the release and puts PB-PERF-002 results under suspicion until it is fixed. |
| PB-ABR-006 | ABR | Startup on a constrained network (`constrained-600`): first frame within a bound derived from the throttle, at most one rebuffer in the first 10 s, settles on the lowest rung | 4x3=12 | release | all | e2e | Members on slow connections wait too long or stall at the start. Blocks the release: compare with the PB-PERF-003 trend. |
| PB-ABR-007 | ABR | The bitrate history of `window.__qa` agrees with the rungs the request log shows (`bandwidth-drop`) | 3x4=12 | release | all | e2e | Two observation channels disagree, so adaptation metrics cannot be trusted. Blocks the release: decide whether the hook or the service log is wrong with a manual capture of the same session. |
| PB-LIVE-001 | LIVE | Joins near the live edge: first frame, and latency at the first frame within the p95 limit of the readiness criteria | 4x5=20 | merge | all, chromium-cpu4x | e2e | Members joining a live event land far behind the action, or cannot join. Blocks the merge: check the service clock request, the edge number in the manifest and the first segment requested. |
| PB-LIVE-002 | LIVE | Latency stays bounded over a 20 s window: maximum within the limit, no live-edge seek loop, no rebuffer | 4x4=16 | merge | all | e2e | Members drift behind the live event. Blocks the merge: plot `latencyMs` over the window to tell drift from jitter. |
| PB-LIVE-003 | LIVE | Manifest refresh keeps the playhead inside the seek range across at least five refreshes | 4x5=20 | merge | all | e2e | Playback dies minutes into a live event when the window slides past the playhead. Blocks the merge: check the manifest request cadence and the seek range in the trace. |
| PB-LIVE-004 | LIVE | HLS live: joins, plays and stays inside the sliding window across at least five playlist refreshes | 3x5=15 | merge | all | e2e | HLS members cannot watch live. Blocks the merge: if PB-LIVE-003 (DASH) fails the same way the live clock is at fault; if only this row fails, look at the playlist builder or the player's HLS path. |
| PB-LIVE-005 | LIVE | Seek back into the DVR window, then return to the live edge | 4x3=12 | release | all | e2e | Members cannot rewind a live event, or cannot get back to live. Blocks the release: check the seek range against the target in the trace. |
| PB-LIVE-006 | LIVE | Pause and resume in live: resume continues from the paused position while it is inside the DVR window | 3x3=9 | release | all | e2e | Resuming after a pause in a live event lands in the wrong place or fails. Blocks the release: check the pause length against the DVR window. |
| PB-REC-001 | REC | Transient segment 404 (`transient-404`): the failed request is retried and succeeds; playback continues with no critical error and at most one rebuffer | 4x4=16 | merge | all | e2e | One missed segment becomes a visible stall or an error. Blocks the merge: the request log shows whether the retry happened and how long it took. |
| PB-REC-002 | REC | 5xx burst (`flaky-segments`, three 503s on segment 3): playback continues by retry or rung switch, no critical error, at most one rebuffer | 4x4=16 | merge | all | e2e | A short CDN hiccup stops playback. Blocks the merge: read the error severities in `qa.metrics().errors` and which rung served segment 3 afterwards. |
| PB-REC-003 | REC | Persistent failure on one rung (`rung-outage`): the player moves to another rung and continues; failed requests to the rung stay bounded | 3x4=12 | release | all | e2e | One bad rendition kills the session, or the player keeps hammering the origin for it. Blocks the release: count the failed requests to that rung in the log. |
| PB-REC-004 | REC | Slow segment (`slow-segment`): at most one rebuffer, recovers by itself, no error | 4x3=12 | release | all | e2e | A late segment freezes playback for good. Blocks the release: compare the delayed request's `ttfbMs` with the stall in `qa.events()`. |
| PB-REC-005 | REC | Truncated segment (`truncated-segment`): the segment is retried; no decode-error loop, no critical error | 3x4=12 | release | all | e2e | A cut-off download crashes or loops the media pipeline. Blocks the release: this is engine-specific, so compare the error codes of the three engines. |
| PB-REC-006 | REC | Manifest failure at load (`manifest-down`): `load()` fails with an error in bounded time, and a retry after the fault is removed plays | 3x4=12 | release | all | e2e | Members see an endless spinner instead of an error, or cannot retry after the origin returns. Blocks the release: check the time from `load()` to the error. |
| PB-REC-007 | REC | Persistent segment failure (`segments-down`): a critical error is surfaced in bounded time and the state becomes error | 3x4=12 | release | all | e2e | A dead origin leaves the player spinning instead of failing. Blocks the release: check how long it took to give up on every rung. |
| PB-REC-008 | REC | Live origin stall recovery (`originStall`): the player resumes after the origin returns, with at most one stall episode and no critical error left | 4x5=20 | merge | all | e2e | A live event freezes for everyone when the origin hiccups. Blocks the merge: compare `buffering-start` and `playing` with the injected window; PB-RDY-003 then judges the same recovery against the numeric limit. |
| PB-REC-009 | REC | Stale live manifest (`staleManifest`): playback continues from the buffer, and after fresh manifests return the playhead is inside the seek range | 3x4=12 | release | all | e2e | A stale manifest strands the player outside the seek range. Blocks the release: compare the seek range after the manifest recovers with the playhead. |
| PB-RDY-001 | RDY | Stream start: the sampled fresh live joins each reach the first frame within the start limit | 4x5=20 | release | all | live | The candidate joins too slowly under event conditions. No-go for a live event until fixed: compare with the VOD startup trend (PB-PERF-001). |
| PB-RDY-002 | RDY | Live-edge latency over a window: p95 and maximum within the limits | 4x4=16 | release | all | live | Members would sit too far behind the live edge. No-go: plot latency over the window and read PB-LIVE-002 for the same engine. |
| PB-RDY-003 | RDY | Stall recovery after an injected origin stall: recovery within the limit and latency restored within its limit | 4x5=20 | release | all | live | An origin outage costs members more than the outage, or leaves them behind the edge. No-go: read the stall and restore times against the limits. |
| PB-RDY-004 | RDY | Manifest update cadence: median and longest gap between refreshes within the limits | 4x5=20 | release | all | live | The player is not tracking the live window (too slow) or hammers the origin (too fast). No-go: compare the manifest request gaps in the log with the advertised period. |
| PB-RDY-005 | RDY | Soak (CI soak nightly, release soak before a release): no unrecovered stall, no critical error, rebuffer ratio, latency drift, JS heap growth (Chromium) and dropped frames within the limits | 3x5=15 | release | all | live | The player degrades over time (drift, leaks, stalls, dropped frames). No-go: find the first sample that left its limit, then bisect the nightly builds. |
| PB-PERF-001 | PERF | Startup baseline (`vod-cmaf`, `clean`): median and p90 of N fresh-context runs against the committed baseline of this environment | 4x4=16 | merge | all | perf | Startup got slower for every member. Blocks the merge once the automatic re-measure reproduces it: split it into manifest time and first-segment time, then bisect. |
| PB-PERF-002 | PERF | Steady-state frame rate and dropped frames (`vod-cmaf`, `clean`, pinned 720p, a 5 s measured window): effective fps and dropped ratio against the baseline | 4x4=16 | merge | all | perf | Playback is less smooth: frames are dropped or presented late. Blocks the merge once reproduced: check which rung was playing first, then the page's per-frame work. |
| PB-PERF-003 | PERF | Rebuffering on a changing network (`bandwidth-drop`): count, duration and ratio against the baseline and an absolute budget | 4x4=16 | merge | all | perf | Members rebuffer more on a changing connection. Blocks the merge once reproduced: read the adaptation events of the slowest run. |
| PB-PERF-004 | PERF | Low-end device profile (4x CPU throttle, Chromium): startup and dropped frames against the profile's baseline | 3x5=15 | merge | chromium-cpu4x | perf | Slow devices start later or drop frames. Blocks the merge once reproduced: look at the main-thread work added since the baseline. |
| PB-AB-001 | AB | A/A sanity run: two identical configurations compared under the experiment's conditions; the false-positive rate stays near the chosen significance level | 3x4=12 | release | chromium | ab | The comparison harness finds differences between identical configurations too often. No A/B verdict is published until the cause (noise, ordering or a statistics bug) is fixed. |
| PB-AB-002 | AB | A vs B on startup under `high-latency`: pre-registered metric, effect size and confidence interval | 4x4=16 | release | chromium | ab | B starts slower than A beyond the practical threshold with an interval that excludes zero: do not ship B. Inconclusive is not a failure: keep A and collect more sessions. |
| PB-AB-003 | AB | A vs B on rebuffering under `bandwidth-drop`: pre-registered metric, effect size and confidence interval | 4x4=16 | release | chromium | ab | B rebuffers more than A beyond the practical threshold with an interval that excludes zero: do not ship B. Inconclusive means keep A. |
| PB-ENV-001 | ENV | Capability probe per engine: a real-decode probe finds a playable flavour, or the engine and OS pair is a documented gap (specs skip with that reason) | 3x5=15 | merge | all | e2e | The engine can no longer play what the matrix says it can (a browser, codec or runner image changed), so every playback result of this job is unreliable. Blocks the merge as an environment failure: fix the environment, do not retry the tests. |
| PB-ENV-002 | ENV | Stream determinism: the same spec generated twice has the same content hash, and a changed spec has a different one | 2x5=10 | merge | none | unit | Streams are not reproducible, so timing assumptions and baselines are void. Blocks the merge: check the ffmpeg version and the encoder flags. |
| PB-EME-001 | EME | ClearKey playback (stretch goal): `vod-cmaf-clearkey` plays with a ClearKey license | 2x5=10 | release | chromium, firefox | e2e | Protected playback (ClearKey only) is broken: the stream does not play with its key, or a wrong key or no key plays it. Blocks the release. WebKit is not an engine of this row: macOS WebKit plays the stream because the player decrypts it itself, not the browser's ClearKey, and Linux WebKit has no EME (ADR-105 in docs/decisions/e2e-eme.md). |
| PB-LAB-001 | LAB | Fault engine honours its configuration: the throttle delivers the configured rate within tolerance, latency and jitter repeat for the same session, `times`, `afterMs` and `forMs` apply as documented | 3x5=15 | merge | none | unit | The lab applies the wrong condition, so player results are meaningless. Blocks the merge: fix the service before looking at any browser failure. |
| PB-LAB-002 | LAB | Live clock and `tfdt` rewriting: segment numbers follow the virtual clock and the looped source yields a monotonic timeline | 3x5=15 | merge | none | unit | The live simulation is wrong (segment numbers, timestamps or the loop). Blocks the merge: fix it before trusting any live result. |
| PB-LAB-003 | LAB | Manifest builders: DASH and HLS, VOD and live, parse back to what the contract says | 3x5=15 | merge | none | unit | A manifest the service serves breaks the contract. Blocks the merge: fix the builder; every player failure on that manifest is suspect. |
| PB-LAB-004 | LAB | Statistics and flake math: Mann-Whitney U, Holm correction, shift estimate and interval, effect size, flake rate, quarantine decisions and the regression rule, against known answers | 3x4=12 | merge | none | unit | A statistic is wrong, so an A/B verdict, a flake decision or a performance call is wrong. Blocks the merge: fix it before any verdict is believed. |
| PB-LAB-005 | LAB | Triage signatures: failures with the same cause cluster together whatever their ids and timestamps, and different causes do not | 3x3=9 | merge | none | unit | Failures are clustered wrongly, so triage misleads. Blocks the merge: triage never decides a verdict, but a wrong cluster wastes the first hour. |
| PB-LAB-006 | LAB | Docs tooling: the catalog parser, the generated blocks, and the budget and ranking checks refuse malformed input and detect stale blocks | 2x4=8 | merge | none | unit | The documents can drift from the code unnoticed. Blocks the merge: fix the checker before changing any document. |
| PB-LAB-007 | LAB | Fault profiles and policy constants are well formed: shapes, numeric sanity and the arithmetic their texts quote | 2x4=8 | merge | none | unit | A fault profile or a policy number is malformed, and every other area uses them. Blocks the merge: fix it before any other result is read. |
<!-- END:TEST_CATALOG -->

**Retired and renamed ids:** none. A retired id stays here with its reason; a renamed test keeps its id.

## 10. What a failure drives

**The rule.** A failure is what is left after the retry: a test that fails and then passes is a flake, recorded and counted against the budget, and it does not block that pull request by itself. A merge-tier failure blocks the merge, a release-tier failure blocks the release, a unit failure blocks the merge. The last column of the catalog says, for every row, what the failure means to members and which decision it triggers, and where to look first. Failures are classified before they are acted on:

| Class | How we recognise it | Owner | First action | Look first at |
| --- | --- | --- | --- | --- |
| Functional regression | Fails on the first attempt and on the retry, reproduces locally (`npm run test:e2e -- --grep PB-VOD-006`), and the timeline shows the player doing the wrong thing. | The author of the change. | Reproduce with the test's id, then fix or revert. Do not rerun until green. | The `qa.events()` timeline around the first wrong event (attached to the failure), then the request log, then the Playwright trace. |
| Performance regression | The performance gate fails on the median or the p90 and the automatic re-measure reproduces it. | The author of the change. | Compare the per-run values with the committed baseline and its variation; split startup into manifest time and first-segment time; bisect the commits since the last green baseline. | The performance report diff, the per-run values, `qa.metrics()` of the slowest run, the request log's `ttfbMs`. |
| Flake | Fails, then passes on the retry; or the flake gate lists the test above its trigger; no product signal in the timeline. | The owner of the test (the area owner, named in the quarantine entry). | Do not rerun the job. Record it; if the test is above the trigger, fix it or quarantine it the same day with an owner, a reason and an expiry. | The first failed attempt's trace (not the green retry), the order of events (a missed or late one), runner load, and whether the request log shows the faults firing as configured. |
| Environment or infrastructure | A browser did not launch, the service is not healthy, ffmpeg is missing, a port clash, the capability probe changed, or many unrelated tests fail at once. | The lab maintainer, with the CI owner. | Fix the environment and rerun the job, not the test. Never edit a test to make an environment failure go away. | The job log, `/health`, the output of PB-ENV-001, the codec matrix. |
| Known gap | A documented limitation (Linux WebKit's MSE playback, Firefox on the macOS host): the spec is skipped with its reason. | The lab maintainer. | Nothing for the pull request; re-probe on every browser upgrade. A skip without a reason is a bug. | The skip reason in the report and the codec matrix. |

Failure triage (Phase 8) clusters the failures of a red build by root cause: a deterministic signature first (the normalised error message, the Shaka error code and the top application frame), so the same cause is one cluster whatever the ids and timestamps; an optional language-model summary when a key is configured (none is here, so summaries are untested against the real service and the README says so). A cluster is mapped to one of the classes above. It saves the first hour; it never decides a verdict.

## 11. Test data and fault profiles

**Deterministic streams.** Streams are generated from ffmpeg test patterns (`testsrc2`, `sine`: no third-party media) by a pure function of a specification, and cached content-addressed (`.cache/streams/<specHash>/`). Every rung is GOP-aligned to the 2 s segment. `GET /api/streams` reports each stream's `contentHash`: sha256 over the specification and every segment hash, so identical specification and ffmpeg build give an identical hash (PB-ENV-002). A different ffmpeg build changes the hash, and with it every baseline: regenerate them together. The ladder is three VP9 rungs (240p 300 kbps, 360p 700 kbps, 720p 1800 kbps) plus 64 kbps audio; the catalog of streams is in [docs/CONTRACTS.md](docs/CONTRACTS.md) section 3.

**Per-test sessions.** A test creates a session (`POST /api/sessions`) and owns everything in it: its own live clock, fault rules, token bucket and request log. Tests therefore cannot interfere, and run in parallel. The live clock is virtual and starts at the session's creation, so a test moves the world with events, never with sleeps.

**Named profiles.** Conditions are named, typed lists of fault rules ([`src/shared/profiles.ts`](src/shared/profiles.ts)), checked against the shapes of [`src/shared/faults.ts`](src/shared/faults.ts) and, in the unit tests, for numeric sanity and for the arithmetic below. The table is rendered from the code:

<!-- BEGIN:FAULT_PROFILES -->
| Profile | Rules sent to the service | What it is for | Used by |
| --- | --- | --- | --- |
| `clean` | none | The control condition: no faults. Functional tests that must not be disturbed, and the baseline of the startup and frame-rate scenarios. | PB-VOD-001, PB-PERF-001, PB-PERF-002, PB-PERF-004 |
| `constrained-1500` | throttle 1,500 kbps on media requests | A 1500 kbps link carries the 360p rung with its audio (700 + 64 = 764 kbps) with headroom, but not the 720p rung (1800 + 64 = 1864 kbps): adaptive playback must settle on 360p, and a pinned 720p must struggle. | PB-ABR-005 |
| `constrained-600` | throttle 600 kbps on media requests | A 600 kbps link carries only the 240p rung with its audio (300 + 64 = 364 kbps; 360p needs 764): the slowest connection the ladder can serve. | PB-ABR-006 |
| `bandwidth-drop` | throttle 600 kbps on media requests, from 8 s after the first media request | A connection that weakens mid-title. The first 8 s are four segments, and the Shaka 5.3.3 default minimum switch interval is also 8 s, so the player has had the chance to climb before the link drops to what only the 240p rung can carry. The player must step down with at most one rebuffer. | PB-ABR-002, PB-ABR-003, PB-ABR-007, PB-PERF-003, PB-AB-003 |
| `high-latency` | latency 300 ms (jitter 100 ms) on all requests | A distant or congested link: about 300 ms before the first byte of every response, manifests included, with jitter. Startup is a chain of round trips (manifest, initialization segments, first segments), so a configuration that saves a round trip shows up here at about 300 ms, where on localhost the same saving is a few milliseconds below the noise. Jitter is seeded with the session id: a rerun with the same request order sees the same delays. | PB-AB-002 |
| `flaky-segments` | 503 on video segment 3, first 3 requests | A CDN hiccup in the middle of a title: the first three requests for video segment 3 fail. Three in a row exceed the two attempts of the default retry policy, so the player must take its failure path (disable the rung, switch to another) and carry on. Selecting by segment number hits the same segment in every engine, whichever rung is playing. | PB-REC-002 |
| `transient-404` | 404 on video segment 3, first request only | One missed object: a single failure that the default retry policy (two attempts) absorbs, so the member should notice nothing. The counterpart of the burst above: one retry versus the failure path. | PB-REC-001 |
| `slow-segment` | latency 8,000 ms on video segment 3, first request only | A late segment, not a failed one: 8 s is below the default 10 s connection timeout, so the request succeeds, but late, and only the two segments buffered ahead of it (4 s) cover the wait. The player must absorb it with at most one rebuffer and recover on its own. | PB-REC-004 |
| `rung-outage` | 503 on v720 media requests | One rendition is down while the others are healthy. The player must stop asking for it (after the retry policy, not forever), move to another rung and carry on, and the request log must show that the failed requests stay bounded. | PB-REC-003 |
| `truncated-segment` | connection cut after 20,000 bytes on video segment 3, first request only | A connection that dies mid-download. 20,000 bytes is less than half of the smallest video segment (300 kbps x 2 s = 75,000 bytes), so the body is truncated whichever rung is playing. The segment must be retried, without a decode-error loop. | PB-REC-005 |
| `manifest-down` | 503 on manifest requests | The origin is down at load until the test removes the rule. `load()` must fail with an error in bounded time (not hang), and a retry after the rule is removed must play. | PB-REC-006 |
| `segments-down` | 503 on segment requests | Nothing can be fetched after the manifest, until the test removes the rule. The player must surface a critical error in bounded time, with every rung tried and given up on, instead of spinning forever. | PB-REC-007 |

| Factory | Condition | What it is for | Used by |
| --- | --- | --- | --- |
| `originStall(atNumber, ms)` | The live origin stops publishing at segment `atNumber` for `ms`, then catches up. | The live outage. A stall depends on the live segment number, which only the session knows (`SessionInfo.live.edgeNumber`), so it is a factory. The injected length of the readiness checks is 10 s, longer than the 6 s presentation delay, so the buffer must drain. | PB-REC-008, PB-RDY-003, PB-RDY-005 |
| `staleManifest(ms, afterMs?)` | The manifest endpoint serves the last version it served before the rule started, for `ms`. | A stale cache, or an origin that stopped updating its manifest while still serving segments: the player must live on its buffer and find its place again when fresh manifests return. | PB-REC-009 |
<!-- END:FAULT_PROFILES -->

**How a test gets reproducible conditions.**

```ts
import { profile, originStall } from '../../src/shared/profiles.ts';

// VOD: a named profile, a fresh copy the test may tweak.
const session = await service.createSession({ stream: 'vod-cmaf', label: testInfo.title, faults: profile('bandwidth-drop') });

// Live: the stall depends on the live segment number, which only the session knows.
const live = await service.createSession({ stream: 'live-cmaf', label: testInfo.title });
await service.addFaults(live.id, originStall(live.live!.edgeNumber + 3, 10_000));
```

Four rules make a condition reproducible. The condition is data, applied by the service below the engine, so it is the same in every engine. Where the scenario allows it, rules select by segment number, not by time. Jitter is drawn from a generator seeded with the session id, so a rerun with the same request order sees the same delays. And the request log says which rule fired on which request (`faults`), so a failure shows what was applied.

## 12. Experiments (A/B) policy

Phase 6 builds this; the policy is fixed here so the harness is built to it. An experiment compares two player configurations (A: the library defaults; B: a tuned candidate, both printed by `qa.info()`) on two **pre-registered** metrics: startup time (PB-AB-002, under `high-latency`) and rebuffering (PB-AB-003, under `bandwidth-drop`). Before any data is collected, a pre-registration file committed with the report fixes the metrics and conditions, the number of sessions per arm (never fewer than thirty, and set from the variance the A/A run measures), the **practical-significance threshold** (the smallest difference worth changing a configuration for, never smaller than what the harness can tell from noise) and the decision rule. Sessions of A and B are **interleaved** (A, B, A, B...) in fresh browser contexts, so that drift in machine load cancels out; the first sessions are discarded as warm-up; the report records the environment, date and commit.

**An A/A run comes first** (PB-AB-001): the same configuration is compared with itself, repeatedly, with different seeds, and the share of results declared significant must be close to the chosen significance level (0.05). If the harness finds differences between identical configurations more often than that, no A/B verdict is published, because the harness's false-positive rate is the thing every verdict rests on.

The statistics assume nothing about the shape of the data: startup times are right-skewed and the rebuffer ratio is zero for many sessions. The comparison is a **Mann-Whitney U test** with the **Hodges-Lehmann shift** as the effect estimate and a seeded bootstrap 95% **confidence interval**; **Cliff's delta** as a scale-free effect size; and, for the share of sessions with at least one rebuffer, Fisher's exact test. The p-values of the two primary metrics are adjusted with **Holm's method**, which controls the family-wise error rate and is never less powerful than Bonferroni.

**The decision rule.** Ship B only if it is better on at least one primary metric (adjusted p below the significance level and the confidence interval entirely beyond the practical threshold in B's favour) and not worse on the other (the worse end of its interval inside the threshold). If B is worse beyond the threshold with an interval that excludes zero: do not ship B. Anything else is inconclusive: keep A, and the report says how many more sessions a decision would need. An inconclusive result is a legitimate result. The report also says what it cannot say: one engine (Chromium), localhost, synthetic content, one condition per metric.

## 13. Known gaps, limitations and risks of the strategy itself

**Gaps in what the lab can run.**

- **Linux WebKit.** Playwright's Linux WebKit exposes `MediaSource` and answers `isTypeSupported` with `true` for everything, but MSE playback fails (`MediaError 4: Failed to push buffer`, intermittently). The WebKit playback suites run on macOS; on Linux they are skipped with that reason, and the probe keeps reporting it so that a fixed build is noticed (ADR-001).
- **Firefox on the macOS development host** does not start ("Could not find profile folder"); locally it runs in Docker.
- **The low-end class is simulated in Chromium only.** Firefox and WebKit cannot be throttled, so the lab has no low-end evidence for them. A throttle is not a device.
- **Playwright's WebKit is not Safari**, and Playwright's engines are not the consumer browsers.
- **The live simulation** uses 2 s segments (no low-latency chunking), loops a 24 s source (rewriting timestamps so that the loop never shows), supports no live WebM, and has one ladder (240p to 720p, 30 fps, stereo AAC or Opus). Anything above that is untested.
- **Not covered at all:** real devices, real CDNs, commercial DRM, captions, ads, picture-in-picture, accessibility, perceptual quality (section 1).

**Limits of the numbers.**

- Every measurement is localhost, software decode, synthetic content: valid for comparing builds and configurations under identical conditions, not as production quality of experience, and never across environments.
- The policy numbers (readiness, budgets, flake) are **initial policy**: arithmetic from the stream's constants or assumptions, none of them measured. Phase 7 validates them; until then they are defensible, not proven.
- The expected test durations behind the time budgets are design estimates; Phase 3 replaces them with measured ones.
- The risk scores are judgments until failure history exists; section 4.2 says how evidence revises them.
- The release soak is 30 minutes on a runner; a live event lasts hours, so soak results are an extrapolation. Heap growth is measured in Chromium only.
- A/B runs in one engine. The language-model summaries of triage have not been exercised against the real service on this host (no key); the deterministic clustering is the contract.

**Risks of the strategy itself.**

1. **The instrument is ours.** `window.__qa` is written by us, so a wrong metric would be wrong everywhere. Mitigation: PB-VOD-012 checks its integrity against the browser's own counters, PB-ABR-007 checks it against the server's log, and the metric definitions are written down ([docs/METRICS.md](docs/METRICS.md)).
2. **Tests that cannot fail.** A gate that passes is only evidence if it could have failed. Mitigation, planned for Phases 4 and 5: a deliberately regressed configuration must turn the merge and performance gates red, and the pull request that proves it is kept.
3. **The ranking may be wrong.** Mitigation: scores are explicit, the evidence that revises them is defined, and an escape is treated as a defect in this document.
4. **The merge gate can be blocked by flakiness that is not the pull request's.** That is deliberate, because the cost of flakiness is shared; the way out is a same-day quarantine with an owner and an expiry (section 7).
5. **A day of exposure.** A regression in a release-tier or soak area can sit on `main` until the nightly run finds it, and bisecting is over one day's merges. We accept it for scores below the line and for the long live sessions; it is the price of a short merge gate.
6. **Noisy runners.** Shared CI machines make performance noisy: false alarms are reduced by per-environment baselines and the re-measure, and small regressions below the thresholds will pass. The A/A run measures what the harness can and cannot see.
7. **A green gate is not a release verdict.** It says the risks we ranked above the line did not regress in the lab; for a live event the checklist in section 8 is what decides.

## 14. Traceability: how this document stays true

A document of numbers is only as good as the tool that refuses it when it is wrong. `npm run docs:check` (part of `gate:static`) fails the build when any of these is false:

- **The catalog parses strictly** ([`tools/catalog.ts`](tools/catalog.ts)): exactly the columns of section 9 in order; ids of the form `PB-AREA-NNN`, unique, and in an area that exists; the area column agrees with the id; the risk multiplies out; the tier, the engines and the lane are among the allowed values and agree with each other; no empty cell.
- **Every tier follows the rule** of section 4.2, from the risk and the lane, and no area has been dropped.
- **The risk ranking drives the catalog:** the areas are ordered by score, every cited risk is the catalog's, every gate is what its rows are, and every catalog row answers to exactly one area.
- **The merge tier fits its budget:** the table in section 6.3 is computed from the catalog, and a job over its budget or an engine over the ceiling fails the check.
- **Every generated block is up to date.** The tier thresholds, the area legend, the budgets, the merge budget, the flake policy, the live criteria and the fault profiles are rendered from code between `BEGIN` and `END` markers. `npm run docs:check -- --write` rewrites them; `-- --print` shows them without writing.
- **Every test id cited anywhere in the documentation exists in the catalog**, and a risk written after an id (`PB-VOD-001 (3x5=15)`) is the catalog's.
- **Every relative link points at a file that exists.**

**Catalog and specs (Phase 3).** From Phase 3 the same check compares the catalog with the test files: every id has a spec whose title starts with it, every spec id is in the catalog, the tags agree with the tier (`@merge`, `@release`) and the engines (`@cpu`), and the Playwright projects agree with the `Engines` column. A stretch row may be missing; any other missing row fails. A row whose scenario changes keeps its id; a retired row is recorded in section 9; ids are never reused.

**Changing this document.** A change to a threshold, a budget or a limit is a change to [`src/shared/criteria.ts`](src/shared/criteria.ts) with its basis rewritten, and a re-rendered document; the decision behind a policy change goes into an ADR ([docs/decisions/strategy.md](docs/decisions/strategy.md)). When Phase 7 measures a readiness limit, the entry's basis becomes `measured` and names the artifact it came from.
