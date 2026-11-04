# Contracts

The interfaces between the lab's components. Every component is built against this document and the types in
[`src/shared`](../src/shared), so that the media pipeline, the HTTP service, the player page, the test suites and the
tooling can be built and verified independently. If a contract has to change, change this file and the types in the same commit.

## 1. Components and ownership

| Path                      | Component                                                                    | Phase |
| ------------------------- | ---------------------------------------------------------------------------- | ----- |
| `TEST_STRATEGY.md`        | Strategy, risk ranking, merge vs release tiers, readiness criteria, catalog   | 1     |
| `src/shared/`             | Contract types and pure helpers (URL layout, env id). No runtime deps.        | 0     |
| `tools/codec-matrix.ts`   | Real-decode capability probe (CLI) and the generated [CODEC_MATRIX.md](CODEC_MATRIX.md) | 1     |
| `src/lab/probe/`          | Capability probe library: formats, probe media, in-page probe, runner, `pickStream` | 1     |
| `tools/docker/pw.sh`      | Runs a command in the Playwright Linux image that matches the pinned version  | 1     |
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

## 2. Browser and OS matrix (evidence: [CODEC_MATRIX.md](CODEC_MATRIX.md), ADR-001)

| Engine   | Where it runs the playback suites                              | Why                                                                                                                                                           |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium | Linux (CI, Jenkins, Docker) and macOS                          | Plays every format tried.                                                                                                                                     |
| Firefox  | Linux only (CI, Jenkins, Docker)                               | Plays every format tried on Linux. Playwright's Firefox does not start on the macOS development host ("Could not find profile folder"), so locally it runs in Docker. |
| WebKit   | macOS (local, GitHub `macos` runners); Linux (Docker, CI) as an **experimental**, flake-tracked engine | Playwright's Linux WebKit exposes `MediaSource` and answers `isTypeSupported` with `true` for everything, and the codec probe's page (muted element, segments fetched after the SourceBuffers exist) plays only some attempts there (`MediaError 4: Failed to push buffer`, intermittently: see the sensitivity table in [CODEC_MATRIX.md](CODEC_MATRIX.md) and ADR-031 to ADR-033 in [decisions/codecs.md](decisions/codecs.md)). The real player page, which adds every SourceBuffer before it fetches, passed 80 of 80 runs, each in a fresh browser process, in the Playwright image (`vod-dash` and `vod-hls`, muted and unmuted, and `live-dash`: `docs/results/player-smoke/experiments/`, ADR-067 in [decisions/player.md](decisions/player.md)). So the e2e suites run in Linux WebKit, and the one switch is `RUN_SPECS_IN_LINUX_WEBKIT` in `tests/e2e/support/gaps.ts` (section 7.3); every test of that engine carries the `experimental-engine` annotation, so that a failure there is tracked as a flake of the experiment. WebM, live over HLS and long sessions were not part of the experiment. |

Never trust `MediaSource.isTypeSupported` alone. The capability probe decodes real media.

## 3. Stream catalog

Authoritative data (durations, hashes) comes from `GET /api/streams`. Targets for the media pipeline:

| Stream id           | Kind | Packaging       | Protocols  | Video (VP9, 30 fps)                    | Audio       | Length / segments |
| ------------------- | ---- | --------------- | ---------- | -------------------------------------- | ----------- | ----------------- |
| `vod-cmaf`          | VOD  | fMP4 (CMAF)     | DASH, HLS  | `v240` 300 kbps, `v360` 700, `v720` 1800 | `a-aac` 64 kbps | 60 s / 30 x 2 s   |
| `vod-cmaf-short`    | VOD  | fMP4 (CMAF)     | DASH, HLS  | same ladder                            | `a-aac`     | 12 s / 6 x 2 s    |
| `vod-webm`          | VOD  | WebM            | DASH       | same ladder                            | `a-opus` 64 kbps | 30 s / 15 x 2 s   |
| `live-cmaf`         | LIVE | fMP4 (CMAF)     | DASH, HLS  | same ladder                            | `a-aac`     | 24 s source looped forever |
| `vod-cmaf-clearkey` | VOD  | fMP4 (CENC `cenc`) | DASH    | `v360` only                            | `a-aac`     | 12 s / 6 x 2 s    |

- Rung sizes: `v240` 426x240, `v360` 640x360, `v720` 1280x720. Test patterns come from ffmpeg `testsrc2` (moving shapes, a timestamp and a frame counter) and `aevalsrc` (a two-beep tone whose pitch climbs one semitone per segment, silent at the start and end): no copyrighted media.
- Every rung is GOP-aligned to the 2 s segment duration (keyframe at every segment start), constant-ish bitrate so that throttling arithmetic is predictable. The bitrates in the table are encoder targets; manifests declare the **measured peak** of any one segment (the audio, a sparse tone, peaks far below its 64 kbps target).
- Segment numbers are 1-based. VOD segment `k` covers `[(k-1)*d, k*d)`.
- Generation is a pure function of the spec in `src/server/media/specs.ts`; output is content-addressed under `.cache/streams/<specHash>/<streamId>/`
  and generation is idempotent. `StreamInfo.contentHash` identifies the content.
