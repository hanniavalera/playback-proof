## A/A calibration (PB-AB-001): the false-positive rate of the harness

A pool of 60 sessions of configuration A was split at random into two arms of 30, 2000 times, and the full pipeline (tests, Holm over the primary family, bootstrap intervals, decision rule) was applied to each split. Every split compares two samples of the same configuration, so every significant one is a false positive.

**PASS: The harness declared 0.00 % (0 of 2000; 95 % interval 0.00 to 0.18 %) of the splits of identical sessions significant: not above the significance level of 5 %, and well below it: it is safe and conservative, so it will under-detect rather than over-claim.**

| | |
| --- | --- |
| Splits declared significant (any primary metric, Holm-adjusted p < 0.05) | 0 of 2000 = 0.00 % |
| Exact binomial interval (95 %) | 0.00 % to 0.18 % |
| Required | the lower end of the interval at or below 5 % |
| Verdicts over the splits | B better 0, A better 0 (both are false alarms between identical sessions), equivalent within the margin 2000, inconclusive 0 |

Share of splits in which the raw p-value of a primary metric was below a level (a valid test has each at most its level):

| Metric | p < 0.01 | p < 0.05 | p < 0.10 | p < 0.25 |
| --- | --- | --- | --- | --- |
| rebufferShare | 0.0 % | 0.0 % | 0.0 % | 0.0 % |

What this checks and what it does not: the statistics, given these sessions. The splits share their sessions, so the interval describes the splits drawn, not the pool; and a random split mixes away the order of the sessions, so a drift of the machine over time is invisible here. The real interleaved A/A run checks the procedure.
