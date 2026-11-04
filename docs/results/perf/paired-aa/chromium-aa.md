## A/A check: chromium in `gha-linux-x64`

The **paired** gate was run **18 times**: each pass measured its control (commit `b971ed3f223f`) with the control's own harness on the machine it ran on, minutes before the head (commit `b971ed3f223f`), and judged the head against it (an A/A by construction: the control is the head), with nothing changed. The committed baselines were not used. Scenarios: PB-PERF-001, PB-PERF-002, PB-PERF-003.

- **False positives (exit code 1): 0 of 18.**
- Exit codes: 0 x 18, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.
- CPU models: the baseline was recorded on Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz. The passes ran on 5 distinct CPU models: AMD EPYC 7763 64-Core Processor (6 passes), AMD EPYC 9V74 80-Core Processor (3 passes), Intel(R) Xeon(R) 6975P-C (3 passes), Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz (3 passes), INTEL(R) XEON(R) PLATINUM 8573C (3 passes). The passes did not all run on the same machine, so the spread between them includes the difference between machines.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm), each pass against its own control; the baseline, CV and allowed columns are those of the first pass that had a control:

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-001 | startupMs | 71.15 ms / 80.58 ms | 7.8 % | 21.34 ms / 24.17 ms | 9.9 ms / 7.25 ms | 49 % / 33 % | 9.504 ms (13.4 %) |
| PB-PERF-002 | fps | 30 fps / 30 fps | 0.0 % | 1.5 fps / 3 fps | 0 fps / 0 fps | 0 % / 0 % | 0 fps (0.0 %) |
| PB-PERF-002 | droppedRatio | 0 / 0 | - | 0.01 / 0.03 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferCount | 0 / 0 | - | 0 / 1 | 0 / 0 | 0 % / 0 % | 0 |
| PB-PERF-003 | rebufferMs | 0 ms / 0 ms | - | 250 ms / 1000 ms | 0 ms / 0 ms | 0 % / 0 % | 0 ms |
| PB-PERF-003 | rebufferRatio | 0 / 0 | - | 0.01 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-001 manifestMs, PB-PERF-001 loadedMs, PB-PERF-002 decodedFrames, PB-PERF-002 droppedFrames, PB-PERF-003 switches.

Every pass, in the order it was measured (startup is PB-PERF-001 startupMs: the median of the first batch of the pass against the median of the baseline):

| pass | verdict | CPU model | startup median vs baseline median | deviation |
| --- | --- | --- | --- | --- |
| 1 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 77.25 ms vs 71.15 ms | +8.6 % |
| 2 | pass | INTEL(R) XEON(R) PLATINUM 8573C | 77.9 ms vs 68 ms | +14.6 % |
| 3 | pass | AMD EPYC 7763 64-Core Processor | 74.85 ms vs 76.4 ms | -2.0 % |
| 4 | pass | Intel(R) Xeon(R) 6975P-C | 52.1 ms vs 54.6 ms | -4.6 % |
| 5 | pass | AMD EPYC 7763 64-Core Processor | 75.2 ms vs 70.05 ms | +7.4 % |
| 6 | pass | AMD EPYC 9V74 80-Core Processor | 60.75 ms vs 61.45 ms | -1.1 % |
| 7 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 76.75 ms vs 77.75 ms | -1.3 % |
| 8 | pass | INTEL(R) XEON(R) PLATINUM 8573C | 73.55 ms vs 78.2 ms | -5.9 % |
| 9 | pass | AMD EPYC 7763 64-Core Processor | 77.55 ms vs 77.5 ms | +0.1 % |
| 10 | pass | Intel(R) Xeon(R) 6975P-C | 52 ms vs 55.5 ms | -6.3 % |
| 11 | pass | AMD EPYC 7763 64-Core Processor | 70.5 ms vs 73.95 ms | -4.7 % |
| 12 | pass | AMD EPYC 9V74 80-Core Processor | 63.8 ms vs 63.5 ms | +0.5 % |
| 13 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 71.85 ms vs 69.5 ms | +3.4 % |
| 14 | pass | INTEL(R) XEON(R) PLATINUM 8573C | 71.8 ms vs 70.1 ms | +2.4 % |
| 15 | pass | Intel(R) Xeon(R) 6975P-C | 51 ms vs 54.55 ms | -6.5 % |
| 16 | pass | AMD EPYC 7763 64-Core Processor | 77.25 ms vs 79.45 ms | -2.8 % |
| 17 | pass | AMD EPYC 7763 64-Core Processor | 69.5 ms vs 77.55 ms | -10.4 % |
| 18 | pass | AMD EPYC 9V74 80-Core Processor | 59.75 ms vs 65.05 ms | -8.1 % |