- `vod-cmaf-clearkey` is encrypted with CENC AES-CTR (`cenc`, whole samples) under a **public, throw-away** key pair that protects nothing; `StreamInfo.drm` carries it (`keyId` and `key`, 32 hex digits each) so that a test can hand it to the player (`clearKeys`). Its DASH manifest has, in both AdaptationSets, `ContentProtection` for `urn:mpeg:dash:mp4protection:2011` (`value="cenc"`, `cenc:default_KID` in UUID form) and for the ClearKey system id `urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e`; the key is never in the manifest. The init segments carry `encv`/`enca` entries with `sinf` (`tenc` = the key id, 8-byte per-sample IVs) and every fragment has `senc`/`saiz`/`saio`. The plaintext of the stream is exactly what an unencrypted stream of the same spec holds (ADR-049). It is DASH only: the HLS builders refuse an encrypted stream.
- The player page picks the stream flavour a browser can really decode: see [CODEC_MATRIX.md](CODEC_MATRIX.md) and the capability fixture in `tests/e2e/support`.

### Media files and the stream index (what the media pipeline guarantees; ADR-040..049 in [decisions/media.md](decisions/media.md))

- **Files.** `<rep>/init.mp4|webm` and `<rep>/<n>.m4s|webm` (n 1-based), plus `stream.json` (a `StreamIndex` from `src/server/media/types.ts`, the sha256 of every file, the spec hash, the ffmpeg version, the generation time). A stream directory is created by renaming a complete temporary directory, so it is never half written.
- **fMP4 segments** are `styp` + one `moof` (`mfhd`, one `traf` with `tfhd`, `tfdt` version 1, `trun` with per-sample duration/size/flags; for the encrypted stream also `senc`, `saio`, `saiz`) + one `mdat`. No `sidx`. The init segment has no edit list: the media timeline is the presentation timeline. **WebM segments** are exactly one Cluster; the init segment is EBML header + Segment + Info + Tracks. A media segment is decodable only together with its init segment.
- **Real timing.** `SourceSegment.start` is the first sample's decode time and `duration` the sum of the sample durations, both parsed from the file. Video segments are exactly 2 s. AAC segments hold 94, 94, 94, 93 frames (48 kHz, 1024 samples per frame: 93.75 frames per 2 s), cut by cumulative rounding: a segment starts at the first frame whose start time is >= `(k-1) * 2 s` (ADR-042). Opus in WebM is exactly 100 frames per segment.
- **Lengths.** `StreamInfo.durationSec` is the video duration. Audio holds whole frames only and never runs past the video: a VOD audio track ends up to one frame (21.3 ms) before it. For `live-cmaf` the loop is a whole number of AAC frames (1125 frames = 24 s), so `loopTicks / timescale` is the same for audio and video **to the tick**; `checkStreamIndex` (`src/server/media/invariants.ts`) enforces all of this, at generation, at load and in `npm run verify:streams`.
- **Codecs and bandwidth come from the files.** `RepInfo.codecs` is parsed from `vpcC` (and checked against the key frame header and the level the picture size needs), `esds` or the WebM track; `bandwidth` is the peak of `bytes x 8 / real duration` over the segments, rounded up. `RepInfo.channels` and `sampleRate` (audio, optional) were added for `AudioChannelConfiguration` and HLS `CHANNELS`.
- **Commands.** `npm run generate:streams -- [--streams a,b] [--force] [--verify] [--threads n]` is idempotent (a complete cache is a no-op, a damaged one is regenerated); `npm run verify:streams` checks the generated streams against ffprobe/ffmpeg (a real demuxer and decoder), not against this repository's own parser.

### URL layout (see `src/shared/urls.ts`, the only place that builds these)

```
/health                                          service status
/player/                                         the player page (?manifest=...&config=A|B&autoplay=1&muted=1&start=..&abr=1&hud=0)
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

Built by the media pipeline (`MediaStore.dashVod | dashLive | hlsMaster | hlsMediaVod | hlsMediaLive`, interface in
[`src/server/media/types.ts`](../src/server/media/types.ts)) from the **real** timing of the generated files.

- Every URL inside a manifest is **relative to the manifest's own URL** (`../seg/v240/$Number$.m4s`, `../seg/v240/init.mp4`): the layout works
  behind any prefix and manifests need no session id.
- Segment timing is the real timing (`SourceSegment.start` / `duration`), never the nominal 2 s. DASH uses `SegmentTemplate` with `$Number$`
  addressing **and** a `SegmentTimeline` (`startNumber` = first listed segment number, `t` = its real start in ticks, `r` for repeats); HLS uses
  `EXTINF` from the real durations. Why: AAC frames are 1024 samples, so 2 s of 48 kHz audio is 93.75 frames and audio segments hold 93 or 94
  frames. A manifest that claims uniform 2.000 s audio segments is wrong by up to one frame per segment, and players stall or skip.
- DASH VOD: static MPD, `minBufferTime`, `mediaPresentationDuration`.
- DASH live: dynamic MPD, `availabilityStartTime`, `timeShiftBufferDepth`, `minimumUpdatePeriod="PT2S"`, `suggestedPresentationDelay`,
  `publishTime`, `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="/api/time">` (the client clock is not trusted).
- DASH `profiles` is `urn:mpeg:dash:profile:isoff-live:2011` for the fMP4 streams; the WebM stream says `urn:mpeg:dash:profile:full:2011`, because the ISO BMFF live profile promises ISO BMFF segments.
- HLS: fMP4 (`#EXT-X-MAP`), `#EXT-X-VERSION:7`, `#EXT-X-INDEPENDENT-SEGMENTS`, audio as a media group. Live: sliding window with
  `#EXT-X-MEDIA-SEQUENCE` (= the first listed segment number), `#EXT-X-TARGETDURATION`, `#EXT-X-PROGRAM-DATE-TIME` (on every segment), no `#EXT-X-ENDLIST`.
  `#EXT-X-TARGETDURATION` is `ceil(max EXTINF)` over the whole source loop, not the window (it must not change while a playlist slides): 2 for video, 3 for AAC (94 frames = 2.0053 s).
