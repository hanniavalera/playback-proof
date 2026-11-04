# Failure triage

**31 failed in 7 reports became 12 clusters of 8 root causes.** The clusters are deterministic (one signature, one cluster: the same cause whatever its ids, ports and timestamps); the category is the first rule of a table that fits, with the evidence it found. triage is not a gate: it explains a red build and never decides one.

| # | Failures | Engines | Tests | Category · rule | Class | Error |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 6 | chromium, webkit | PB-VOD-001, PB-VOD-002, PB-VOD-006 | `origin-error` · `origin-failed-without-fault` | Environment or infrastructure | Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0). |
| 2 | 6 | chromium, webkit | PB-VOD-001, PB-VOD-002, PB-VOD-006 | `decode-or-mse-error` · `media-error` | Functional regression | Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0). |
| 3 | 5 | chromium, chromium-cpu4x, webkit | PB-VOD-001, PB-VOD-002 | `page-boot-failure` · `page-did-not-boot` | Functional regression | Error: the player page did not boot (http://&lt;host&gt;/player/?&lt;query&gt;): Timeout 15000ms exceeded. |
| 4 | 2 | chromium, webkit | PB-ENV-001 | `page-boot-failure` · `page-did-not-boot` | Functional regression | Error: chromium 156.0.8078.4 in local-darwin-arm64 could not play vod-cmaf over dash through the player, and no documen… |
| 5 | 2 | chromium, webkit | PB-REC-001 | `network-fault-not-recovered` · `fault-fired-player-failed` | Functional regression | Error: qa.waitForMediaTime(7) timed out after 15000 ms: the media clock is at 5.974 s. |
| 6 | 2 | chromium, webkit | PB-REC-001 | `origin-error` · `origin-failed-without-fault` | Environment or infrastructure | Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":1,"status":404,… |
| 7 | 2 | chromium, webkit | PB-REC-002 | `origin-error` · `origin-failed-without-fault` | Environment or infrastructure | Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":3,"status":503,… |
| 8 | 2 | chromium, webkit | PB-REC-002 | `network-fault-not-recovered` · `fault-fired-player-failed` | Functional regression | Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":3,"status":503,… |
| 9 | 1 | (run) | (run) | `environment` · `run-failed-before-any-test` | Environment or infrastructure | Error: Process from config.webServer was not able to start. Exit code: 1 |
| 10 | 1 | chromium | PB-VOD-006 | `instrument-disagreement` · `test-premise-not-met` | Needs a person | Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (2.114762 s) when the … |
| 11 | 1 | chromium | PB-VOD-012 | `metric-regression` · `metric-assertion-failed` | Performance regression | Error: rebuffers (metrics.rebuffer.count): expected none, saw 2 totalling 3994 ms: at media time 1.96 s for 3003 ms; at… |
| 12 | 1 | (run) | (run) | `environment` · `service-not-reachable` | Environment or infrastructure | Error: the test data service at http://&lt;host&gt; is not answering (GET /health -&gt; no answer ECONNREFUSED): start it with `… |

## Root causes shared by several clusters

A cluster is one signature, which is the words of one failure. When the same rule found the same cause behind several clusters, the tests worded one cause in several ways; they are listed here as one.

| Failures | Clusters | Engines | Tests | Category · rule | What is broken |
| --- | --- | --- | --- | --- | --- |
| 10 | #1, #6, #7 | chromium, webkit | PB-REC-001, PB-REC-002, PB-VOD-001, PB-VOD-002, PB-VOD-006 | `origin-error` · `origin-failed-without-fault` | the origin answered 503 on segment to requests no fault rule named |
| 7 | #3, #4 | chromium, chromium-cpu4x, webkit | PB-ENV-001, PB-VOD-001, PB-VOD-002 | `page-boot-failure` · `page-did-not-boot` | the player page did not boot: a Content Security Policy blocked its scripts |
| 4 | #5, #8 | chromium, webkit | PB-REC-001, PB-REC-002 | `network-fault-not-recovered` · `fault-fired-player-failed` | a fault of type status fired and the player did not recover |

## #1 · 6 failures · origin-error

- **Signature** `Error: qa.waitFor('firstframe') timed out after <n> ms (looking from index <n>). [thrown] {shaka 1001}` (key `c9b6a99f380d`)
- **Engines** chromium, webkit · **tests** PB-VOD-001, PB-VOD-002, PB-VOD-006 · **outcomes** failed 6, timed out 0, flaky 0
- **Category** `origin-error`: The origin answered errors that no fault rule explains: the service or its stream cache is broken.
- **Rule** `origin-failed-without-fault`: The origin answered errors or cut responses on requests no fault rule named, and the player noticed: the service or its stream cache is at fault.
- **Root cause** shared with the clusters #6, #7: the origin answered 503 on segment to requests no fault rule named
- **Class** Environment or infrastructure (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - 14 requests failed at the origin with no fault rule on them (14 failed in all, 14 segment requests in the log)
  - the first failures: 503 on segment a-aac #1 ×3, 503 on segment v720 #1 ×2, 503 on segment v360 #1, 503 on segment a-aac #2 ×2
  - the player noticed: BAD_HTTP_STATUS (code 1001, network, critical)
- **First thing to check** The failed requests in request-log.json: ask the service for the same path (`curl -i <origin><path>`), run `npm run verify:streams`, and read the service log (`PB_LOG=1`).
- **Representative failure** PB-VOD-001 on chromium: failed, 2 attempts of 2, merge tier, from `origin-503/playwright.json`

```text
Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
14 events so far, the last 14:
  #0 t=77.9 media=0.000 load-requested {"uri":"/s/7c06e0c7db20/vod-cmaf/dash/manifest.mpd"}
  #1 t=78.8 media=0.000 buffering-start
  #2 t=86.5 media=0.000 manifest-loaded
  #3 t=90.0 media=0.000 buffering-start
  #4 t=90.4 media=0.000 variant-changed {"from":null,"to":2,"bandwidth":1845302,"height":720,"reason":"start"}
  #5 t=91.2 media=0.000 loaded
  #6 t=2308.4 media=0.000 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":2,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/7c06e…
  #7 t=2326.6 media=0.000 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":1,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/7c06e…
  #8 t=2326.6 media=0.000 variant-changed {"from":2,"to":1,"bandwidth":746778,"height":360,"reason":"abr"}
  #9 t=4154.8 media=0.000 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":2,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/7c06e…
  #10 t=4265.0 media=0.000 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":1,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/7c06e…
  #11 t=4265.0 media=0.000 variant-changed {"from":1,"to":0,"bandwidth":341878,"height":240,"reason":"abr"}
  #12 t=6320.4 media=0.000 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":2,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/7c06e…
... (1 more lines)
```

Frames of the lab's own code: `tests/e2e/vod-start.spec.ts:24 expectStartsAndPlays` ← `tests/e2e/vod-start.spec.ts:88`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-VOD-001 | chromium | failed | origin-503/playwright.json |
| PB-VOD-001 | webkit | failed | origin-503/playwright.json |
| PB-VOD-002 | chromium | failed | origin-503/playwright.json |
| PB-VOD-002 | webkit | failed | origin-503/playwright.json |
| PB-VOD-006 | chromium | failed | origin-503/playwright.json |
| PB-VOD-006 | webkit | failed | origin-503/playwright.json |

## #2 · 6 failures · decode-or-mse-error

- **Signature** `Error: qa.waitFor('firstframe') timed out after <n> ms (looking from index <n>). [thrown] {shaka media}` (key `a0957e05ad95`)
- **Engines** chromium, webkit · **tests** PB-VOD-001, PB-VOD-002, PB-VOD-006 · **outcomes** failed 6, timed out 0, flaky 0
- **Category** `decode-or-mse-error`: The player reported a media error (Shaka 3xxx: an append, a decode, a video element error).
- **Rule** `media-error`: Shaka category 3 (media) or a media-element error: the bytes arrived and the browser could not append or decode them.
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the player reported a media error: VIDEO_ERROR (code 3016, media, critical)
  - the player reported a media error: MEDIA_SOURCE_OPERATION_THREW (code 3015, media, critical)
  - the origin delivered every request it was asked for (10 requests, none failed): the bytes themselves are suspect
- **First thing to check** The error in qa-events.json (code and data), then the segment that was being appended: `npm run verify:streams`, and try the same stream in another engine.
- **Representative failure** PB-VOD-001 on chromium: failed, 2 attempts of 2, merge tier, from `corrupt-segments/playwright.json`

```text
Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
10 events so far, the last 10:
  #0 t=74.8 media=0.000 load-requested {"uri":"/s/4baeb6aabb1d/vod-cmaf/dash/manifest.mpd"}
  #1 t=75.7 media=0.000 buffering-start
  #2 t=82.6 media=0.000 manifest-loaded
  #3 t=85.9 media=0.000 buffering-start
  #4 t=86.3 media=0.000 variant-changed {"from":null,"to":2,"bandwidth":1845302,"height":720,"reason":"start"}
  #5 t=87.0 media=0.000 loaded
  #6 t=192.9 media=0.000 error {"code":3016,"codeName":"VIDEO_ERROR","category":3,"severity":2,"message":"MEDIA.VIDEO_ERROR: Shaka Error 3016","data":[3,"undefined","PipelineStatus::PIPELINE_…
  #7 t=193.0 media=0.000 paused
  #8 t=193.1 media=0.000 error {"code":0,"category":0,"severity":1,"message":"AbortError: The play() request was interrupted by a call to pause(). https://<host>/LdLk22","source":"play","code…
  #9 t=1807.4 media=0.000 error {"code":3015,"codeName":"MEDIA_SOURCE_OPERATION_THREW","category":3,"severity":2,"message":"MEDIA.MEDIA_SOURCE_OPERATION_THREW: Shaka Error 3015","data":["{\"na…
```

Frames of the lab's own code: `tests/e2e/vod-start.spec.ts:24 expectStartsAndPlays` ← `tests/e2e/vod-start.spec.ts:88`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-VOD-001 | chromium | failed | corrupt-segments/playwright.json |
| PB-VOD-001 | webkit | failed | corrupt-segments/playwright.json |
| PB-VOD-002 | chromium | failed | corrupt-segments/playwright.json |
| PB-VOD-002 | webkit | failed | corrupt-segments/playwright.json |
| PB-VOD-006 | chromium | failed | corrupt-segments/playwright.json |
| PB-VOD-006 | webkit | failed | corrupt-segments/playwright.json |

## #3 · 5 failures · page-boot-failure

- **Signature** `Error: the player page did not boot (<url>): Timeout <n>ms exceeded. [thrown]` (key `fc2f02c1e869`)
- **Engines** chromium, chromium-cpu4x, webkit · **tests** PB-VOD-001, PB-VOD-002 · **outcomes** failed 5, timed out 0, flaky 0
- **Category** `page-boot-failure`: The player page loaded but did not come up (a blocked script, a refused parameter).
- **Rule** `page-did-not-boot`: The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.
- **Root cause** shared with the clusters #4: the player page did not boot: a Content Security Policy blocked its scripts
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the page did not boot: “Error: the player page did not boot (http://<host>/player/?<query>): Timeout 15000ms exceeded.”
  - the console names a Content Security Policy violation
  - console: “Loading the script 'http://<host>/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src…”
  - console: “Loading the script 'http://<host>/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-sr…”
- **First thing to check** The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.
- **Representative failure** PB-VOD-001 on chromium: failed, 2 attempts of 2, merge tier, from `csp-blocks-scripts/playwright.json`

```text
Error: the player page did not boot (http://<host>/player/?<query>): Timeout 15000ms exceeded.
The browser console said:
  error: Loading the script 'http://<host>/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
  error: Loading the script 'http://<host>/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
```

Frames of the lab's own code: `tests/e2e/vod-start.spec.ts:87`

Could not be read: qa-events.json: not attached; qa-metrics.json: not attached; qa-info.json: not attached

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-VOD-001 | chromium | failed | csp-blocks-scripts/playwright.json |
| PB-VOD-001 | chromium-cpu4x | failed | csp-blocks-scripts/playwright.json |
| PB-VOD-001 | webkit | failed | csp-blocks-scripts/playwright.json |
| PB-VOD-002 | chromium | failed | csp-blocks-scripts/playwright.json |
| PB-VOD-002 | webkit | failed | csp-blocks-scripts/playwright.json |

## #4 · 2 failures · page-boot-failure

- **Signature** `Error: <engine> <n> in <env> could not play vod-cmaf over dash through the player, and no documented gap covers it. [thrown]` (key `8cae2e3bcaa6`)
- **Engines** chromium, webkit · **tests** PB-ENV-001 · **outcomes** failed 2, timed out 0, flaky 0
- **Category** `page-boot-failure`: The player page loaded but did not come up (a blocked script, a refused parameter).
- **Rule** `page-did-not-boot`: The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.
- **Root cause** shared with the clusters #3: the player page did not boot: a Content Security Policy blocked its scripts
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the page did not boot: “Error: chromium 156.0.8078.4 in local-darwin-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it.”
  - the console names a Content Security Policy violation
  - console: “Loading the script 'http://<host>/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src…”
  - console: “Loading the script 'http://<host>/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-sr…”
- **First thing to check** The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.
- **Representative failure** PB-ENV-001 on chromium: failed, 2 attempts of 2, merge tier, local-darwin-arm64, from `csp-blocks-scripts/playwright.json`

```text
Error: chromium 156.0.8078.4 in local-darwin-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it.
What the player said: the player page did not boot (http://<host>/player/?<query>): Timeout 15000ms exceeded.
The browser console said:
  error: Loading the script 'http://<host>/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
  error: Loading the script 'http://<host>/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
Committed evidence (docs/results/codec-matrix/local-darwin-arm64.json) claims it plays: cmaf-vp9-aac ok 5/5.
So the engine or the runner image changed since the matrix was probed: this is an environment failure, not a playback regression. Re-run `npm run codec-matrix` here and read docs/CODEC_MATRIX.md; do not retry the specs.
```

Frames of the lab's own code: `tests/e2e/env.spec.ts:47`

Could not be read: qa-events.json: not attached; qa-metrics.json: not attached; qa-info.json: not attached

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-ENV-001 | chromium | failed | csp-blocks-scripts/playwright.json |
| PB-ENV-001 | webkit | failed | csp-blocks-scripts/playwright.json |

## #5 · 2 failures · network-fault-not-recovered

- **Signature** `Error: qa.waitForMediaTime(<n>) timed out after <n> ms: the media clock is at <n> s. [thrown] {shaka 1001}` (key `b8e5edac63ec`)
- **Engines** chromium, webkit · **tests** PB-REC-001 · **outcomes** failed 2, timed out 0, flaky 0
- **Category** `network-fault-not-recovered`: A fault the test injected fired, and the player ended in a critical error.
- **Rule** `fault-fired-player-failed`: The request log shows a fault rule firing and the player then reported a critical error: the failure is the recovery, not the fault.
- **Root cause** shared with the clusters #8: a fault of type status fired and the player did not recover
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - fault f1 (status 404 on segment video #3 first 1) fired on 1 request
  - the player reported a critical error: BAD_HTTP_STATUS (code 1001, network, critical)
  - player state at the end: error
- **First thing to check** In request-log.json, the first request the fault hit; then in qa-events.json what the player did next: retry, fail over to another rung, or give up. `session-detail.json` has the rule to reproduce it.
- **Representative failure** PB-REC-001 on chromium: failed, 2 attempts of 2, merge tier, from `retry-disabled/playwright.json`

```text
Error: qa.waitForMediaTime(7) timed out after 15000 ms: the media clock is at 5.974 s.
11 events so far, the last 11:
  #0 t=96.8 media=0.000 load-requested {"uri":"/s/c9aaf10528bb/vod-cmaf/dash/manifest.mpd"}
  #1 t=97.7 media=0.000 buffering-start
  #2 t=107.5 media=0.000 manifest-loaded
  #3 t=115.3 media=0.000 buffering-start
  #4 t=115.7 media=0.000 variant-changed {"from":null,"to":2,"bandwidth":1845302,"height":720,"reason":"start"}
  #5 t=116.6 media=0.000 loaded
  #6 t=288.3 media=0.000 playing
  #7 t=288.5 media=0.001 buffering-end
  #8 t=298.7 media=0.011 firstframe {"source":"requestVideoFrameCallback"}
  #9 t=883.4 media=0.552 error {"code":1001,"codeName":"BAD_HTTP_STATUS","category":1,"severity":2,"message":"NETWORK.BAD_HTTP_STATUS: Shaka Error 1001","data":["http://<host>/s/c9aaf…
  #10 t=6305.9 media=5.974 buffering-start
```

Frames of the lab's own code: `tests/e2e/recovery.spec.ts:63`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-REC-001 | chromium | failed | retry-disabled/playwright.json |
| PB-REC-001 | webkit | failed | retry-disabled/playwright.json |

## #6 · 2 failures · origin-error

- **Signature** `Error: the fault rule <rule> {…} named <n> of the <n> request it was waited for within <n> ms: the player never asked for what the rule matches, so nothing after this line says how the player copes w… [thrown] {shaka 1001}` (key `011e98b3e6ee`)
- **Engines** chromium, webkit · **tests** PB-REC-001 · **outcomes** failed 2, timed out 0, flaky 0
- **Category** `origin-error`: The origin answered errors that no fault rule explains: the service or its stream cache is broken.
- **Rule** `origin-failed-without-fault`: The origin answered errors or cut responses on requests no fault rule named, and the player noticed: the service or its stream cache is at fault.
- **Root cause** shared with the clusters #1, #7: the origin answered 503 on segment to requests no fault rule named
- **Class** Environment or infrastructure (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - 14 requests failed at the origin with no fault rule on them (14 failed in all, 14 segment requests in the log)
  - the first failures: 503 on segment a-aac #1 ×4, 503 on segment v720 #1 ×2, 503 on segment v360 #1, 503 on segment a-aac #2
  - the player noticed: BAD_HTTP_STATUS (code 1001, network, recoverable)
- **First thing to check** The failed requests in request-log.json: ask the service for the same path (`curl -i <origin><path>`), run `npm run verify:streams`, and read the service log (`PB_LOG=1`).
- **Representative failure** PB-REC-001 on chromium: failed, 2 attempts of 2, merge tier, from `origin-503/playwright.json`

```text
Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":1,"status":404,"id":"f1"} named 0 of the 1 request it was waited for within 15000 ms: the player never asked for what the rule matches, so nothing after this line says how the player copes with t…
The log after the cursor has 20 entries, the last 12:
  #9 GET segment v360 #1 -> 503 in 0.92 ms
  #10 GET init a-aac -> 200 in 0.31 ms
  #11 GET segment a-aac #2 -> 503 in 0.5 ms
  #12 GET segment a-aac #1 -> 503 in 0.11 ms
  #13 GET segment a-aac #1 -> 503 in 0.57 ms
  #14 GET segment a-aac #2 -> 503 in 0.32 ms
  #15 GET segment v360 #1 -> 503 in 0.22 ms
  #16 GET init v240 -> 200 in 0.82 ms
  #17 GET segment v240 #1 -> 503 in 0.62 ms
  #18 GET segment a-aac #1 -> 503 in 0.19 ms
  #19 GET segment v240 #1 -> 503 in 0.19 ms
  #20 GET segment a-aac #1 -> 503 in 0.22 ms
```

Frames of the lab's own code: `tests/e2e/recovery.spec.ts:54`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-REC-001 | chromium | failed | origin-503/playwright.json |
| PB-REC-001 | webkit | failed | origin-503/playwright.json |

## #7 · 2 failures · origin-error

- **Signature** `Error: the fault rule <rule> {…} named <n> of the <n> requests it was waited for within <n> ms: the player never asked for what the rule matches, so nothing after this line says how the player copes … [thrown] {shaka 1001}` (key `1966266eef5d`)
- **Engines** chromium, webkit · **tests** PB-REC-002 · **outcomes** failed 2, timed out 0, flaky 0
- **Category** `origin-error`: The origin answered errors that no fault rule explains: the service or its stream cache is broken.
- **Rule** `origin-failed-without-fault`: The origin answered errors or cut responses on requests no fault rule named, and the player noticed: the service or its stream cache is at fault.
- **Root cause** shared with the clusters #1, #6: the origin answered 503 on segment to requests no fault rule named
- **Class** Environment or infrastructure (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - 14 requests failed at the origin with no fault rule on them (14 failed in all, 14 segment requests in the log)
  - the first failures: 503 on segment a-aac #1 ×3, 503 on segment v720 #1 ×2, 503 on segment v360 #1 ×2, 503 on segment a-aac #2
  - the player noticed: BAD_HTTP_STATUS (code 1001, network, recoverable)
- **First thing to check** The failed requests in request-log.json: ask the service for the same path (`curl -i <origin><path>`), run `npm run verify:streams`, and read the service log (`PB_LOG=1`).
- **Representative failure** PB-REC-002 on chromium: failed, 2 attempts of 2, merge tier, from `origin-503/playwright.json`

```text
Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":3,"status":503,"id":"f1"} named 0 of the 3 requests it was waited for within 15000 ms: the player never asked for what the rule matches, so nothing after this line says how the player copes with …
The log after the cursor has 20 entries, the last 12:
  #9 GET segment v360 #1 -> 503 in 0.08 ms
  #10 GET init a-aac -> 200 in 0.07 ms
  #11 GET segment a-aac #2 -> 503 in 0.05 ms
  #12 GET segment a-aac #1 -> 503 in 0.14 ms
  #13 GET segment v360 #1 -> 503 in 0.13 ms
  #14 GET segment a-aac #1 -> 503 in 0.19 ms
  #15 GET segment a-aac #2 -> 503 in 0.15 ms
  #16 GET init v240 -> 200 in 0.23 ms
  #17 GET segment v240 #1 -> 503 in 0.24 ms
  #18 GET segment a-aac #1 -> 503 in 0.18 ms
  #19 GET segment v240 #1 -> 503 in 0.17 ms
  #20 GET segment a-aac #1 -> 503 in 0.17 ms
```

Frames of the lab's own code: `tests/e2e/recovery.spec.ts:121`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-REC-002 | chromium | failed | origin-503/playwright.json |
| PB-REC-002 | webkit | failed | origin-503/playwright.json |

## #8 · 2 failures · network-fault-not-recovered

- **Signature** `Error: the fault rule <rule> {…} named <n> of the <n> requests it was waited for within <n> ms: the player stopped asking for what the rule matches before the rule was used up, so nothing after this … [thrown] {shaka 1001}` (key `30a43b41436d`)
- **Engines** chromium, webkit · **tests** PB-REC-002 · **outcomes** failed 2, timed out 0, flaky 0
- **Category** `network-fault-not-recovered`: A fault the test injected fired, and the player ended in a critical error.
- **Rule** `fault-fired-player-failed`: The request log shows a fault rule firing and the player then reported a critical error: the failure is the recovery, not the fault.
- **Root cause** shared with the clusters #5: a fault of type status fired and the player did not recover
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - fault f1 (status 503 on segment video #3 first 3) fired on 1 request
  - the player reported a critical error: BAD_HTTP_STATUS (code 1001, network, critical)
  - player state at the end: error
- **First thing to check** In request-log.json, the first request the fault hit; then in qa-events.json what the player did next: retry, fail over to another rung, or give up. `session-detail.json` has the rule to reproduce it.
- **Representative failure** PB-REC-002 on chromium: failed, 2 attempts of 2, merge tier, from `retry-disabled/playwright.json`

```text
Error: the fault rule f1 {"type":"status","match":{"kind":"segment","track":"video","number":3},"times":3,"status":503,"id":"f1"} named 1 of the 3 requests it was waited for within 15000 ms: the player stopped asking for what the rule matches before the rule was used up, so nothing after this line …
The log after the cursor has 9 entries, the last 9:
  #1 GET manifest -> 200 in 0.29 ms
  #2 GET init a-aac -> 200 in 0.37 ms
  #3 GET segment a-aac #1 -> 200 in 0.13 ms
  #4 GET init v720 -> 200 in 0.16 ms
  #5 GET segment v720 #1 -> 200 in 0.47 ms
  #6 GET segment a-aac #2 -> 200 in 0.18 ms
  #7 GET segment v720 #2 -> 200 in 0.36 ms
  #8 GET segment v720 #3 -> 503 in 0.15 ms [faults f1]
  #9 GET segment a-aac #3 -> 200 in 0.22 ms
```

Frames of the lab's own code: `tests/e2e/recovery.spec.ts:121`

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-REC-002 | chromium | failed | retry-disabled/playwright.json |
| PB-REC-002 | webkit | failed | retry-disabled/playwright.json |

## #9 · 1 failure · environment

- **Signature** `Error: Process from config.webServer was not able to start. Exit code: <n> [thrown]` (key `d5f804cf8b61`)
- **Engines** (run) · **tests** (run) · **outcomes** failed 1, timed out 0, flaky 0
- **Category** `environment`: The test could not run as designed: the browser, the service, the streams, a port, or the setup of the run.
- **Rule** `run-failed-before-any-test`: Playwright itself reported an error of the run (a global setup that threw, a web server that did not start): no test ran.
- **Class** Environment or infrastructure (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - an error of the run, with no test to blame: “Error: Process from config.webServer was not able to start. Exit code: 1”
  - the web server of the config is the test data service: it refuses to start when a stream file is missing or damaged (`npm run verify:streams`) or its port is taken, and says which in its own output, which is in the job log and not in this report
- **First thing to check** The job log above the first test: the global setup (`tests/e2e/support/global-setup.ts`) and the `webServer` of playwright.config.ts print what is wrong.
- **Representative failure** (run) on (run): failed, 0 attempts of 1, from `truncated-cache/playwright.json`

```text
Error: Process from config.webServer was not able to start. Exit code: 1
```

Could not be read: an error of the run, not of a test: there are no failure attachments

## #10 · 1 failure · instrument-disagreement

- **Signature** `Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (<n> s) when the seek to <n> s is made (metrics.playback.bufferedAheadSec) [toBeGreaterThan]` (key `ea3ccc131a7d`)
- **Engines** chromium · **tests** PB-VOD-006 · **outcomes** failed 1, timed out 0, flaky 0
- **Category** `instrument-disagreement`: Two readings of the same thing disagree, or a premise of the test did not hold (the fault it installed was never felt, the buffer it needs was never there): what the test measured says nothing about the behaviour it is about.
- **Rule** `test-premise-not-met`: The test checked a condition it needs before it can judge anything (its own message says "premise of the test, not the behaviour under test") and the condition did not hold: the behaviour was never exercised.
- **Class** Needs a person (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - a premise of the test did not hold: “Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (2.114762 s) when the seek to 7 s is made (metrics.playback.bufferedAheadSec)”
  - the timeline has 10 events and ends with “#9 t=5105.2 media=0.005 firstframe {"source":"requestVideoFrameCallback"}”
  - player state at the end: playing
- **First thing to check** The premise the message names against the player’s numbers (qa-metrics.json) and the request log: a premise that does not hold means the scenario could not be set up (a slow or failing origin, a loaded host). Compare `ttfbMs` and `totalMs` of the segments in request-log.json with the length of a segment.
- **Representative failure** PB-VOD-006 on chromium: failed, 2 attempts of 2, merge tier, from `origin-slow/playwright.json`

```text
Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (2.114762 s) when the seek to 7 s is made (metrics.playback.bufferedAheadSec)

expect(received).toBeGreaterThan(expected)

Expected: > 5.885238
Received:   0
```

Frames of the lab's own code: `tests/e2e/vod-seek.spec.ts:40`

## #11 · 1 failure · metric-regression

- **Signature** `Error: rebuffers (metrics.rebuffer.count): expected none, saw <n> totalling <n> ms: at media time <n> s for <n> ms; … [toBe]` (key `ec15e8fc1232`)
- **Engines** chromium · **tests** PB-VOD-012 · **outcomes** failed 1, timed out 0, flaky 0
- **Category** `metric-regression`: An assertion on a measured quantity failed (rebuffers, dropped frames, latency, startup).
- **Rule** `metric-assertion-failed`: The failing assertion is about a measured quantity (rebuffers, dropped frames, latency, startup) and nothing underneath explains it as an error.
- **Class** Performance regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the assertion is on metrics.rebuffer.count: “Error: rebuffers (metrics.rebuffer.count): expected none, saw 2 totalling 3994 ms: at media time 1.96 s for 3003 ms; at media time 3.97 s for 991 ms”
  - the player’s own numbers: 2 rebuffers totalling 3994 ms, 2 of 158 frames dropped, startup 2553 ms
- **First thing to check** The metric against METRICS.md and its tolerance in the spec; then the same run’s qa-metrics.json and the timeline around the value. Compare with the performance baseline before blaming the player.
- **Representative failure** PB-VOD-012 on chromium: failed, 2 attempts of 2, merge tier, from `origin-slow/playwright.json`

```text
Error: rebuffers (metrics.rebuffer.count): expected none, saw 2 totalling 3994 ms: at media time 1.96 s for 3003 ms; at media time 3.97 s for 991 ms

expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 2
```

Frames of the lab's own code: `tests/e2e/vod-metrics.spec.ts:141`

## #12 · 1 failure · environment

- **Signature** `Error: the test data service at <url> is not answering (GET /health -> no answer ECONNREFUSED): start it with 'npm run build:player && npm run serve' [thrown]` (key `6a6f2e7b5f99`)
- **Engines** (run) · **tests** (run) · **outcomes** failed 1, timed out 0, flaky 0
- **Category** `environment`: The test could not run as designed: the browser, the service, the streams, a port, or the setup of the run.
- **Rule** `service-not-reachable`: Nothing could talk to the test data service: every test needs it, so this is the environment, not a test.
- **Class** Environment or infrastructure (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the service could not be reached: “Error: the test data service at http://<host> is not answering (GET /health -> no answer ECONNREFUSED): start it with `npm run build:player && npm run serve`”
- **First thing to check** Is the service running on the port the run used (`curl <origin>/health`)? Start it with `npm run build:player && npm run serve`, and read its own log.
- **Representative failure** (run) on (run): failed, 0 attempts of 1, from `service-down/playwright.json`

```text
Error: the test data service at http://<host> is not answering (GET /health -> no answer ECONNREFUSED): start it with `npm run build:player && npm run serve`
```

Frames of the lab's own code: `tests/e2e/support/global-setup.ts:26` ← `tests/e2e/support/global-setup.ts:25 globalSetup`

Could not be read: an error of the run, not of a test: there are no failure attachments

## Skipped tests (not failures)

| Tests skipped | Engines | Tests | Reason |
| --- | --- | --- | --- |
| 3 | firefox | PB-ENV-001, PB-VOD-001, PB-VOD-002 | documented gap in local-darwin-arm64: firefox does not start here: Failed to launch the browser process: Could not find profile folder. (see docs/CODEC_MATRIX.md) |

## Reports read

| Report | Tests | Passed | Failed | Flaky | Skipped | Not run | Interrupted | Run errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| corrupt-segments/playwright.json | 6 | 0 | 6 | 0 | 0 | 0 | 0 | 0 |
| csp-blocks-scripts/playwright.json | 10 | 0 | 7 | 0 | 3 | 0 | 0 | 0 |
| origin-503/playwright.json | 10 | 0 | 10 | 0 | 0 | 0 | 0 | 0 |
| origin-slow/playwright.json | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| retry-disabled/playwright.json | 4 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| service-down/playwright.json | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| truncated-cache/playwright.json | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |

---

No model summaries: they are opt-in (`npm run triage -- --summarize`, with `ANTHROPIC_API_KEY`).

Generated 2026-11-04T16:38:46.625Z from `tests/fixtures/triage` by `triage/` (docs/TRIAGE.md).
