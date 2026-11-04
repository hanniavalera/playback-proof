## A/A check: firefox in `docker-linux-arm64`

The gate was run **5 times** against its own baseline (recorded 2026-11-04 at commit `58da1b2`, browser 157.0) on the same build, with nothing changed. Scenarios: PB-PERF-001, PB-PERF-002.

- **False positives (exit code 1): 0 of 5.**
- Exit codes: 0 x 2, 1 x 0, 2 x 3.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm):

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0.000001987 fps / 0 fps | 0 % / 0 % | 0.000001405 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 startupMs, PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames.

> Problem in reports/aa/docker-firefox/1/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 1 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
14 events so far, the last 14:
  #0 t=87.0 media=0.000 load-requested {"uri":"/s/d91166609edf/vod-cmaf/dash/manifest.mpd"}
  #1 t=87.0 media=0.000 buffering-start
  #2 t=102.0 media=0.000 manifest-loaded
  #3 t=107.0 media=0.000 load-requested {"uri":"/s/d91166609edf/vod-cmaf/dash/manifest.mpd"}
  #4 t=108.0 media=0.000 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 t=108.0 media=0.000 buffering-end
  #6 t=109.0 media=0.000 buffering-start
  #7 t=113.0 media=0.000 manifest-loaded
  #8 t=115.0 media=0.000 buffering-start
  #9 t=115.0 media=0.000 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 t=116.0 media=0.000 loaded
  #11 t=119.0 media=0.000 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 t=138.0 media=0.000 playing
  #13 t=139.0 media=0.000 buffering-end
the last events of the player:
  #2 +15 ms media 0.00 manifest-loaded
  #3 +20 ms media 0.00 load-requested {"uri":"/s/d91166609edf/vod-cmaf/dash/manifest.mpd"}
  #4 +21 ms media 0.00 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 +21 ms media 0.00 buffering-end
  #6 +22 ms media 0.00 buffering-start
  #7 +26 ms media 0.00 manifest-loaded
  #8 +28 ms media 0.00 buffering-start
  #9 +28 ms media 0.00 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 +29 ms media 0.00 loaded
  #11 +32 ms media 0.00 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 +51 ms media 0.00 playing
  #13 +52 ms media 0.00 buffering-end

> Problem in reports/aa/docker-firefox/3/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 8 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
14 events so far, the last 14:
  #0 t=91.0 media=0.000 load-requested {"uri":"/s/1865411bc2ca/vod-cmaf/dash/manifest.mpd"}
  #1 t=93.0 media=0.000 buffering-start
  #2 t=110.0 media=0.000 manifest-loaded
  #3 t=120.0 media=0.000 load-requested {"uri":"/s/1865411bc2ca/vod-cmaf/dash/manifest.mpd"}
  #4 t=127.0 media=0.000 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 t=127.0 media=0.000 buffering-end
  #6 t=128.0 media=0.000 buffering-start
  #7 t=133.0 media=0.000 manifest-loaded
  #8 t=136.0 media=0.000 buffering-start
  #9 t=136.0 media=0.000 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 t=137.0 media=0.000 loaded
  #11 t=141.0 media=0.000 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 t=163.0 media=0.000 playing
  #13 t=163.0 media=0.000 buffering-end
the last events of the player:
  #2 +19 ms media 0.00 manifest-loaded
  #3 +29 ms media 0.00 load-requested {"uri":"/s/1865411bc2ca/vod-cmaf/dash/manifest.mpd"}
  #4 +36 ms media 0.00 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 +36 ms media 0.00 buffering-end
  #6 +37 ms media 0.00 buffering-start
  #7 +42 ms media 0.00 manifest-loaded
  #8 +45 ms media 0.00 buffering-start
  #9 +45 ms media 0.00 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 +46 ms media 0.00 loaded
  #11 +50 ms media 0.00 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 +72 ms media 0.00 playing
  #13 +72 ms media 0.00 buffering-end

> Problem in reports/aa/docker-firefox/5/docker-linux-arm64/firefox.json: PB-PERF-002 on firefox, run 6 of 10: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
14 events so far, the last 14:
  #0 t=84.0 media=0.000 load-requested {"uri":"/s/cf3fbb0b6009/vod-cmaf/dash/manifest.mpd"}
  #1 t=85.0 media=0.000 buffering-start
  #2 t=102.0 media=0.000 manifest-loaded
  #3 t=107.0 media=0.000 load-requested {"uri":"/s/cf3fbb0b6009/vod-cmaf/dash/manifest.mpd"}
  #4 t=107.0 media=0.000 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 t=108.0 media=0.000 buffering-end
  #6 t=108.0 media=0.000 buffering-start
  #7 t=113.0 media=0.000 manifest-loaded
  #8 t=116.0 media=0.000 buffering-start
  #9 t=116.0 media=0.000 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 t=117.0 media=0.000 loaded
  #11 t=120.0 media=0.000 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 t=141.0 media=0.000 playing
  #13 t=141.0 media=0.000 buffering-end
the last events of the player:
  #2 +18 ms media 0.00 manifest-loaded
  #3 +23 ms media 0.00 load-requested {"uri":"/s/cf3fbb0b6009/vod-cmaf/dash/manifest.mpd"}
  #4 +23 ms media 0.00 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 +24 ms media 0.00 buffering-end
  #6 +24 ms media 0.00 buffering-start
  #7 +29 ms media 0.00 manifest-loaded
  #8 +32 ms media 0.00 buffering-start
  #9 +32 ms media 0.00 variant-changed {"from":null,"to":1,"bandwidth":746778,"height":360,"reason":"start"}
  #10 +33 ms media 0.00 loaded
  #11 +36 ms media 0.00 variant-changed {"from":1,"to":2,"bandwidth":1845302,"height":720,"reason":"manual"}
  #12 +57 ms media 0.00 playing
  #13 +57 ms media 0.00 buffering-end