- HLS media playlists are requested as `/hls/<rep>.m3u8`. In the request log and for fault matching they are `kind: 'manifest'` with `rep` set.

### Live simulation

Let `d` = `segmentDurationSec` (2 s) and `AST` = `availabilityStartTime`.

- A live session has a virtual clock. At creation the stream has been "on air" `startOffsetSec` (default 30) seconds: `AST = createdAt - startOffsetSec`.
  Live segment `n` (n >= 1) covers `[(n-1)*d, n*d)` of the stream timeline and is published at `AST + n*d`. The published edge at wall-clock `t` is
  `edge(t) = floor((t - AST) / d)` (15 at creation with the defaults).
- The source is `segmentCount` pre-encoded segments, looped. Live segment `n` is source segment `k = ((n-1) mod segmentCount) + 1` with loop index
  `L = floor((n-1) / segmentCount)`. The decode time (`tfdt`) of every fragment is moved by `L * loopTicks` of **its own track**, so each live
  representation has a monotonic timeline across the loop, the loop never shows up as a timestamp jump, and a soak test can run as long as it
  needs. Initialization segments are unchanged. Invariant: `loopTicks / timescale` is the same for all tracks of the stream, so audio and video
  cannot drift apart over many loops.
- Manifest window at edge `e`: `lastNumber = e`, `firstNumber = max(1, e - windowSegments + 1)`. Segment availability: `n > e` is 404 (not yet
  published), `n < firstNumber - 2` is 404 (gone), otherwise 200.
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
- Everything under `/s/<session>/` is logged (`RequestLogEntry`); `/api` and `/health` are not. The log of a session keeps its last 5000 entries.
  "Everything" means every request of a session that exists, whatever the answer: a segment that does not exist, a method that is not allowed and a
  path under the session that the service does not know (`kind: 'other'`) are entries too, with their 404 or 405. A request for a session that does not
  exist (or has expired) is a 404 that no log can hold. The `path` of an entry has no query string.
  An entry is listed **from the request's arrival** with `pending: true` and the values so far (status 0 until the response head is sent), and is
  completed in place. `seq` is assigned at arrival, so the list is always in `seq` order and a cursor (`?since=<last seq seen>`) cannot skip a request that
  completes late; it also lets a test wait on the server ("a request for segment 7 has started") without sleeping.
- A media request is decided in this order ([ADR-082](decisions/server.md)): the session must exist (404); the request is listed; the stream and the protocol of
  the path must be the session's stream and one it offers, and the URL must be the one URL of the resource (404 otherwise: an extension that is not the
  representation's, a segment number with a leading zero, an unknown representation, a method other than `GET` and `HEAD` is a 405); the fault plan is
  decided from the request alone; what exists is decided at the instant of **arrival** (the live window, a segment that is not published yet is a 404);
  then the answer is written with the plan applied, so a latency fault delays a decision that was already made, also a 404. A `status` fault answers with
  that status and an empty body whatever the path (a segment that does not exist included: the origin is failing), and the faults that need a body
  (throttle, stall, abort) do not apply to it. `Range` is ignored: the whole body is sent with a 200. Content types: `.mpd` `application/dash+xml`,
  `.m3u8` `application/vnd.apple.mpegurl`, the `mimeType` of the representation for init and media segments.
- Errors of the control API are JSON `{ error: string, details?: string[] }`: 400 (a body that is not valid, malformed JSON, a bad `since`), 404 (unknown
  session, rule, path; a stream that is valid but was not generated), 405 with an `Allow` header, 413 (a body over 64 KiB: answered at once, the service
  never buffers more than the limit), 503 (500 live sessions). `POST /api/sessions` answers 201 with a `Location` header. `GET /` is a plain-text index.
- `GET /player/*` serves the built player (`dist/player`, produced by `npm run build:player`); `HealthInfo.player` says whether it exists.
  Static serving cannot leave that directory (path traversal is rejected, not sanitised). `HEAD` and `OPTIONS` (CORS preflight) work on every path.
- Programmatic entry: `startServer(options)` in `src/server/index.ts` returns `{ origin, port, close() }` and is what the harnesses and tests use;
  `tools/serve.ts` (`npm run serve`) is the CLI: it reads `PB_PORT` (default 4600) and `PB_HOST` (default `127.0.0.1`), fails fast with a clear message
  when a stream is missing (`npm run generate:streams` creates it: idempotent, content-addressed), prints one line (`playback-proof service listening on <origin>`)
  when it is ready, and closes cleanly on SIGINT/SIGTERM (exit code 0). `npm run smoke:service` runs the CLI against the real streams and checks what it serves.

## 5. Faults (see `src/shared/faults.ts`)

