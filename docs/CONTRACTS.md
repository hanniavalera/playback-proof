# Contracts

The interfaces between the lab's components. Every component is built against this document and the types in
[`src/shared`](../src/shared), so that the media pipeline, the HTTP service, the player page, the test suites and the
tooling can be built and verified independently. If a contract has to change, change this file and the types in the same commit.

## 1. Components and ownership

| Path                      | Component                                                                    | Phase |
| ------------------------- | ---------------------------------------------------------------------------- | ----- |
| `TEST_STRATEGY.md`        | Strategy, risk ranking, merge vs release tiers, readiness criteria, catalog   | 1     |
| `src/shared/`             | Contract types and pure helpers (URL layout, env id). No runtime deps.        | 0     |
| `tools/codec-matrix.ts`   | Real-decode capability probe and the generated `docs/CODEC_MATRIX.md`         | 1     |
| `src/server/media/`       | ffmpeg stream generation, segment store, tfdt rewriter, DASH/HLS builders     | 2     |
| `src/server/` (rest)      | HTTP service: sessions, fault engine, live clock, request log, static player  | 2     |
| `src/player/`             | The Shaka Player page and `window.__qa`                                       | 2     |
| `src/lab/`                | Library shared by the harnesses: service client, browser launch, measurement  | 0, 5  |
| `tests/e2e/`              | Playwright suites (VOD, ABR, live edge, recovery, EME) and their support code | 3     |
| `tests/live/`             | Live-event readiness specs and the soak test                                  | 7     |
| `tests/unit/`             | Vitest tests of the lab itself                                                | all   |
| `perf/`                   | Repeated-run harness, baselines (JSON per environment), regression gate       | 5     |
| `flake/`                  | Playwright reporter, history, flake rate, quarantine list, gate               | 5     |
| `ab/`                     | A/B runner, statistics, markdown report                                       | 6     |
| `triage/`                 | Failure collection, deterministic clustering, optional LLM summaries          | 8     |
| `.github/`, `Jenkinsfile` | CI: the same gate stages in both systems                                      | 4     |

## 2. Browser and OS matrix (evidence: `docs/CODEC_MATRIX.md`, ADR-001)

| Engine   | Where it runs the playback suites                              | Why                                                                                                                                                           |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium | Linux (CI, Jenkins, Docker) and macOS                          | Plays every format tried.                                                                                                                                     |
| Firefox  | Linux only (CI, Jenkins, Docker)                               | Plays every format tried on Linux. Playwright's Firefox does not start on the macOS development host ("Could not find profile folder"), so locally it runs in Docker. |
| WebKit   | macOS only (local, GitHub `macos` runners)                     | Playwright's Linux WebKit exposes `MediaSource` and answers `isTypeSupported` with `true` for everything, but MSE playback fails (`MediaError 4: Failed to push buffer`, intermittently). The Linux WebKit gap is documented and the specs are skipped there with that reason. |

Never trust `MediaSource.isTypeSupported` alone. The capability probe decodes real media.

## 3. Stream catalog

Authoritative data (durations, hashes) comes from `GET /api/streams`. Targets for the media pipeline:

| Stream id           | Kind | Packaging       | Protocols  | Video (VP9, 30 fps)                    | Audio       | Length / segments |
| ------------------- | ---- | --------------- | ---------- | -------------------------------------- | ----------- | ----------------- |
| `vod-cmaf`          | VOD  | fMP4 (CMAF)     | DASH, HLS  | `v240` 300 kbps, `v360` 700, `v720` 1800 | `a-aac` 64 kbps | 60 s / 30 x 2 s   |
| `vod-cmaf-short`    | VOD  | fMP4 (CMAF)     | DASH, HLS  | same ladder                            | `a-aac`     | 12 s / 6 x 2 s    |
| `vod-webm`          | VOD  | WebM            | DASH       | same ladder                            | `a-opus` 64 kbps | 30 s / 15 x 2 s   |
| `live-cmaf`         | LIVE | fMP4 (CMAF)     | DASH, HLS  | same ladder                            | `a-aac`     | 24 s source looped forever |
| `vod-cmaf-clearkey` | VOD  | fMP4 (CENC)     | DASH       | `v360` only                            | `a-aac`     | 12 s / 6 x 2 s (stretch goal) |

