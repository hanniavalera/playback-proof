# Failure triage

**63 failed in 5 reports became 3 clusters of 1 root cause.** The clusters are deterministic (one signature, one cluster: the same cause whatever its ids, ports and timestamps); the category is the first rule of a table that fits, with the evidence it found. triage is not a gate: it explains a red build and never decides one.

| # | Failures | Engines | Tests | Category · rule | Class | Error |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 59 | chromium, chromium-cpu4x, firefox, webkit | PB-ABR-002, PB-LIVE-001, PB-LIVE-002, PB-LIVE-003 +10 | `page-boot-failure` · `page-did-not-boot` | Functional regression | Error: the player page did not boot (http://127.0.0.1:4600/player/?manifest=%2Fs%2F2eddfafe7dcf%2Fvod-cmaf%2Fdash%2Fman… |
| 2 | 3 | chromium, firefox, webkit | PB-ENV-001 | `page-boot-failure` · `page-did-not-boot` | Functional regression | Error: chromium 156.0.8078.4 in gha-linux-x64 could not play vod-cmaf over dash through the player, and no documented g… |
| 3 | 1 | webkit | PB-ENV-001 | `page-boot-failure` · `page-did-not-boot` | Functional regression | Error: webkit 27.2 in gha-macos-arm64 could not play vod-cmaf over dash through the player, and no documented gap cover… |

## Root causes shared by several clusters

A cluster is one signature, which is the words of one failure. When the same rule found the same cause behind several clusters, the tests worded one cause in several ways; they are listed here as one.

| Failures | Clusters | Engines | Tests | Category · rule | What is broken |
| --- | --- | --- | --- | --- | --- |
| 63 | #1, #2, #3 | chromium, chromium-cpu4x, firefox, webkit | PB-ABR-002, PB-ENV-001, PB-LIVE-001, PB-LIVE-002, PB-LIVE-003, PB-LIVE-004 +9 | `page-boot-failure` · `page-did-not-boot` | the player page did not boot: a Content Security Policy blocked its scripts |

## #1 · 59 failures · page-boot-failure

