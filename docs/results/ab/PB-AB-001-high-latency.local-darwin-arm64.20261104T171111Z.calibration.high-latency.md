## A/A calibration (PB-AB-001): the false-positive rate of the harness

A pool of 60 sessions of configuration A was split at random into two arms of 30, 2000 times, and the full pipeline (tests, Holm over the primary family, bootstrap intervals, decision rule) was applied to each split. Every split compares two samples of the same configuration, so every significant one is a false positive.

**PASS: The harness declared 5.00 % (100 of 2000; 95 % interval 4.09 to 6.05 %) of the splits of identical sessions significant: not above the significance level of 5 %.**

| | |
| --- | --- |
| Splits declared significant (any primary metric, Holm-adjusted p < 0.05) | 100 of 2000 = 5.00 % |
| Exact binomial interval (95 %) | 4.09 % to 6.05 % |
| Required | the lower end of the interval at or below 5 % |
| Verdicts over the splits | B better 0, A better 0 (both are false alarms between identical sessions), equivalent within the margin 1998, inconclusive 2 |

Share of splits in which the raw p-value of a primary metric was below a level (a valid test has each at most its level):

| Metric | p < 0.01 | p < 0.05 | p < 0.10 | p < 0.25 |
| --- | --- | --- | --- | --- |
| startupMs | 0.9 % | 5.0 % | 10.0 % | 24.3 % |

What this checks and what it does not: the statistics, given these sessions. The splits share their sessions, so the interval describes the splits drawn, not the pool; and a random split mixes away the order of the sessions, so a drift of the machine over time is invisible here. The real interleaved A/A run checks the procedure.
