## Performance gate: chromium in `local-darwin-arm64`: PROBLEM

Baseline recorded 2026-11-04 at commit `7389861` (10 runs per scenario, browser 156.0.8078.4). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.

### PB-PERF-002 frame-rate: problem

> **Problem:** PB-PERF-002 on chromium, the warm-up run: qa.waitFor('firstframe'): qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).
13 events so far, the last 13:
  #0 t=1374.6 media=0.000 load-requested {"uri":"/s/116b7cd51f12/vod-cmaf/dash/manifest.mpd"}
  #1 t=1399.5 media=0.000 buffering-start
  #2 t=1661.9 media=0.000 manifest-loaded
  #3 t=1701.4 media=0.000 load-requested {"uri":"/s/116b7cd51f12/vod-cmaf/dash/manifest.mpd"}
  #4 t=1728.5 media=0.000 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 t=1741.8 media=0.000 buffering-end
  #6 t=1747.3 media=0.000 buffering-start
  #7 t=1817.0 media=0.000 manifest-loaded
  #8 t=1887.4 media=0.000 buffering-start
  #9 t=1895.1 media=0.000 variant-changed {"from":null,"to":2,"bandwidth":1845302,"height":720,"reason":"start"}
  #10 t=1916.7 media=0.000 loaded
  #11 t=2248.8 media=0.017 playing
  #12 t=2253.4 media=0.022 buffering-end
the last events of the player:
  #1 +25 ms media 0.00 buffering-start
  #2 +287 ms media 0.00 manifest-loaded
  #3 +327 ms media 0.00 load-requested {"uri":"/s/116b7cd51f12/vod-cmaf/dash/manifest.mpd"}
  #4 +354 ms media 0.00 error {"code":7000,"codeName":"LOAD_INTERRUPTED","category":7,"severity":2,"message":"PLAYER.LOAD_INTERRUPTED: Shaka Error 7000","source":"load"}
  #5 +367 ms media 0.00 buffering-end
  #6 +373 ms media 0.00 buffering-start
  #7 +442 ms media 0.00 manifest-loaded
  #8 +513 ms media 0.00 buffering-start
  #9 +521 ms media 0.00 variant-changed {"from":null,"to":2,"bandwidth":1845302,"height":720,"reason":"start"}
  #10 +542 ms media 0.00 loaded
  #11 +874 ms media 0.02 playing
  #12 +879 ms media 0.02 buffering-end

> Warning: THE CPU THROTTLE WAS REPLACED ON PURPOSE by 20x in every session: this is a sensitivity check of the gate, not a measurement of the build
