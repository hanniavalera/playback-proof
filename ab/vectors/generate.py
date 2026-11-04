#!/usr/bin/env python3
"""Reference values for the statistics of the A/B harness (ab/stats), computed with scipy and numpy.

WHY THIS FILE EXISTS. The statistics of ab/stats are written out in TypeScript so that every p-value can be traced to code in this
repository. Written by the same hand as the tests that pin them, they could be wrong together with those tests. These vectors are the
answer of an independent implementation (scipy, numpy) to the same questions on the same inputs, and tests/unit/ab/scipy-vectors.test.ts
compares the TypeScript to them within a stated tolerance.

HOW TO RUN (from the repository root). Python is NOT part of any gate or of CI: the JSON written here is committed data, and this file
documents how it was made. The versions used are written into the JSON, and the test refuses a fixture that does not carry them.

    PYTHONDONTWRITEBYTECODE=1 /tmp/pb-venv/bin/python ab/vectors/generate.py
    npx prettier --write ab/vectors/scipy-vectors.json

The venv holds scipy and numpy and nothing else (statsmodels is not installed, and nothing is to be installed for this).

WHAT IS COMPARED, AND WHAT IS NOT
  erfc, normal cdf / sf / quantile ...... scipy.special.erfc, scipy.stats.norm
  Mann-Whitney U, exact, no ties ........ scipy.stats.mannwhitneyu(method='exact'): its two-sided p is twice the upper tail of the larger U,
                                          which for the symmetric null distribution of untied data is P(|U - mu| >= |u - mu|)
  Mann-Whitney U, asymptotic ............ scipy.stats.mannwhitneyu(method='asymptotic', use_continuity=True): tie-corrected variance
  Mann-Whitney U, exact, WITH ties ...... scipy.stats.permutation_test over every assignment (n_resamples=inf), statistic |U1 - n1 n2 / 2|,
                                          because scipy's method='exact' ignores ties
  Fisher's exact test ................... scipy.stats.fisher_exact (two-sided; it tolerates a relative 1e-7 when comparing probabilities)
  Wilson, Clopper-Pearson ............... scipy.stats.binomtest(k, n).proportion_ci(method='wilson' | 'exact')
  Newcombe's hybrid score interval ...... NOT in scipy (statsmodels has it, and it is not installed): assembled here, in Python, from
                                          scipy's Wilson intervals with Newcombe's (1998) formula, and checked against his published
                                          example (56/70 against 48/80: 0.2, 0.0524 to 0.3339)
  Hodges-Lehmann shift .................. numpy.median(numpy.subtract.outer(b, a))
  quantile (Hyndman and Fan type 7) ..... numpy.quantile(method='linear')
  Cliff's delta ......................... numpy.sign(numpy.subtract.outer(b, a)).mean()
  bootstrap interval of the shift ....... scipy.stats.bootstrap(method='percentile'): another generator, so the two intervals agree only
                                          up to Monte Carlo error, and the test says how much room it allows and why
  NOT compared: Holm's step-down correction (scipy has no such function; it is checked against the worked example of the literature and by
  property tests in proportions.test.ts).
"""

import json
import os
import sys

import numpy as np
import scipy
from scipy import special, stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "scipy-vectors.json")

SEEDS = {
    "mannWhitneyExactUntied": 20261101,
    "mannWhitneyAsymptoticUntied": 20261102,
    "mannWhitneyAsymptoticTied": 20261103,
    "mannWhitneyExactTied": 20261104,
    "fisher": 20261105,
    "hodgesLehmannAndCliff": 20261106,
    "quantile": 20261107,
    "newcombe": 20261108,
    "bootstrapScipy": 20261109,
}


def finite(value):
    value = float(value)
    assert np.isfinite(value), value
    return value


def lognormal(rng, n, median, sigma, decimals=3):
    return [round(float(v), decimals) for v in median * np.exp(sigma * rng.standard_normal(n))]