A fault rule is data: `{ type, match?, times?, afterMs?, forMs?, ...parameters }`. Rules are evaluated per request; `afterMs` and `forMs` are
measured from the session's first media request. Several rules can fire on one request (throttle + latency). `throttle` is a single
token bucket per session shared by concurrent responses (audio and video compete like on a real link). Jitter is drawn from a PRNG seeded
with the session id, so a rerun with the same request order sees the same delays.

Exact semantics (the service implements them as written and its tests pin them):

- **Rule clock.** `afterMs` and `forMs` count from the session's first *media* request (an init or a segment; manifests do not start the clock).
  A rule is active in `[origin + afterMs, origin + afterMs + forMs)`. Until the first media request exists, a rule with `afterMs = 0` is active
  and a rule with `afterMs > 0` is not. `times` counts the matching requests while the rule is active.
- **Matching.** Every field present in `match` must match, an absent field matches anything. Manifests (DASH MPD, HLS master and media playlists)
  have kind `manifest`; `media` means init + segment. Default `kind`: `media` for throttle, latency, stall and abort; `status` requires it.
- **throttle** limits the response *body* (headers excluded). One token bucket per rule and session, shared by all the concurrent responses the rule
  matches; a response matched by several throttle rules is limited by all of them (so by the slowest). Burst allowance: at most one chunk (16 KB)
  of credit is banked while no response is asking. Time that accrues while a response is waiting for its turn is owed to it and kept, so a stalled
  event loop is paid back at once and cannot lower the long-run rate ([ADR-052](decisions/server-delivery.md)).
  Contract: measured goodput within +-10 % of `kbps` for transfers of at least 500 KB.
- **latency** delays the first byte by `max(0, ms + u * jitterMs)`, where `u` is uniform in [-1, 1) and drawn by a PRNG seeded with (session id, request `seq`,
  rule id): the same session id and request order give the same delays, and the delay is a pure function that a test can assert without measuring time.
  Several latency rules that fire on one request add up.
- **status** answers with that status and an empty body (latency still applies; throttle, stall and abort have no body to act on). **stall** sends `afterBytes`, pauses `ms`, finishes.
  **abort** sends `afterBytes` (default 0), then destroys the socket. When several `status` (or `stall`, or `abort`) rules fire on one request, the first in rule order wins.
- **live-stall** (`atNumber`, `ms`) is timed by the live clock: `afterMs` and `forMs` are rejected. It starts at `S = max(AST + atNumber*d, installTime)`
  (the publication instant of segment `atNumber`, or now when installed late) and freezes the edge at `edge(S)` until `S + ms`: manifests keep
  listing the frozen window with the frozen `publishTime`, segments above the frozen edge are 404. At `S + ms` the origin catches up: the edge jumps
  to `edge(now)` and the timeline is unchanged (no discontinuity). A segment that was published is never unpublished.
- **manifest-stale** (`ms`) is active in `[origin + afterMs, origin + afterMs + ms)` (`forMs` is rejected). While active, every manifest and playlist
  request is answered with the last body served before the rule became active. Segments are not affected. The replayed body is kept per
  (session, manifest URL), recorded at serve time. A URL that had not been served before the rule became active has nothing to replay: its
  current body is served and becomes the body replayed for the rest of the window.
- **Validation.** Invalid rules are rejected with 400 and a list of the problems: unknown `type`, non-finite or negative numbers, `kbps <= 0`,
  `status` outside 200-599 (1xx are interim responses: a client answered 101 or 199 would wait for a final one that never comes), a `live-stall` or `manifest-stale` rule on a VOD session, `status` without `match.kind`, a malformed `match`, a `times` that is not a
  positive integer, a duplicate rule id. `live-stall` and `manifest-stale` need `ms > 0`; `live-stall` takes no `match`, `times`, `afterMs` or `forMs`;
  `manifest-stale` takes no `forMs` or `times`, and its `match.kind`, if present, is `manifest` or `any`.

## 6. The player page and `window.__qa`