- Rung sizes: `v240` 426x240, `v360` 640x360, `v720` 1280x720. Test patterns come from ffmpeg `testsrc2` and `sine`: no copyrighted media.
- Every rung is GOP-aligned to the 2 s segment duration (keyframe at every segment start), constant-ish bitrate so that throttling arithmetic is predictable.
- Segment numbers are 1-based. VOD segment `k` covers `[(k-1)*d, k*d)`.
- Generation is a pure function of the spec in `src/server/media/specs.ts`; output is content-addressed under `.cache/streams/<specHash>/`
  and generation is idempotent. `StreamInfo.contentHash` identifies the content.
- The player page picks the stream flavour a browser can really decode: see `docs/CODEC_MATRIX.md` and the capability fixture in `tests/e2e/support`.

### URL layout (see `src/shared/urls.ts`, the only place that builds these)

```
/health                                          service status
/player/                                         the player page (?manifest=...&config=A|B&autoplay=1&muted=1&start=..&abr=1)
/api/...                                         control API (section 4)
/s/<session>/<stream>/dash/manifest.mpd          DASH manifest (static for VOD, dynamic for live)
/s/<session>/<stream>/hls/master.m3u8            HLS multivariant playlist
/s/<session>/<stream>/hls/<rep>.m3u8             HLS media playlist of one representation
/s/<session>/<stream>/seg/<rep>/init.<mp4|webm>  initialization segment
/s/<session>/<stream>/seg/<rep>/<n>.<m4s|webm>   media segment n (1-based; for live, the live segment number)
```

All responses carry `Cache-Control: no-store` (the browser cache must never hide a throttle) and `Access-Control-Allow-Origin: *`.
DASH and HLS reference the same segment URLs.

### Manifests

- DASH VOD: static MPD, `SegmentTemplate` with `$Number$`, `startNumber="1"`, `minBufferTime`, `mediaPresentationDuration`.
- DASH live: dynamic MPD, `availabilityStartTime`, `timeShiftBufferDepth`, `minimumUpdatePeriod="PT2S"`, `suggestedPresentationDelay`,
  `publishTime`, `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="/api/time">` (the client clock is not trusted).
- HLS: fMP4 (`#EXT-X-MAP`), `#EXT-X-VERSION:7`, `#EXT-X-INDEPENDENT-SEGMENTS`, audio as a media group. Live: sliding window with
  `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-TARGETDURATION`, `#EXT-X-PROGRAM-DATE-TIME`, no `#EXT-X-ENDLIST`.

### Live simulation

- A live session has a virtual clock: segment `n` (n >= 1) covers `[(n-1)*d, n*d)` of the stream timeline, `t = 0` is `availabilityStartTime`,
  and the segment is published at `t0 + n*d`. At session creation the stream is already `startOffsetSec` (default 30) "on air".
- The source is `segmentCount` pre-encoded segments. Live segment `n` is source segment `((n-1) mod segmentCount) + 1` with the
  `tfdt` (baseMediaDecodeTime) of every fragment rewritten to the live timeline, so the loop never shows up as a timestamp jump
  and the stream can run for as long as a soak test needs. Initialization segments are unchanged.
- Defaults: 2 s segments, `windowSegments` 15 (30 s DVR), `presentationDelaySec` 6.
- `live-stall` and `manifest-stale` faults (section 5) model the two origin failure modes: the origin stops publishing and then catches up
  (timeline continuous), and a CDN/origin serving a stale manifest.

## 4. Test data service API

Base URL `http://127.0.0.1:${PB_PORT}` (default 4600). Types: `src/shared/api.ts`. Client: `src/lab/service-client.ts`.

| Method and path                         | Body / query                      | Response                                                         |
| --------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `GET /health`                           |                                   | `HealthInfo`                                                     |
| `GET /api/streams`                      |                                   | `{ streams: StreamInfo[] }`                                      |
| `GET /api/time`                         |                                   | the current time, ISO 8601 text (DASH `UTCTiming`)               |
| `POST /api/sessions`                    | `SessionRequest`                  | `SessionInfo` (201)                                              |
| `GET /api/sessions/:id`                 |                                   | `SessionDetail`                                                  |
| `POST /api/sessions/:id/faults`         | `{ rules: FaultRule[] }`          | the stored rules with ids (added)                                |
| `PUT /api/sessions/:id/faults`          | `{ rules: FaultRule[] }`          | the stored rules with ids (replaced)                             |
| `DELETE /api/sessions/:id/faults/:rule` |                                   | 204                                                              |
| `GET /api/sessions/:id/log?since=<seq>` |                                   | `RequestLogEntry[]`                                              |
| `DELETE /api/sessions/:id`              |                                   | 204                                                              |