def untied_pair(rng, n1, n2, shift):
    """Two right-skewed samples (startup times, in ms) with no value occurring twice; B is `shift` times slower than A."""
    while True:
        x = lognormal(rng, n1, 1000.0, 0.25)
        y = lognormal(rng, n2, 1000.0 * shift, 0.25)
        if len(set(x + y)) == n1 + n2:
            return x, y


def counts_pair(rng, n1, n2, rate_a, rate_b, top=None):
    """Two samples of small whole numbers (rebuffer counts: mostly zero), with many ties."""
    x = [int(v) for v in rng.poisson(rate_a, n1)]
    y = [int(v) for v in rng.poisson(rate_b, n2)]
    if top is not None:
        x = [min(v, top) for v in x]
        y = [min(v, top) for v in y]
    return x, y


def u_deviation(x, y, axis=-1):
    """|U1 - n1 n2 / 2|, vectorised over the leading axes (U1 counts a tie as one half)."""
    assert axis == -1
    xx = x[..., :, None]
    yy = y[..., None, :]
    u1 = (xx > yy).sum(axis=(-2, -1)) + 0.5 * (xx == yy).sum(axis=(-2, -1))
    return np.abs(u1 - x.shape[-1] * y.shape[-1] / 2)


def exact_p_by_enumeration(x, y):
    """Two-sided exact p of the Mann-Whitney test conditional on the observed ties, by enumerating every assignment."""
    result = stats.permutation_test(
        (np.array(x, dtype=float), np.array(y, dtype=float)),
        u_deviation,
        permutation_type="independent",
        alternative="greater",
        n_resamples=np.inf,
        vectorized=True,
    )
    return finite(result.pvalue)


# ---------------------------------------------------------------------------------------------------------------------------------------
# the normal distribution


def normal_vectors():
    erfc_x = [0.0, 1e-8, 0.1, 0.5, 1.0, 1.5, 1.9999, 2.0, 2.0001, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 20.0, 26.0, -0.5, -2.0, -5.0]
    z_values = [-8.0, -5.0, -3.0, -1.96, -1.0, 0.0, 0.5, 1.0, 1.6448536269514722, 1.96, 2.5, 3.0, 5.0, 8.0]
    quantile_p = [1e-10, 1e-6, 0.001, 0.025, 0.05, 0.1, 0.5, 0.9, 0.95, 0.975, 0.995, 0.999, 1 - 1e-6]
    return {
        "erfc": [{"x": x, "value": finite(special.erfc(x))} for x in erfc_x],
        "cdf": [
            {
                "z": z,
                "cdf": finite(stats.norm.cdf(z)),
                "survival": finite(stats.norm.sf(z)),
                "twoSided": finite(2 * stats.norm.sf(abs(z))),
            }
            for z in z_values
        ],
        "quantile": [{"p": p, "z": finite(stats.norm.ppf(p))} for p in quantile_p],
    }


# ---------------------------------------------------------------------------------------------------------------------------------------
# the Mann-Whitney test


def mann_whitney_exact_untied():
    rng = np.random.default_rng(SEEDS["mannWhitneyExactUntied"])
    sizes = [(3, 3), (4, 6), (5, 5), (7, 9), (8, 8), (10, 12), (12, 12), (15, 10), (20, 20), (25, 15)]
    shifts = [1.0, 1.4, 1.0, 1.25, 1.15, 0.85, 1.3, 1.0, 1.1, 0.9]
    out = []
    for (n1, n2), shift in zip(sizes, shifts):
        x, y = untied_pair(rng, n1, n2, shift)
        result = stats.mannwhitneyu(x, y, alternative="two-sided", method="exact")
        entry = {"x": x, "y": y, "u1": finite(result.statistic), "p": finite(result.pvalue)}
        if n1 + n2 <= 16:
            # The claim in the header: scipy's exact p equals the two-sided permutation p for untied data. Checked where it is cheap.
            assert abs(entry["p"] - exact_p_by_enumeration(x, y)) < 1e-12, (x, y)
        out.append(entry)
    return out