- Page: `/player/` with query `manifest`, `config` (`A` | `B`), `autoplay`, `muted`, `start`, `abr`, `hud` (`PlayerPageParams`). Muted by default so autoplay is allowed in every engine. `autoplay` applies to the page's own load (the `manifest` parameter); a load started with `qa.load()` never plays by itself. `hud=1` shows a small overlay (default off: the page under test carries no extra work). A parameter the page cannot use (`muted=maybe`, `start=-3`) is ignored and recorded as an `error` event with code 0, so a typo in a test fails loudly instead of silently changing what is measured.
- Hook: `window.__qa` (`QAHook`, `src/shared/qa.ts`) exists synchronously when the script runs; `qa.ready` resolves when Shaka is built, configured and attached. Event timeline with a **cursor**, so waits are race-free; metrics snapshot;
  actions that resolve on the resulting event (`seek` resolves on the `seeked` that follows its own `seeking`, `selectVariantByHeight` on its `variant-changed`). A wait that times out rejects with the last 15 events in its message. `waitFor(name, { since, timeoutMs, detail })`: a Playwright spec cannot pass a predicate into the page (a function does not cross the boundary and the page's CSP forbids `eval`), so `detail` is the declarative filter: every key must equal the event's `detail` value (`{ reason: 'abr', height: 720 }`; strings, numbers, booleans and null only). `predicate` stays for callers that run in the page. `qa.info()` reports the configuration letter, the exact override object and what Shaka's defaults held at those keys, every `qa.configure()` call, the page parameters as applied, and `loadMode` (`'media-source'` or `'src='`: the lab plays everything through MSE and its smoke asserts it).
- Errors: every failure is an `error` event (`QAError`): Shaka errors with their code name and a digest of their data, a rejected `load()` or `play()`, a silent MediaSource recovery, unusable page parameters, unhandled exceptions and rejections of the page itself (code 0). Critical (severity 2) puts `state` in `error`. Nothing crashes the page.
- Metric definitions: [METRICS.md](METRICS.md) (the seek window and the live latency are specified there in detail). Configurations A and B: `src/player/configs.ts` (A = Shaka defaults, B = three falsifiable overrides; both are printed by `qa.info()`). Decisions: [decisions/player.md](decisions/player.md).
- Build and smoke: `npm run build:player` writes `dist/player` (Shaka's compiled build copied verbatim as `shaka.js`, the lab's code as `player.js`, `index.html`, `player.css`); `npm run player:smoke` plays real sessions through the hook in the installed browsers.

## 7. Tests: ids, tiers, tags, waiting

- Test ids look like `PB-VOD-001`. The strategy's catalog (`TEST_STRATEGY.md`, between the `BEGIN:TEST_CATALOG` / `END:TEST_CATALOG` markers) is the list of record; a docs check compares it with the specs.
- The catalog's columns are `ID | Area | Scenario | Risk | Tier | Engines | Runs in | A failure means`, parsed strictly by `tools/catalog.ts` (`parseCatalog`). `Risk` is `LxI=score`; `Tier` is `merge` or `release` and follows from the risk score and the `Runs in` lane (unit rows always `merge`, `live` and `ab` rows always `release`: TEST_STRATEGY.md section 4.2); `Engines` is a comma-separated list of `chromium`, `firefox`, `webkit`, `chromium-cpu4x`, or `all` (the first three), and `none` for `unit` rows, which use no browser. A scenario marked `(stretch)` may be unimplemented.
- Tag mapping: tier `merge` is `@merge`, tier `release` is `@release`, an `Engines` list that includes `chromium-cpu4x` is `@cpu`.
- Policy numbers (readiness limits, gate budgets, flake policy, tiering thresholds) live in `src/shared/criteria.ts`, the named fault profiles in `src/shared/profiles.ts` (`profile(name)`, `originStall(atNumber, ms)`, `staleManifest(ms)`); `TEST_STRATEGY.md` renders its tables from them and `npm run docs:check` fails when they are stale. Code that enforces a limit imports the plain numbers (`LIVE_LIMITS`, `GATE_LIMITS`, `FLAKE_LIMITS`, `RISK_LIMITS`).
- The id starts the Playwright title: `test('PB-VOD-001 starts and reaches 3 s of media time', { tag: '@merge' }, ...)`.
- Tags: `@merge` (gates every pull request), `@release` (gates a release / nightly), plus `@cpu` (also runs in the CPU-throttled profile), `@live`, `@hls`, `@dash`, `@eme`, `@soak`.
- **No fixed sleeps.** Specs wait on player events (`qa.waitFor`, `qa.waitForMediaTime`, cursor-based) or on the server request log (`waitForRequest`).
  ESLint forbids `waitForTimeout`, `setTimeout`, `Atomics.wait` and any frame loop (`requestAnimationFrame`) in everything under `tests/e2e` and `tests/live`. The one polling primitive of the lab is
  `ServiceClient.waitForLog` in `src/lab/service-client.ts` (25 ms by default): lab code, never a spec. The one "let time pass" primitive, for negative observations only, is `observeFrames(n)` of the player handle (section 7.1).
- A spec that cannot run in an environment because of a documented gap (for example WebKit on Linux) is skipped by the shared fixture
  with the reason from [CODEC_MATRIX.md](CODEC_MATRIX.md) (the text `explainNoStream` in `src/lab/probe/capabilities.ts` builds); a silent skip is a bug. The rules are in 7.3.
- `npm run specs:check` compares the specs with the catalog (`tools/check-specs.ts`, [ADR-075](decisions/e2e.md)): every spec id is in the catalog, once, with the tags of its row; `--complete` also requires a spec for every row of lane `e2e` (stretch rows excepted). Rules a spec must follow so that it can be read: the title is a plain string that starts with the id, the `tag` option is a literal, one id is one `test()` call, `test` is imported from `tests/e2e/support/fixtures.ts` and not from `@playwright/test`, and there is no `test.only`.

### 7.1 The support library (`tests/e2e/support`; decisions: [decisions/e2e.md](decisions/e2e.md), ADR-070 to ADR-079)

A spec starts with `import { expect, test } from './support/fixtures.ts'`. The plain Playwright `test` has none of what follows.

| Fixture | Scope | What it gives |
| --- | --- | --- |
| `service` | worker | A `ServiceClient` on the project's `baseURL`: `createSession`, `detail`, `addFaults`, `setFaults`, `removeFault`, `log`, `streams`, `waitForLog`. |
| `environment` | worker | The `Environment` of `gaps.ts`: environment id, engine, platform, and what the committed codec matrix says about this engine here (`capabilities`; null when nothing is documented), with the `basis` of that. |
| `newSession(request)` | test | Creates a session from a `SessionRequest` (the `label` defaults to the test title; `protocol` defaults to `dash`, pass it for HLS) and **deletes it after the test, also when the test failed**. Returns a `TestSession`: every field of `SessionInfo` plus `service`. Skips the test (documented gap) when the stream is made of a flavour this engine does not play. |
| `streamFor(kind, protocol)` | test | The `StreamId` to play for `'vod'` or `'live'` over `'dash'` or `'hls'` in this engine: the first of `vod-cmaf`, `vod-webm` (DASH only) or `live-cmaf` whose flavour decoded in every attempt of the probe. Skips the test with the documented reason when none does. Without committed evidence for the environment: `vod-cmaf` or `live-cmaf`. A spec that needs one particular stream (`vod-cmaf-short`, `vod-webm`, `vod-cmaf-clearkey`) names it in `newSession`. |
| `player(session?, page?)` | test | A `PlayerHandle` on the test's `page` (or on `page`) for the session. Nothing is navigated until `open()`. |
| `documentedGap` | auto | Skips every test of an engine that plays nothing here according to the committed evidence (Firefox on the macOS host; Linux WebKit only when `RUN_SPECS_IN_LINUX_WEBKIT` is `false`), before the body and before any browser is launched. Adds the `experimental-engine` annotation to every test of Linux WebKit while that constant is `true`. |
| `cpuThrottle` | auto | When the project's `metadata.cpuThrottleRate` is set (`chromium-cpu4x`), sends `Emulation.setCPUThrottlingRate` for the test's `page` before it navigates. Chromium only: any other engine with a rate is an error. |
| `diagnostics` | auto | When the test fails or times out, attaches the documents of 7.2. |

**`PlayerHandle`** (`player.ts`), a typed wrapper over `window.__qa`; every wait has an explicit timeout (`DEFAULT_WAIT_MS` = 15 s, below the 45 s of a test), and a failed wait rejects with the hook's message (the recent timeline) and the library's frames removed from its stack:

| Member | |
| --- | --- |
| `open(params?)` | Navigates to `playerUrl({ manifest: <the session's>, ...params })` (`PlayerPageParams`: `autoplay`, `muted`, `config`, `start`, `abr`, `hud`) and resolves when the player is booted (`qa.ready`). Rejects on a parameter the page could not use (`paramProblems`), a boot failure or an unsupported browser. Does not wait for the load. Returns the handle. |
| `cursor()`, `events(since?)` | The index the next event will get; the timeline from an index on. |
| `metrics()`, `info()` | `QAMetrics` ([METRICS.md](METRICS.md)) and `QAInfo`. |
| `waitFor(name, { since?, timeoutMs?, detail? })` | The first event `name` at or after `since` (default 0: the whole history) whose `detail` has every key of the filter strictly equal (`{ reason: 'abr', height: 720 }`). |
| `waitForMediaTime(seconds, { timeoutMs? })` | Resolves with the media time reached once `currentTime >= seconds`. |
| `load(uri?)`, `play()`, `pause()`, `seek(s)`, `seekToLiveEdge()`, `unload()` | The actions of the hook; each resolves on its own proof (`seek` on the `seeked` that follows its `seeking`). |
| `selectVariantByHeight(h \| null)`, `setAbr(on)`, `configure(partial)` | Pin a rung (ABR off) or release it; Shaka configuration (a rejected key throws). |
| `measureFrames(mediaSeconds, { stallTimeoutMs? })` | Frames presented and dropped while the media clock advances. |
| `observeFrames(n, { timeoutMs? })` | Resolves after `n` animation frames of the page (`requestAnimationFrame`, 1 to 600). **The only "let time pass" primitive**, for NEGATIVE observations (a paused player must not advance the media clock; no event must happen in the window): the window is measured by the page's frame clock (about 16.7 ms a frame at 60 Hz, slower on a slow runner or under the CPU throttle), not by a timer, and the wait is bounded by that clock (it rejects when the page does not paint within `timeoutMs`). A spec still prefers waiting on a positive event, and gives a negative observation its positive control (the same window with the player playing moves the clock). ESLint forbids any other frame loop in a spec. |
| `consoleEntries()`, `page`, `session` | What the browser console said; the page for what the hook does not cover; the session the handle plays. |

**On the server's side** (`waiting.ts`, `session.ts`): `waitForRequest(session, predicate, { since?, timeoutMs? })` and `waitForRequests(session, predicate, { count, since?, timeoutMs? })` wait on the request log (a request that has started counts; add `!entry.pending` for its answer); `requestLogCursor(session)` is the `since` for "from now on"; `requestsFor(log, { kind, rep, number, status, method, pending })`, `segmentNumbersFetched(log, rep, { status? })` (in arrival order, repeats kept), `rungsFetched(log, { track? })` (video rungs in the order of their first segment) and `describeEntry(entry)` read a `RequestLogEntry[]`; `streamInfoOf(session)` is the catalog entry of the session's stream (durations, segment count, DRM test key: never hard-code them).

**Assertions** (`assertions.ts`; each names the metric and the value): `expectHealthyPlayback(metrics)` (no critical error, state not `error`, startup defined, frames decoded), `expectNoErrors(metrics)` (no error of any severity), `expectNoRebuffer(metrics)`, `expectAtMostRebuffers(metrics, n)`, and `playFor(player, mediaSeconds, { timeoutMs? })`, which lets the player play that much media from where it is (resuming a paused element) and waits on the media clock.

### 7.2 Failure diagnostics: the attachments (a contract)

When a test ends with a status other than the expected one (failed, timed out, interrupted) the `diagnostics` fixture attaches these to its result as `application/json` (indented), under these names. Failure triage (Phase 8) reads exactly them. The first player and the first session of a test have the plain names; a second one has `-2` before `.json` (`qa-events-2.json`, `request-log-2.json`), a third `-3`.

| Attachment | Content | Read from |
| --- | --- | --- |
| `qa-events.json` | `QAEvent[]`: the whole timeline of the player page | `qa.events()` |
| `qa-metrics.json` | `QAMetrics` at the moment of the failure | `qa.metrics()` |
| `qa-info.json` | `QAInfo`: configuration letter, the exact overrides, `loadMode`, page parameters as applied, user agent | `qa.info()` |
| `page-console.json` | `ConsoleEntry[]` (`{ type: 'error' \| 'warning' \| 'pageerror', text, location? }`): what the browser console said, the last 200 | the page's `console` and `pageerror` events |
| `session-detail.json` | `SessionDetail`: the session, its fault rules (with their ids) and counters | `GET /api/sessions/:id` |
| `request-log.json` | `RequestLogEntry[]`: every request the server saw for the session | `GET /api/sessions/:id/log` |
| `diagnostics-problems.json` | `{ [attachment name]: reason }`: what could not be read (a closed page, a deleted session, a read that did not answer within 5 s). Present only then. | |

A test with no player attaches no `qa-*` documents; one with no session attaches no server documents. Playwright's own attachments (`screenshot`, `error-context`, `trace`, kept on failure) come with them. The annotations of a result carry the other facts: `skip` (the reason of a documented gap), `environment` and `evidence-drift` (PB-ENV-001), `cleanup` (a session that could not be deleted).

### 7.3 Documented gaps: when a spec is skipped

- The evidence is the **committed** result of the probe for the environment the suite runs in: `docs/results/codec-matrix/<detectEnvId()>.json` (rendered in [CODEC_MATRIX.md](CODEC_MATRIX.md)), read with `capabilitiesFromEngine` and `pickStream`. A flavour counts as playing only when it decoded in every attempt.
- An **engine gap** (nothing plays: Firefox on the macOS host, where the browser does not start; Linux WebKit only while the override below is `false`) skips every test of the engine in `documentedGap`. A **stream gap** (one flavour does not play) skips the test that needs that stream, in `newSession` and `streamFor`. The reason starts with `documented gap in <environment id>:`, names the flavours with their `passes/attempts`, the failing stage and the error, and points at CODEC_MATRIX.md; it is the `skip` annotation of the result.
- **No committed result for the environment (a new CI runner), or none for the engine: nothing is documented, so nothing is skipped.** The specs run, and PB-ENV-001 fails loudly (the engine, its version, what the player said, what the matrix claimed or that it has nothing, and the command that documents the gap) if the engine cannot play. A browser that does not start where the matrix does not record it fails with the browser's own error.
- The one override: `RUN_SPECS_IN_LINUX_WEBKIT` in `tests/e2e/support/gaps.ts`, **`true` as committed**. `true` runs the specs in Linux WebKit whatever the committed matrix says (the codec probe's page is intermittent there, the real player page passed 80 of 80 fresh-process runs: the evidence is quoted in the comment of the constant, section 2 and ADR-072 in [decisions/e2e.md](decisions/e2e.md)), as an **experimental** engine: each of its tests carries the `experimental-engine` annotation, and a failure is tracked as a flake of the engine, not read as a change of the environment. `false` returns Linux WebKit to the evidence (`docker-linux-arm64` and `gha-linux-x64` document it as a gap). The committed matrix decides every other gap: re-probing and committing the result changes them.

### 7.4 Writing a spec

```ts
import { profile } from '../../src/shared/profiles.ts';
import { expectHealthyPlayback } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';

test(
  'PB-VOD-001 DASH VOD starts: first frame presented, 3 s of media time reached, no error',
  { tag: ['@merge', '@cpu', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: profile('clean') });
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(3);
    expectHealthyPlayback(await qa.metrics());
  },
);
```

- Take a cursor before an action and wait for events after it: `const since = await qa.cursor(); await qa.seek(30); await qa.waitFor('seeked', { since })`. The default `since` of 0 searches the whole history, so an old event can answer a later wait. With `autoplay: false` the first frame may already be presented at load (Firefox paints the first frame of a paused video, Chromium does not): wait for `firstframe` from the start, not from a cursor taken after `loaded`.
- A wait that is not given a timeout gets 15 s, a test has 45 s (`test.setTimeout(ms)` raises it, and the waits of a longer scenario need their own `timeoutMs`). Never `page.evaluate`, a timer or `eval` in a spec.
- A fault rule is data: `profile('bandwidth-drop')`, `originStall(session.live!.edgeNumber + 3, 10_000)`, `session.service.addFaults(session.id, rules)`, `removeFault`. Select by segment number where the scenario allows; read what was applied in `request-log.json` (`faults` ids).
- A spec never decides by browser name: a gap is a skip with a reason from the evidence (7.3).
- A **negative observation** (a paused player does not advance the media clock; no event happens in a window) is the one place where nothing positive marks the end of the wait: use `await qa.observeFrames(n)` (the page's own frames, 7.1), never a timer and never a frame loop of your own. Wait for the positive event first (`await qa.pause()` resolves on `paused`), read the state, observe, read it again, and give the observation its positive control in the same spec (resume, observe the same number of frames, see the clock move), or it cannot fail.

### 7.5 Flake tracking: what a spec owes it, and the contracts it creates

Decisions: [decisions/flake.md](decisions/flake.md) (ADR-130 to ADR-139); how to use it: [FLAKE.md](FLAKE.md). A spec needs nothing of its own: the reporter (`flake/reporter.ts`, listed in `playwright.config.ts`) reads the catalog id from the start of the title, the tier from the tags, the reason of a skip from the `skip` annotation (so a documented gap must pass its reason to `testInfo.skip(true, reason)`; a skip without one is listed by the report as a bug) and the `experimental-engine` annotation of the shared fixture. Three shapes are contracts for the tools that read them:

- **The run file**, `reports/flake/run.json` (`PB_FLAKE_RUN_FILE`), one `FlakeRun` (`flake/run.ts`, `schemaVersion` 1) per Playwright invocation: per test the id, engine, tier, outcome (`passed`, `flaky`, `failed`, `timedOut`, `skipped`, `interrupted`), `quarantined`, `retries` and every attempt with its status, duration and error signature. `parseRun` refuses a version it does not know and keeps the fields it does not know.
- **The history**: `flake/history/<envId>.jsonl` or the `ci-data` branch's `history/<envId>.jsonl`, one run per line with the keys sorted, the last 200 runs of an environment.
- **The error signature**, `errorSignature()` in `src/lab/signature.ts`: the first line of a failure with its numbers, ids, timestamps, urls and paths normalised. Failure triage (Phase 8) clusters with this function and not with a copy of it.

## 8. Environments, ports, variables

- `PB_PORT` (default 4600): service port. Parallel work uses disjoint ranges: media 4620-4629, server 4630-4639, player 4640-4649, e2e agents 4650-4699, perf and A/B 4700-4729, live 4730-4749, triage 4750-4759. `PB_PORT=0` picks a free port (the line the CLI prints says which).
- `PB_HOST` (default `127.0.0.1`), `PB_PLAYER_DIR` (default `dist/player`), `PB_CACHE_DIR` (the stream cache to serve, default `.cache/streams`), `PB_LOG=1` (one line per request on stderr): read by `npm run serve` only; `startServer` takes the same things as options.
- `PB_ENV_ID`: explicit environment id; otherwise `detectEnvId()` (`src/shared/env.ts`): `local-darwin-arm64`, `docker-linux-arm64`, `gha-linux-x64`, `gha-macos-arm64`, `jenkins-linux-arm64`...
  Baselines are keyed by it and never compared across environments.
- `PB_ORIGIN`: service origin for the client (default `http://127.0.0.1:${PB_PORT}`).
- `PB_FLAKE_RUN_FILE`, `PB_RUN_ID`, `PB_FLAKE_QUARANTINE`; `PB_FLAKE_STORE`, `PB_FLAKE_HISTORY_DIR`, `PB_FLAKE_GIT_REMOTE`, `PB_FLAKE_GIT_BRANCH`, `PB_FLAKE_GIT_IDENTITY`: the flake reporter, the gate and the report (the table in [FLAKE.md](FLAKE.md)); all optional.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`: optional, triage summaries only. Everything works without them.

## 9. Commands (names are fixed; implementations arrive with their phase)

`npm run typecheck | lint | format:check | docs:check | specs:check | build:player | generate:streams | verify:streams | serve | smoke:service | bench:server | player:smoke | codec-matrix | docker:pw | test:unit | test:e2e | test:merge | test:release | perf | perf:gate | perf:baseline | flake:report | flake:gate | ab | readiness | soak | triage`
(`docker:pw -- <command>` runs a command inside the Playwright Linux image that matches the pinned `@playwright/test`, with the repository mounted: this is how Firefox runs on a macOS host and how the Linux CI environment is reproduced locally. `codec-matrix` probes the installed browsers and writes `docs/results/codec-matrix/<envId>.json`; `codec-matrix -- --render` regenerates [CODEC_MATRIX.md](CODEC_MATRIX.md) from every committed file and `-- --check` fails when it is stale. Options of both: `npm run codec-matrix -- --help`, `bash tools/docker/pw.sh --help`.)
and the CI gate stages `gate:static | gate:unit | gate:merge | gate:perf | gate:flake | gate:triage`, which both GitHub Actions and the Jenkinsfile call.

## 10. Rules of engagement for contributors (including the agents that build this)

- Only the orchestrator pushes, opens pull requests, merges, and installs dependencies. Do not edit `package.json`/`package-lock.json`; ask for the dependency you need.
- Commit as `hanniavalera <hannia.cpp@gmail.com>`, no co-author or tool trailers.
- Heavy jobs run one at a time on the shared machine; do not run performance, A/B or soak measurements unless your brief says so.
- Never fake a metric: every number in a document comes from a real run and carries the environment, date and commit it was measured on.
- Create and edit files with the editor tools, not with shell redirection.