- **Signature** `Error: the player page did not boot (<url>): Timeout <n>ms exceeded. [thrown]` (key `fc2f02c1e869`)
- **Engines** chromium, chromium-cpu4x, firefox, webkit · **tests** PB-ABR-002, PB-LIVE-001, PB-LIVE-002, PB-LIVE-003, PB-LIVE-004, PB-REC-001, PB-REC-002, PB-REC-008, PB-VOD-001, PB-VOD-002, PB-VOD-006, PB-VOD-007 +2 · **outcomes** failed 59, timed out 0, flaky 0
- **Category** `page-boot-failure`: The player page loaded but did not come up (a blocked script, a refused parameter).
- **Rule** `page-did-not-boot`: The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.
- **Root cause** shared with the clusters #2, #3: the player page did not boot: a Content Security Policy blocked its scripts
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the page did not boot: “Error: the player page did not boot (http://127.0.0.1:4600/player/?manifest=%2Fs%2F2eddfafe7dcf%2Fvod-cmaf%2Fdash%2Fmanifest.mpd): Timeout 15000ms exceeded.”
  - the console names a Content Security Policy violation
  - console: “Loading the script 'http://127.0.0.1:4600/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src…”
  - console: “Loading the script 'http://127.0.0.1:4600/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-sr…”
- **First thing to check** The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.
- **Representative failure** PB-ABR-002 on chromium: failed, 2 attempts of 2, merge tier, gha-linux-x64, from `reports-chromium/reports/playwright.json`

```text
Error: the player page did not boot (http://127.0.0.1:4600/player/?manifest=%2Fs%2F2eddfafe7dcf%2Fvod-cmaf%2Fdash%2Fmanifest.mpd): Timeout 15000ms exceeded.
The browser console said:
  error: Loading the script 'http://127.0.0.1:4600/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
  error: Loading the script 'http://127.0.0.1:4600/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
```

Frames of the lab's own code: `tests/e2e/abr.spec.ts:150`

Could not be read: qa-events.json: not attached; qa-metrics.json: not attached; qa-info.json: not attached

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-ABR-002 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-ABR-002 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-ABR-002 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-ABR-002 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-LIVE-001 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-LIVE-001 | chromium-cpu4x | failed | reports-chromium-cpu4x/reports/playwright.json |
| PB-LIVE-001 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-LIVE-001 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-LIVE-001 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-LIVE-002 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-LIVE-002 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-LIVE-002 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-LIVE-002 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-LIVE-003 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-LIVE-003 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-LIVE-003 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-LIVE-003 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-LIVE-004 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-LIVE-004 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-LIVE-004 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-LIVE-004 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-REC-001 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-REC-001 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-REC-001 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-REC-001 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-REC-002 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-REC-002 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-REC-002 | webkit | failed | reports-webkit-linux/reports/playwright.json |
| PB-REC-002 | webkit | failed | reports-webkit-macos/reports/playwright.json |
| PB-REC-008 | chromium | failed | reports-chromium/reports/playwright.json |
| … | | | 29 more |

## #2 · 3 failures · page-boot-failure

- **Signature** `Error: <engine> <n> in <env> could not play vod-cmaf over dash through the player, and no documented gap covers it. [thrown]` (key `8cae2e3bcaa6`)
- **Engines** chromium, firefox, webkit · **tests** PB-ENV-001 · **outcomes** failed 3, timed out 0, flaky 0
- **Category** `page-boot-failure`: The player page loaded but did not come up (a blocked script, a refused parameter).
- **Rule** `page-did-not-boot`: The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.
- **Root cause** shared with the clusters #1, #3: the player page did not boot: a Content Security Policy blocked its scripts
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the page did not boot: “Error: chromium 156.0.8078.4 in gha-linux-x64 could not play vod-cmaf over dash through the player, and no documented gap covers it.”
  - the console names a Content Security Policy violation
  - console: “Loading the script 'http://127.0.0.1:4600/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src…”
  - console: “Loading the script 'http://127.0.0.1:4600/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-sr…”
- **First thing to check** The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.
- **Representative failure** PB-ENV-001 on chromium: failed, 2 attempts of 2, merge tier, gha-linux-x64, from `reports-chromium/reports/playwright.json`

```text
Error: chromium 156.0.8078.4 in gha-linux-x64 could not play vod-cmaf over dash through the player, and no documented gap covers it.
What the player said: the player page did not boot (http://127.0.0.1:4600/player/?manifest=%2Fs%2F149fcc7a0d68%2Fvod-cmaf%2Fdash%2Fmanifest.mpd): Timeout 15000ms exceeded.
The browser console said:
  error: Loading the script 'http://127.0.0.1:4600/player/shaka.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
  error: Loading the script 'http://127.0.0.1:4600/player/player.js' violates the following Content Security Policy directive: "script-src 'none'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.
Committed evidence (docs/results/codec-matrix/gha-linux-x64.json) claims it plays: cmaf-vp9-aac ok 5/5.
So the engine or the runner image changed since the matrix was probed: this is an environment failure, not a playback regression. Re-run `npm run codec-matrix` here and read docs/CODEC_MATRIX.md; do not retry the specs.
```

Frames of the lab's own code: `tests/e2e/env.spec.ts:47`

Could not be read: qa-events.json: not attached; qa-metrics.json: not attached; qa-info.json: not attached

| Test | Engine | Outcome | Report |
| --- | --- | --- | --- |
| PB-ENV-001 | chromium | failed | reports-chromium/reports/playwright.json |
| PB-ENV-001 | firefox | failed | reports-firefox/reports/playwright.json |
| PB-ENV-001 | webkit | failed | reports-webkit-linux/reports/playwright.json |

## #3 · 1 failure · page-boot-failure

- **Signature** `Error: <engine> <n> in gha-macos-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it. [thrown]` (key `6be738a93d66`)
- **Engines** webkit · **tests** PB-ENV-001 · **outcomes** failed 1, timed out 0, flaky 0
- **Category** `page-boot-failure`: The player page loaded but did not come up (a blocked script, a refused parameter).
- **Rule** `page-did-not-boot`: The page loaded and the player hook never became ready: the page build, its scripts or its headers are what is wrong.
- **Root cause** shared with the clusters #1, #2: the player page did not boot: a Content Security Policy blocked its scripts
- **Class** Functional regression (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - the page did not boot: “Error: webkit 27.2 in gha-macos-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it.”
  - the console names a Content Security Policy violation
  - console: “Refused to load http://127.0.0.1:4600/player/shaka.js because it does not appear in the script-src directive of the Content Security Policy.”
  - console: “Refused to load http://127.0.0.1:4600/player/player.js because it does not appear in the script-src directive of the Content Security Policy.”
  - console: “Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.”
- **First thing to check** The console lines quoted in the message (a blocked script is a Content Security Policy or a missing `dist/player`): `curl -I <origin>/player/`, then `npm run build:player`.
- **Representative failure** PB-ENV-001 on webkit: failed, 2 attempts of 2, merge tier, gha-linux-x64, from `reports-webkit-macos/reports/playwright.json`

```text
Error: webkit 27.2 in gha-macos-arm64 could not play vod-cmaf over dash through the player, and no documented gap covers it.
What the player said: the player page did not boot (http://127.0.0.1:4600/player/?manifest=%2Fs%2Ff150e1d54213%2Fvod-cmaf%2Fdash%2Fmanifest.mpd): Timeout 15000ms exceeded.
The browser console said:
  error: Refused to load http://127.0.0.1:4600/player/shaka.js because it does not appear in the script-src directive of the Content Security Policy.
  error: Refused to load http://127.0.0.1:4600/player/player.js because it does not appear in the script-src directive of the Content Security Policy.
Committed evidence (docs/results/codec-matrix/gha-macos-arm64.json) claims it plays: cmaf-vp9-aac ok 5/5.
So the engine or the runner image changed since the matrix was probed: this is an environment failure, not a playback regression. Re-run `npm run codec-matrix` here and read docs/CODEC_MATRIX.md; do not retry the specs.
```

Frames of the lab's own code: `tests/e2e/env.spec.ts:47`

Could not be read: qa-events.json: not attached; qa-metrics.json: not attached; qa-info.json: not attached

## Reports read

| Report | Tests | Passed | Failed | Flaky | Skipped | Not run | Interrupted | Run errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reports-chromium/reports/playwright.json | 15 | 0 | 15 | 0 | 0 | 0 | 0 | 0 |
| reports-chromium-cpu4x/reports/playwright.json | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| reports-firefox/reports/playwright.json | 15 | 0 | 15 | 0 | 0 | 0 | 0 | 0 |
| reports-webkit-linux/reports/playwright.json | 15 | 0 | 15 | 0 | 0 | 0 | 0 | 0 |
| reports-webkit-macos/reports/playwright.json | 15 | 0 | 15 | 0 | 0 | 0 | 0 | 0 |

---

No model summaries: they are opt-in (`npm run triage -- --summarize`, with `ANTHROPIC_API_KEY`).

Generated 2026-11-04T18:39:23.214Z from `artifacts` by `triage/` (docs/TRIAGE.md).