def mann_whitney_asymptotic_untied():
    rng = np.random.default_rng(SEEDS["mannWhitneyAsymptoticUntied"])
    sizes = [(30, 30), (40, 25), (60, 60), (13, 40), (100, 100), (30, 30)]
    shifts = [1.0, 1.1, 0.95, 1.2, 1.05, 1.0]
    out = []
    for (n1, n2), shift in zip(sizes, shifts):
        x, y = untied_pair(rng, n1, n2, shift)
        result = stats.mannwhitneyu(x, y, alternative="two-sided", method="asymptotic", use_continuity=True)
        out.append({"x": x, "y": y, "u1": finite(result.statistic), "p": finite(result.pvalue)})
    return out


def mann_whitney_asymptotic_tied():
    rng = np.random.default_rng(SEEDS["mannWhitneyAsymptoticTied"])
    cases = [
        (30, 30, 0.3, 0.3, None),
        (30, 30, 0.3, 1.0, None),
        (25, 40, 0.6, 0.9, None),
        (20, 20, 1.5, 1.5, 6),
        (50, 10, 0.4, 2.0, None),
        (60, 60, 3.0, 3.6, 8),
        (30, 30, 0.1, 0.1, None),
    ]
    out = []
    for n1, n2, rate_a, rate_b, top in cases:
        x, y = counts_pair(rng, n1, n2, rate_a, rate_b, top)
        if len(set(x + y)) < 2:
            x[0] += 1
        result = stats.mannwhitneyu(x, y, alternative="two-sided", method="asymptotic", use_continuity=True)
        out.append({"x": x, "y": y, "u1": finite(result.statistic), "p": finite(result.pvalue)})
    return out


def mann_whitney_exact_tied():
    rng = np.random.default_rng(SEEDS["mannWhitneyExactTied"])
    cases = [(4, 4, 0.6, 1.2), (5, 6, 0.5, 0.5), (6, 6, 0.8, 1.8), (7, 8, 0.4, 1.4), (8, 8, 1.0, 1.0), (3, 9, 0.7, 1.6), (8, 7, 0.3, 2.2)]
    out = []
    for n1, n2, rate_a, rate_b in cases:
        while True:
            x, y = counts_pair(rng, n1, n2, rate_a, rate_b, top=4)
            if 2 <= len(set(x + y)) < n1 + n2:
                break
        xa, ya = np.array(x), np.array(y)
        u1 = float((xa[:, None] > ya[None, :]).sum() + 0.5 * (xa[:, None] == ya[None, :]).sum())
        out.append({"x": x, "y": y, "u1": u1, "p": exact_p_by_enumeration(x, y)})
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------
# Fisher's exact test


def fisher_vectors():
    rng = np.random.default_rng(SEEDS["fisher"])
    tables = [
        (3, 4, 1, 4),  # the lady tasting tea: 3 of 4 against 1 of 4, p = 17 / 35
        (0, 10, 10, 10),
        (10, 10, 0, 10),
        (0, 30, 0, 30),
        (30, 30, 30, 30),
        (5, 30, 5, 30),
        (1, 1, 0, 1),
        (1, 2, 1, 2),
        (0, 5, 100, 100),
        (2, 30, 14, 30),
        (6, 30, 7, 30),
        (0, 5, 3, 100),
        (13, 20, 4, 20),
        (50, 500, 80, 500),
    ]
    for _ in range(40):
        a_total = int(rng.integers(3, 61))
        b_total = int(rng.integers(3, 61))
        tables.append((int(rng.integers(0, a_total + 1)), a_total, int(rng.integers(0, b_total + 1)), b_total))
    vectors = []
    for a_events, a_total, b_events, b_total in tables:
        result = stats.fisher_exact([[a_events, a_total - a_events], [b_events, b_total - b_events]], alternative="two-sided")
        vectors.append({"a": {"events": a_events, "total": a_total}, "b": {"events": b_events, "total": b_total}, "p": finite(result.pvalue)})
    assert abs(vectors[0]["p"] - 17 / 35) < 1e-12, vectors[0]
    return vectors


