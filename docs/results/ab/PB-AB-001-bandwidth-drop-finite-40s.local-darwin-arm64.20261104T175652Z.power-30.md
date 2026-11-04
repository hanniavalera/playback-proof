# Power of PB-AB-001-bandwidth-drop-finite-40s under bandwidth-drop-finite

60 sessions of configuration A, 1000 simulated experiments per estimate, seed 20261113. A simulated experiment resamples the pilot into two arms of 30 and moves one by the shift; "detects" means the test of the harness finds a difference at alpha 0.05 (ab/power.ts).

| Metric | Pilot sessions | Pilot, A alone | Minimum detectable effect (30 per arm, 80 % power) | Practical threshold | Sessions per arm to detect the threshold | Says "equivalent within the margin" when the arms are the same | Calls B better when B is better by the threshold | Calls A better when B is worse by the threshold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Share of sessions with a rebuffer | 60 | share 0 % | 25.2 pp | 20 pp | 40 | 100 % | 0 % | 37 % |

The last three columns run the whole decision rule on simulated experiments (a few hundred, so a few points of Monte Carlo error): they say what this design can ever conclude. A threshold below the minimum detectable effect is a difference the design cannot find; a threshold barely above it can rarely be shown to be beyond, because the rule wants the whole interval past the threshold. The first of the three is the only column that can say there is no meaningful difference, and it needs the whole interval inside the margin.