- A session isolates everything: its own live clock, fault rules, token bucket and request log. Tests are therefore independent and can run in parallel.
- Unknown session: 404. Expired sessions (TTL) are garbage collected.
- The request log is the second observation channel for tests: besides asking the player what it did (`window.__qa`) a test can ask the
  server what the player fetched (which segment numbers after a seek, which rung after a throttle, how often a 404 was retried).

## 5. Faults (see `src/shared/faults.ts`)

A fault rule is data: `{ type, match?, times?, afterMs?, forMs?, ...parameters }`. Rules are evaluated per request; `afterMs` and `forMs` are
measured from the session's first media request. Several rules can fire on one request (throttle + latency). `throttle` is a single
token bucket per session shared by concurrent responses (audio and video compete like on a real link). Jitter is drawn from a PRNG seeded
with the session id, so a rerun with the same request order sees the same delays.

## 6. The player page and `window.__qa`

- Page: `/player/` with query `manifest`, `config` (`A` | `B`), `autoplay`, `muted`, `start`, `abr` (`PlayerPageParams`). Muted by default so autoplay is allowed in every engine.
- Hook: `window.__qa` (`QAHook`, `src/shared/qa.ts`). Event timeline with a **cursor**, so waits are race-free; metrics snapshot;
  actions that resolve on the resulting event (`seek` resolves on `seeked`).
- Metric definitions: [METRICS.md](METRICS.md). Configurations A and B: `src/player/configs.ts` (A = Shaka defaults, B = a tuned candidate; both are printed by `qa.info()`).

## 7. Tests: ids, tiers, tags, waiting

- Test ids look like `PB-VOD-001`. The strategy's catalog (`TEST_STRATEGY.md`, between the `BEGIN:TEST_CATALOG` / `END:TEST_CATALOG` markers) is the list of record; a docs check compares it with the specs.
- The id starts the Playwright title: `test('PB-VOD-001 starts and reaches 3 s of media time', { tag: '@merge' }, ...)`.
- Tags: `@merge` (gates every pull request), `@release` (gates a release / nightly), plus `@cpu` (also runs in the CPU-throttled profile), `@live`, `@hls`, `@dash`, `@eme`, `@soak`.
- **No fixed sleeps.** Specs wait on player events (`qa.waitFor`, `qa.waitForMediaTime`, cursor-based) or on the server request log. ESLint forbids
  `waitForTimeout` and `setTimeout` in specs.
- A spec that cannot run in an environment because of a documented gap (for example WebKit on Linux) is skipped by the shared fixture
  with the reason from `docs/CODEC_MATRIX.md`; a silent skip is a bug.

## 8. Environments, ports, variables

- `PB_PORT` (default 4600): service port. Parallel work uses disjoint ranges: media 4620-4629, server 4630-4639, player 4640-4649, e2e agents 4650-4699, perf and A/B 4700-4729, live 4730-4749, triage 4750-4759.
- `PB_ENV_ID`: explicit environment id; otherwise `detectEnvId()` (`src/shared/env.ts`): `local-darwin-arm64`, `docker-linux-arm64`, `gha-linux-x64`, `gha-macos-arm64`, `jenkins-linux-arm64`...
  Baselines are keyed by it and never compared across environments.
- `PB_ORIGIN`: service origin for the client (default `http://127.0.0.1:${PB_PORT}`).
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`: optional, triage summaries only. Everything works without them.

## 9. Commands (names are fixed; implementations arrive with their phase)

`npm run typecheck | lint | format:check | docs:check | build:player | generate:streams | serve | codec-matrix | docker:pw | test:unit | test:e2e | test:merge | test:release | perf | perf:gate | perf:baseline | flake:report | flake:gate | ab | readiness | soak | triage`
(`docker:pw -- <command>` runs a command inside the Playwright Linux image that matches the pinned `@playwright/test`, with the repository mounted: this is how Firefox runs on a macOS host and how the Linux CI environment is reproduced locally.)
and the CI gate stages `gate:static | gate:unit | gate:merge | gate:perf | gate:flake | gate:triage`, which both GitHub Actions and the Jenkinsfile call.

## 10. Rules of engagement for contributors (including the agents that build this)

- Only the orchestrator pushes, opens pull requests, merges, and installs dependencies. Do not edit `package.json`/`package-lock.json`; ask for the dependency you need.
- Commit as `hanniavalera <hannia.cpp@gmail.com>`, no co-author or tool trailers.
- Heavy jobs run one at a time on the shared machine; do not run performance, A/B or soak measurements unless your brief says so.
- Never fake a metric: every number in a document comes from a real run and carries the environment, date and commit it was measured on.
- Create and edit files with the editor tools, not with shell redirection.