# ---------------------------------------------------------------------------------------------------------------------------------------
# intervals for proportions


PROPORTIONS = [
    (0, 1),
    (1, 1),
    (1, 2),
    (0, 10),
    (1, 10),
    (5, 10),
    (9, 10),
    (10, 10),
    (0, 30),
    (3, 30),
    (15, 30),
    (27, 30),
    (30, 30),
    (34, 1000),
    (78, 1000),
    (100, 2000),
    (117, 2000),
    (0, 2000),
    (2000, 2000),
]
LEVELS = [0.9, 0.95, 0.99]


def interval(method, k, n, level):
    ci = stats.binomtest(k, n).proportion_ci(confidence_level=level, method=method)
    return finite(ci.low), finite(ci.high)


def proportion_vectors():
    wilson, clopper = [], []
    for k, n in PROPORTIONS:
        for level in LEVELS:
            low, high = interval("wilson", k, n, level)
            wilson.append({"events": k, "total": n, "level": level, "lower": low, "upper": high})
            low, high = interval("exact", k, n, level)
            clopper.append({"events": k, "total": n, "level": level, "lower": low, "upper": high})
    return wilson, clopper


def newcombe_from_scipy_wilson(a_events, a_total, b_events, b_total, level):
    """Newcombe (1998), method 10, for p_B - p_A, from scipy's Wilson intervals."""
    share_a = a_events / a_total
    share_b = b_events / b_total
    lower_a, upper_a = interval("wilson", a_events, a_total, level)
    lower_b, upper_b = interval("wilson", b_events, b_total, level)
    difference = share_b - share_a
    lower = difference - np.sqrt((share_b - lower_b) ** 2 + (upper_a - share_a) ** 2)
    upper = difference + np.sqrt((upper_b - share_b) ** 2 + (share_a - lower_a) ** 2)
    return finite(difference), finite(lower), finite(upper)


def newcombe_vectors():
    rng = np.random.default_rng(SEEDS["newcombe"])
    cases = [(48, 80, 56, 70, 0.95), (0, 30, 0, 30, 0.95), (0, 30, 30, 30, 0.95), (2, 30, 14, 30, 0.95), (6, 30, 7, 30, 0.9), (10, 30, 3, 30, 0.99)]
    for _ in range(30):
        a_total = int(rng.integers(5, 61))
        b_total = int(rng.integers(5, 61))
        cases.append((int(rng.integers(0, a_total + 1)), a_total, int(rng.integers(0, b_total + 1)), b_total, 0.95))
    out = []
    for a_events, a_total, b_events, b_total, level in cases:
        difference, lower, upper = newcombe_from_scipy_wilson(a_events, a_total, b_events, b_total, level)
        out.append(
            {
                "a": {"events": a_events, "total": a_total},
                "b": {"events": b_events, "total": b_total},
                "level": level,
                "difference": difference,
                "lower": lower,
                "upper": upper,
            }
        )
    published = out[0]
    assert round(published["difference"], 4) == 0.2 and round(published["lower"], 4) == 0.0524 and round(published["upper"], 4) == 0.3339, published
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------
# effect sizes and quantiles


def effect_vectors():
    rng = np.random.default_rng(SEEDS["hodgesLehmannAndCliff"])
    pairs = []
    for n1, n2, shift in [(5, 7, 1.2), (10, 10, 1.0), (30, 30, 0.8), (31, 30, 1.3), (2, 3, 1.0), (1, 1, 1.0), (30, 30, 1.05)]:
        pairs.append(untied_pair(rng, n1, n2, shift))
    for n1, n2, rate_a, rate_b in [(30, 30, 0.3, 0.9), (20, 25, 1.0, 1.0), (12, 12, 2.0, 0.5)]:
        pairs.append(counts_pair(rng, n1, n2, rate_a, rate_b))
    out = []
    for x, y in pairs:
        differences = np.subtract.outer(np.array(y, dtype=float), np.array(x, dtype=float))
        out.append(
            {
                "a": x,
                "b": y,
                "hodgesLehmann": finite(np.median(differences)),
                "cliffsDelta": finite(np.sign(differences).mean()),
            }
        )
    return out


