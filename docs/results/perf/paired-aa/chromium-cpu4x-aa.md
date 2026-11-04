## A/A check: chromium-cpu4x in `gha-linux-x64`

The **paired** gate was run **18 times**: each pass measured its control (commit `b971ed3f223f`) with the control's own harness on the machine it ran on, minutes before the head (commit `b971ed3f223f`), and judged the head against it (an A/A by construction: the control is the head), with nothing changed. The committed baselines were not used. Scenarios: PB-PERF-004.

- **False positives (exit code 1): 0 of 18.**
- Exit codes: 0 x 18, 1 x 0, 2 x 0.
- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 0; of those 0 did not reproduce.
- CPU models: the baseline was recorded on AMD EPYC 9V74 80-Core Processor. The passes ran on 4 distinct CPU models: AMD EPYC 7763 64-Core Processor (6 passes), Intel(R) Xeon(R) 6975P-C (6 passes), AMD EPYC 9V74 80-Core Processor (3 passes), Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz (3 passes). The passes did not all run on the same machine, so the spread between them includes the difference between machines.

How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm), each pass against its own control; the baseline, CV and allowed columns are those of the first pass that had a control:

| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PERF-004 | startupMs | 203.6 ms / 220.5 ms | 9.2 % | 61.08 ms / 66.15 ms | 7.35 ms / 18.58 ms | 13 % / 34 % | 34.3 ms (16.8 %) |
| PB-PERF-004 | droppedRatio | 0 / 0 | - | 0.02 / 0.05 | 0 / 0 | 0 % / 0 % | 0 |

Tracked, not gated: PB-PERF-004 manifestMs, PB-PERF-004 loadedMs, PB-PERF-004 fps, PB-PERF-004 decodedFrames, PB-PERF-004 droppedFrames.

Every pass, in the order it was measured (startup is PB-PERF-004 startupMs: the median of the first batch of the pass against the median of the baseline):

| pass | verdict | CPU model | startup median vs baseline median | deviation |
| --- | --- | --- | --- | --- |
| 1 | pass | AMD EPYC 9V74 80-Core Processor | 203.6 ms vs 203.6 ms | +0.0 % |
| 2 | pass | AMD EPYC 7763 64-Core Processor | 249.1 ms vs 254.8 ms | -2.2 % |
| 3 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 250.7 ms vs 255.5 ms | -1.9 % |
| 4 | pass | AMD EPYC 7763 64-Core Processor | 250.4 ms vs 250 ms | +0.1 % |
| 5 | pass | Intel(R) Xeon(R) 6975P-C | 178.1 ms vs 182.2 ms | -2.3 % |
| 6 | pass | Intel(R) Xeon(R) 6975P-C | 180.1 ms vs 173.2 ms | +4.0 % |
| 7 | pass | AMD EPYC 9V74 80-Core Processor | 207.5 ms vs 201.2 ms | +3.1 % |
| 8 | pass | AMD EPYC 7763 64-Core Processor | 242.1 ms vs 243.7 ms | -0.7 % |
| 9 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 248.2 ms vs 248.6 ms | -0.1 % |
| 10 | pass | AMD EPYC 7763 64-Core Processor | 254.6 ms vs 247.3 ms | +3.0 % |
| 11 | pass | Intel(R) Xeon(R) 6975P-C | 185 ms vs 186.4 ms | -0.8 % |
| 12 | pass | Intel(R) Xeon(R) 6975P-C | 171.8 ms vs 166.5 ms | +3.2 % |
| 13 | pass | AMD EPYC 9V74 80-Core Processor | 208.7 ms vs 201.4 ms | +3.6 % |
| 14 | pass | AMD EPYC 7763 64-Core Processor | 248.8 ms vs 252.9 ms | -1.6 % |
| 15 | pass | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 255.2 ms vs 255.1 ms | +0.0 % |
| 16 | pass | AMD EPYC 7763 64-Core Processor | 252.9 ms vs 249.8 ms | +1.3 % |
| 17 | pass | Intel(R) Xeon(R) 6975P-C | 179.7 ms vs 181.2 ms | -0.8 % |
| 18 | pass | Intel(R) Xeon(R) 6975P-C | 168.8 ms vs 170.9 ms | -1.2 % |
