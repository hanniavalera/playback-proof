# A flake, found by the tracker, stopped by the gate, quarantined, and passed

This is a **demonstration with a deliberately injected flake**. It exercises the real flake tools (the Playwright reporter, the collector, the gate, the quarantine list) on a test that is made to fail its first attempt on purpose. It is not a finding about the player, and none of its numbers describe the lab's real tests (those are in [../README.md](../README.md)).

## What was run

A scratch copy of the repository had one extra spec, [`demo-flaky.spec.ts.txt`](demo-flaky.spec.ts.txt) (a real playback test: it opens a session, plays 2 s of media, and then fails its **first attempt in every fourth repetition**; the retry passes). Its title starts with `PB-VOD-001` only so that the gate can find the owner area in the catalog; its history lives in an environment of its own, `demo-deliberate-flake`, and was never mixed with a real history. The spec was never committed to the suite.

```bash
# 25 repetitions of that one test, one retry each, recorded into a history of its own
PB_ENV_ID=demo-deliberate-flake PB_PORT=4790 PB_WORKERS=1 \
  npx tsx tools/flake-collect.ts --project chromium --runs 25 \
  --grep "DEMO deliberately" --history-dir <dir>

# 1. judge the build: the history of 25 runs, this build = repetition 24 (one that flaked)
npx tsx flake/gate.ts --runs reports/flake/collect/run-24.json --store file \
  --history-dir <dir> --env demo-deliberate-flake

# 2. quarantine the test (flake/quarantine.json, see below) and judge the same build again
```

## What happened

| Step | Result | Files |
| --- | --- | --- |
| Collector, 25 repetitions | 25 executions, **6 flaky**, 0 failed (repetitions 4, 8, 12, 16, 20, 24: exactly the injected ones) | [`raw/demo-deliberate-flake.jsonl`](raw/demo-deliberate-flake.jsonl) |
| Gate, test not quarantined | **FAIL, exit 1**: the test is at 24.0 % of its last 25 executions against a trigger of 5.0 %, and the suite flake rate of the engine job is 24.0 % against a budget of 2.0 %. It prints the decision each failure drives: fix the test today or quarantine it today, who decides, the expiry (at most 7 days for a merge-tier test), and what the quarantine entry must contain | [`gate-1-fail.txt`](gate-1-fail.txt), [`gate-1-fail.json`](gate-1-fail.json) |
| Gate, after the quarantine entry | **PASS, exit 0**: the test is still listed as over the trigger, with its owner and expiry, but it is out of the suite rate (0 of 0 executions, 25 left out) | [`gate-2-quarantined-pass.txt`](gate-2-quarantined-pass.txt), [`gate-2-quarantined-pass.json`](gate-2-quarantined-pass.json) |
| The quarantine entry | owner, reason, evidence, `since` and an `expires` six days later | [`quarantine-entry.json`](quarantine-entry.json) |
| The report | per test and per engine job, with the quarantine and the last failure | [`report.md`](report.md), [`report.json`](report.json) |

The quarantined test **still runs**, in the second, non-blocking invocation of `gate:merge`: quarantine removes it from the suite's rate and from the blocking set, not from the record. A quarantine has an owner and an expiry for that reason; on the day after the expiry the gate fails again ([FLAKE.md](../../../FLAKE.md)).

## What this shows, and what it does not

- It shows the **mechanism end to end** on real tools: a flake is invisible to a pass/fail run (every one of these 25 builds was green), visible to the reporter because the retry passed, counted by the collector, and stopped by the gate with a decision attached; the way out is a recorded, owned, expiring quarantine and not a silent retry.
- It does **not** show a flake in the player or in a real test: the failure is injected by the spec, and 25 repetitions of one test say nothing about the rest of the suite.
- It is not a pull request that was blocked: on GitHub the history is the `ci-data` branch and fills one build at a time. The gate is the same code; the history here was collected in one sitting, which is how the lab's real flake data was collected too ([../README.md](../README.md)).
