# Failure triage

**0 failed, 1 flaky in 4 reports became 1 cluster.** The clusters are deterministic (one signature, one cluster: the same cause whatever its ids, ports and timestamps); the category is the first rule of a table that fits, with the evidence it found. triage is not a gate: it explains a red build and never decides one.

| # | Failures | Engines | Tests | Category · rule | Class | Error |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | webkit | PB-ABR-002 | `unknown` · `no-rule-matched` | Flake | Error: rung changes of the load (qa.events()): 360p start at 0.00 s, 720p abr at 0.43 s, 360p abr at 18.23 s, 240p abr … |

## #1 · 1 failure · unknown

- **Signature** `Error: rung changes of the load (qa.events()): <n>p start at <n> s, <n>p abr at <n> s, <n>p abr at <n> s, <n>p abr at <n> s. Each segment of a rung that the <n> kbps link does not carry takes longer … [toBeLessThanOrEqual]` (key `6786aa8927d7`)
- **Engines** webkit · **tests** PB-ABR-002 · **outcomes** failed 0, timed out 0, flaky 1
- **Category** `unknown`: No rule matched. A person has to read the failure.
- **Rule** `no-rule-matched`: No rule of the table recognised this failure: the message and the attachments have to be read.
- **Class** Flake (TEST_STRATEGY.md section 10)
- **Evidence** (what the rule found: check it against the attachments, and disagree with it if it is wrong):
  - no rule matched “Error: rung changes of the load (qa.events()): 360p start at 0.00 s, 720p abr at 0.43 s, 360p abr at 18.23 s, 240p abr at 22.70 s. Each segment of a rung that the 600 kbps link does not carry takes longer to arrive than…”
- **First thing to check** Do not rerun the job: it passed on the retry, and a retried pass is not a pass. Read the trace of the first failed attempt, not the green retry. The message, the stack and the attachments of the representative failure; if it recurs, add a rule for it (docs/TRIAGE.md).
- **Representative failure** PB-ABR-002 on webkit: flaky, 2 attempts of 2, merge tier, gha-linux-x64, from `reports-webkit-macos/reports/playwright.json`

```text
Error: rung changes of the load (qa.events()): 360p start at 0.00 s, 720p abr at 0.43 s, 360p abr at 18.23 s, 240p abr at 22.70 s. Each segment of a rung that the 600 kbps link does not carry takes longer to arrive than it plays, so whether the player stalls depends on how early it left the rung it…
rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 889 ms: at media time 20.00 s for 524 ms; at media time 22.00 s for 365 ms

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 1
Received:    2
```

Frames of the lab's own code: `tests/e2e/abr.spec.ts:205`

## Reports read

| Report | Tests | Passed | Failed | Flaky | Skipped | Not run | Interrupted | Run errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reports-chromium/reports/playwright.json | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| reports-chromium-cpu4x/reports/playwright.json | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| reports-webkit-linux/reports/playwright.json | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| reports-webkit-macos/reports/playwright.json | 15 | 14 | 0 | 1 | 0 | 0 | 0 | 0 |

---

No model summaries: they are opt-in (`npm run triage -- --summarize`, with `ANTHROPIC_API_KEY`).

Generated 2026-11-04T18:57:07.057Z from `<path>/artifacts` by `triage/` (docs/TRIAGE.md).