def quantile_vectors():
    rng = np.random.default_rng(SEEDS["quantile"])
    probabilities = [0.0, 0.05, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1.0]
    out = []
    for n in [1, 2, 3, 7, 10, 30, 31, 100]:
        values = sorted(lognormal(rng, n, 1000.0, 0.4))
        out.append(
            {
                "sorted": values,
                "quantiles": [{"p": p, "value": finite(np.quantile(np.array(values), p, method="linear"))} for p in probabilities],
            }
        )
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------
# the bootstrap interval of the shift: another generator, so an agreement up to Monte Carlo error


def shift_statistic(a, b, axis=-1):
    assert axis == -1
    differences = b[..., None, :] - a[..., :, None]
    return np.median(differences.reshape(differences.shape[:-2] + (-1,)), axis=-1)


BOOTSTRAP_RESAMPLES = 9999


def bootstrap_vectors():
    rng = np.random.default_rng(SEEDS["bootstrapScipy"])
    out = []
    for n1, n2, shift in [(30, 30, 1.15), (30, 30, 1.0), (20, 35, 0.9)]:
        x, y = untied_pair(rng, n1, n2, shift)
        result = stats.bootstrap(
            (np.array(x, dtype=float), np.array(y, dtype=float)),
            shift_statistic,
            vectorized=True,
            paired=False,
            n_resamples=BOOTSTRAP_RESAMPLES,
            confidence_level=0.95,
            method="percentile",
            batch=1000,
            rng=np.random.default_rng(int(rng.integers(1, 2**31))),
        )
        out.append(
            {
                "a": x,
                "b": y,
                "level": 0.95,
                "scipyResamples": BOOTSTRAP_RESAMPLES,
                "estimate": finite(np.median(np.subtract.outer(np.array(y), np.array(x)))),
                "lower": finite(result.confidence_interval.low),
                "upper": finite(result.confidence_interval.high),
            }
        )
    return out


def main():
    wilson, clopper = proportion_vectors()
    vectors = {
        "generatedBy": {
            "script": "ab/vectors/generate.py",
            "command": "PYTHONDONTWRITEBYTECODE=1 /tmp/pb-venv/bin/python ab/vectors/generate.py && npx prettier --write ab/vectors/scipy-vectors.json",
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "seeds": SEEDS,
            "note": "Reference values of an independent implementation for the statistics of ab/stats. Committed data: python is not part of any gate or of CI. See the header of the script for what each block is compared with.",
        },
        "normal": normal_vectors(),
        "mannWhitney": {
            "exactUntied": mann_whitney_exact_untied(),
            "asymptoticUntied": mann_whitney_asymptotic_untied(),
            "asymptoticTied": mann_whitney_asymptotic_tied(),
            "exactTied": mann_whitney_exact_tied(),
        },
        "fisher": fisher_vectors(),
        "wilson": wilson,
        "clopperPearson": clopper,
        "newcombe": newcombe_vectors(),
        "effects": effect_vectors(),
        "quantile": quantile_vectors(),
        "bootstrap": bootstrap_vectors(),
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(vectors, indent=2, allow_nan=False) + "\n")
    counts = {
        key: (len(value) if isinstance(value, list) else {k: len(v) for k, v in value.items()})
        for key, value in vectors.items()
        if key != "generatedBy"
    }
    print("wrote", os.path.relpath(OUT), "with scipy", scipy.__version__, "and numpy", np.__version__)
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
