# Playback Proof

A test lab for a web video player, built to show how streaming playback is tested end to end: deterministic streams with fault
injection, cross-browser suites, performance baselines that gate merges, A/B comparison of player configurations, live-event readiness, flake
tracking and failure triage.

> Work in progress. The README is completed in the final phase with the architecture, how to run everything, and results from real runs.
> Until then see [docs/CONTRACTS.md](docs/CONTRACTS.md), [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) and [docs/METRICS.md](docs/METRICS.md).

Stack: TypeScript, Node.js, Shaka Player, Playwright, Vitest, ffmpeg.
