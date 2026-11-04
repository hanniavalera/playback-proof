# Readiness results: the manifest

The first evidence of the live-event readiness checks (PB-RDY-001 to PB-RDY-004, in this directory) and of the soak (PB-RDY-005, in
[`../soak`](../soak)): 18 result files that `measure.yml` wrote on GitHub's hosted runners, one job each, all on commit `0d62c1d` of `main`
(clean). The analysis is [docs/READINESS.md](../../READINESS.md); the decisions are in
[readiness-evidence.md](../../decisions/readiness-evidence.md). This page says only where each file comes from.

**Rules this evidence is kept under.**

- **No file is edited.** Each is byte for byte what its job uploaded: the SHA-256 of the uploaded file is in the table below and in
  [`../provenance/runs.json`](../provenance/runs.json), and the unit suite compares them (`tests/unit/readiness/evidence.test.ts`). A number is
  never corrected here; a wrong measurement is re-measured and its file replaced with the new run's.
- **Two environments, two tables.** `gha-linux-x64` and `gha-macos-arm64` are never merged in one row or compared in one table. Inside
  `gha-linux-x64` the runner pool is not one machine either: the CPU model and the image version are per file (the columns below), and
  the three engines of the readiness runs, and the soak of A and of the candidate of one engine, did not run on the same CPU.
- **Provenance is kept apart from the result.** The run, the runner and the CPU are facts of a job, not of a measurement, so they are not in the
  result files (which every reader would have to know to skip them) but in [`../provenance`](../provenance): `runs.json` (written by hand
  from the dispatch) and `machines/<label>.txt` (what the workflow printed, verbatim).
- **The names carry what the jobs' names did not.** Two jobs of one engine and length (the soak of A and of the candidate `live-sync`)
  uploaded the same path, so the seven soaks of the candidate were renamed when they were copied here (ADR-159a); the last table lists
  every renaming.
- **Verdicts.** `Verdict` is the one the harness wrote when the file was measured. Since the latency level after the faults became a
  criterion of the soak (ADR-159c) a soak file that was GO at that time can be NO-GO by today's criteria; the table says both and the file is
  not touched.

**Regenerate.** The tables below are generated from the files, never typed: `npm run results:docs -- --write` rewrites them,
`npm run results:docs` checks them (and the join: a file that is not what its job uploaded, a name that is not the one its content gets, or a
machine record of another commit is refused). To add a run: put its file in `../readiness` or `../soak`, its machine record in
`../provenance/machines`, its entry in `runs.json`, and regenerate.

<!-- BEGIN:EVIDENCE_MANIFEST -->
Results, one table per environment (a row is one file; the machine is the runner of the job that wrote it):

**gha-linux-x64** (Linux X64, github-hosted):

| File | Run | Commit | Task | Engine | Configuration | Length | Verdict | Duration | Runner image | CPU | Load before to after (1 min) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gha-linux-x64-chromium.json` | [41876070337](https://github.com/hanniavalera/playback-proof/actions/runs/41876070337) | 0d62c1d | readiness | chromium 156.0.8078.4 | A, live-sync | 5 joins, 3 outages | A NO-GO; live-sync GO | 10:32 | ubuntu24 20261026.354.1 | AMD EPYC 9V45 96-Core Processor, 4 CPUs | 1.89 to 0.96 (4 CPUs) |
| `gha-linux-x64-firefox.json` | [41876079060](https://github.com/hanniavalera/playback-proof/actions/runs/41876079060) | 0d62c1d | readiness | firefox 157.0 | A, live-sync | 5 joins, 3 outages | A NO-GO; live-sync GO | 10:28 | ubuntu24 20261026.354.1 | AMD EPYC 9V74 80-Core Processor, 4 CPUs | 0.27 to 0.50 (4 CPUs) |
| `gha-linux-x64-webkit.json` | [41876086545](https://github.com/hanniavalera/playback-proof/actions/runs/41876086545) | 0d62c1d | readiness | webkit 27.2 | A, live-sync | 5 joins, 3 outages | A NO-GO; live-sync GO | 10:11 | ubuntu24 20261026.354.1 | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz, 4 CPUs | 0.46 to 0.65 (4 CPUs) |
| `gha-linux-x64-chromium-5m.json` | [41876103805](https://github.com/hanniavalera/playback-proof/actions/runs/41876103805) | 0d62c1d | soak | chromium 156.0.8078.4 | A | 5 min (ci) | GO as measured, NO-GO by today's criteria | 5:00 | ubuntu24 20261101.360.1 | INTEL(R) XEON(R) PLATINUM 8573C, 4 CPUs | 1.03 to 0.53 (4 CPUs) |
| `gha-linux-x64-chromium-5m-live-sync.json` | [41876112038](https://github.com/hanniavalera/playback-proof/actions/runs/41876112038) | 0d62c1d | soak | chromium 156.0.8078.4 | live-sync | 5 min (ci) | GO | 5:00 | ubuntu24 20261101.360.1 | AMD EPYC 7763 64-Core Processor, 4 CPUs | 0.63 to 0.55 (4 CPUs) |
| `gha-linux-x64-chromium-30m.json` | [41876171880](https://github.com/hanniavalera/playback-proof/actions/runs/41876171880) | 0d62c1d | soak | chromium 156.0.8078.4 | A | 30 min (release) | GO as measured, NO-GO by today's criteria | 30:00 | ubuntu24 20261026.354.1 | AMD EPYC 7763 64-Core Processor, 4 CPUs | 0.85 to 0.78 (4 CPUs) |
| `gha-linux-x64-chromium-30m-live-sync.json` | [41876180263](https://github.com/hanniavalera/playback-proof/actions/runs/41876180263) | 0d62c1d | soak | chromium 156.0.8078.4 | live-sync | 30 min (release) | GO | 30:00 | ubuntu24 20261026.354.1 | AMD EPYC 9V45 96-Core Processor, 4 CPUs | 0.92 to 0.47 (4 CPUs) |
| `gha-linux-x64-firefox-5m.json` | [41876120714](https://github.com/hanniavalera/playback-proof/actions/runs/41876120714) | 0d62c1d | soak | firefox 157.0 | A | 5 min (ci) | GO as measured, NO-GO by today's criteria | 5:01 | ubuntu24 20261026.354.1 | INTEL(R) XEON(R) PLATINUM 8573C, 4 CPUs | 1.38 to 0.14 (4 CPUs) |
| `gha-linux-x64-firefox-5m-live-sync.json` | [41876128028](https://github.com/hanniavalera/playback-proof/actions/runs/41876128028) | 0d62c1d | soak | firefox 157.0 | live-sync | 5 min (ci) | GO | 5:01 | ubuntu24 20261026.354.1 | AMD EPYC 9V74 80-Core Processor, 4 CPUs | 0.81 to 0.27 (4 CPUs) |
| `gha-linux-x64-firefox-30m.json` | [41876188537](https://github.com/hanniavalera/playback-proof/actions/runs/41876188537) | 0d62c1d | soak | firefox 157.0 | A | 30 min (release) | GO as measured, NO-GO by today's criteria | 30:01 | ubuntu24 20261026.354.1 | AMD EPYC 7763 64-Core Processor, 4 CPUs | 0.65 to 0.50 (4 CPUs) |
| `gha-linux-x64-firefox-30m-live-sync.json` | [41876197319](https://github.com/hanniavalera/playback-proof/actions/runs/41876197319) | 0d62c1d | soak | firefox 157.0 | live-sync | 30 min (release) | GO | 30:01 | ubuntu24 20261026.354.1 | AMD EPYC 9V45 96-Core Processor, 4 CPUs | 0.89 to 1.50 (4 CPUs) |
| `gha-linux-x64-webkit-5m.json` | [41876136269](https://github.com/hanniavalera/playback-proof/actions/runs/41876136269) | 0d62c1d | soak | webkit 27.2 | A | 5 min (ci) | GO as measured, NO-GO by today's criteria | 5:01 | ubuntu24 20261101.360.1 | AMD EPYC 9V74 80-Core Processor, 4 CPUs | 0.68 to 0.97 (4 CPUs) |
| `gha-linux-x64-webkit-5m-live-sync.json` | [41876144771](https://github.com/hanniavalera/playback-proof/actions/runs/41876144771) | 0d62c1d | soak | webkit 27.2 | live-sync | 5 min (ci) | GO | 5:19 | ubuntu24 20261101.360.1 | AMD EPYC 7763 64-Core Processor, 4 CPUs | 0.72 to 0.98 (4 CPUs) |
| `gha-linux-x64-webkit-30m.json` | [41876205904](https://github.com/hanniavalera/playback-proof/actions/runs/41876205904) | 0d62c1d | soak | webkit 27.2 | A | 30 min (release) | GO as measured, NO-GO by today's criteria | 30:05 | ubuntu24 20261101.360.1 | AMD EPYC 9V45 96-Core Processor, 4 CPUs | 0.67 to 1.07 (4 CPUs) |
| `gha-linux-x64-webkit-30m-live-sync.json` | [41876214329](https://github.com/hanniavalera/playback-proof/actions/runs/41876214329) | 0d62c1d | soak | webkit 27.2 | live-sync | 30 min (release) | GO as measured, NO-GO by today's criteria | 30:06 | ubuntu24 20261101.360.1 | AMD EPYC 7763 64-Core Processor, 4 CPUs | 0.56 to 2.36 (4 CPUs) |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| File | Run | Commit | Task | Engine | Configuration | Length | Verdict | Duration | Runner image | CPU | Load before to after (1 min) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gha-macos-arm64-webkit.json` | [41876094919](https://github.com/hanniavalera/playback-proof/actions/runs/41876094919) | 0d62c1d | readiness | webkit 27.2 | A, live-sync | 5 joins, 3 outages | A NO-GO; live-sync GO | 11:07 | macos15 20261028.0489.1 | Apple M1 (Virtual), 3 CPUs | 66.39 to 3.07 (3 CPUs, busy at the start) |
| `gha-macos-arm64-webkit-5m.json` | [41876154174](https://github.com/hanniavalera/playback-proof/actions/runs/41876154174) | 0d62c1d | soak | webkit 27.2 | A | 5 min (ci) | GO as measured, NO-GO by today's criteria | 5:03 | macos15 20261028.0489.1 | Apple M1 (Virtual), 3 CPUs | 81.33 to 9.84 (3 CPUs, busy at the start) |
| `gha-macos-arm64-webkit-5m-live-sync.json` | [41876162923](https://github.com/hanniavalera/playback-proof/actions/runs/41876162923) | 0d62c1d | soak | webkit 27.2 | live-sync | 5 min (ci) | GO | 5:04 | macos15 20261028.0489.1 | Apple M1 (Virtual), 3 CPUs | 62.65 to 10.91 (3 CPUs, busy at the start) |

The machines (the first line of the uptime is the one the workflow printed when the job began, before the dependencies were installed; the load in the results above is the harness's own reading just before and just after its run):

**gha-linux-x64** (Linux X64, github-hosted):

| File | Started to finished (UTC) | OS | Memory | Runner up at the start | Runner up at the end | Node | Playwright |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gha-linux-x64-chromium.json` | 2026-11-04T17:17:46Z to 2026-11-04T17:28:20Z | Ubuntu 24.04.5 LTS | 15983 MiB | 1 min, load 1.89 0.84 0.31 | 11 min, load 0.96 0.59 0.40 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-firefox.json` | 2026-11-04T17:21:56Z to 2026-11-04T17:32:26Z | Ubuntu 24.04.5 LTS | 15983 MiB | 4 min, load 0.20 0.18 0.08 | 15 min, load 0.50 0.48 0.30 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-webkit.json` | 2026-11-04T17:22:16Z to 2026-11-04T17:32:30Z | Ubuntu 24.04.5 LTS | 15982 MiB | 5 min, load 0.42 0.29 0.13 | 15 min, load 0.65 1.02 0.72 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-chromium-5m.json` | 2026-11-04T17:18:04Z to 2026-11-04T17:23:08Z | Ubuntu 24.04.5 LTS | 15982 MiB | 1 min, load 1.04 0.48 0.18 | 6 min, load 0.53 0.50 0.27 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-chromium-5m-live-sync.json` | 2026-11-04T17:17:59Z to 2026-11-04T17:23:03Z | Ubuntu 24.04.5 LTS | 15983 MiB | 0 min, load 0.63 0.16 0.05 | 5 min, load 0.55 0.58 0.28 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-chromium-30m.json` | 2026-11-04T17:18:25Z to 2026-11-04T17:48:30Z | Ubuntu 24.04.5 LTS | 15983 MiB | 0 min, load 0.75 0.20 0.07 | 30 min, load 0.78 0.52 0.36 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-chromium-30m-live-sync.json` | 2026-11-04T17:18:20Z to 2026-11-04T17:48:23Z | Ubuntu 24.04.5 LTS | 15983 MiB | 0 min, load 0.92 0.26 0.09 | 30 min, load 0.47 0.33 0.28 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-firefox-5m.json` | 2026-11-04T17:18:11Z to 2026-11-04T17:23:16Z | Ubuntu 24.04.5 LTS | 15982 MiB | 0 min, load 1.33 0.39 0.14 | 5 min, load 0.14 0.34 0.19 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-firefox-5m-live-sync.json` | 2026-11-04T17:18:09Z to 2026-11-04T17:23:13Z | Ubuntu 24.04.5 LTS | 15983 MiB | 2 min, load 0.81 0.33 0.13 | 7 min, load 0.41 0.34 0.19 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-firefox-30m.json` | 2026-11-04T17:18:40Z to 2026-11-04T17:48:45Z | Ubuntu 24.04.5 LTS | 15983 MiB | 4 min, load 0.62 0.24 0.09 | 34 min, load 0.50 0.40 0.32 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-firefox-30m-live-sync.json` | 2026-11-04T17:18:32Z to 2026-11-04T17:48:36Z | Ubuntu 24.04.5 LTS | 15983 MiB | 0 min, load 0.89 0.25 0.08 | 30 min, load 1.50 0.59 0.40 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-webkit-5m.json` | 2026-11-04T17:18:36Z to 2026-11-04T17:23:40Z | Ubuntu 24.04.5 LTS | 15983 MiB | 2 min, load 0.68 0.26 0.10 | 7 min, load 0.97 0.87 0.41 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-webkit-5m-live-sync.json` | 2026-11-04T17:18:57Z to 2026-11-04T17:24:21Z | Ubuntu 24.04.5 LTS | 15983 MiB | 2 min, load 0.70 0.27 0.10 | 7 min, load 0.98 1.21 0.59 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-webkit-30m.json` | 2026-11-04T17:18:58Z to 2026-11-04T17:49:06Z | Ubuntu 24.04.5 LTS | 15983 MiB | 1 min, load 0.64 0.17 0.06 | 31 min, load 1.07 1.04 0.92 | v22.23.4 | 1.64.1 |
| `gha-linux-x64-webkit-30m-live-sync.json` | 2026-11-04T17:20:45Z to 2026-11-04T17:50:56Z | Ubuntu 24.04.5 LTS | 15983 MiB | 9 min, load 0.35 0.15 0.05 | 39 min, load 2.36 1.78 1.40 | v22.23.4 | 1.64.1 |

**gha-macos-arm64** (macOS ARM64, github-hosted):

| File | Started to finished (UTC) | OS | Memory | Runner up at the start | Runner up at the end | Node | Playwright |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gha-macos-arm64-webkit.json` | 2026-11-04T17:17:49Z to 2026-11-04T17:29:02Z | macOS 15.8.2 | 7168 MiB | 1 min, load 71.82 28.63 11.25 | 13 mins, load 3.07 9.42 9.59 | v22.23.4 | 1.64.1 |
| `gha-macos-arm64-webkit-5m.json` | 2026-11-04T17:18:08Z to 2026-11-04T17:23:20Z | macOS 15.8.2 | 7168 MiB | 1 min, load 88.23 37.02 14.68 | 7 mins, load 11.22 18.61 12.68 | v22.23.4 | 1.64.1 |
| `gha-macos-arm64-webkit-5m-live-sync.json` | 2026-11-04T17:18:26Z to 2026-11-04T17:23:38Z | macOS 15.8.2 | 7168 MiB | 2 mins, load 67.93 37.50 15.58 | 7 mins, load 11.72 19.46 13.61 | v22.23.4 | 1.64.1 |

Names and digests:

| File | Uploaded as | SHA-256 of the file as the job uploaded it |
| --- | --- | --- |
| `gha-linux-x64-chromium.json` | the same name | `682717b64210c96e61ed15290a07b617349447ce595bc2b1bb04dd505fd3837d` |
| `gha-linux-x64-firefox.json` | the same name | `b4a8423b6b995164f5799df1778be0762c842232ef024d6e5cc61c48bd717a66` |
| `gha-linux-x64-webkit.json` | the same name | `e5f7754eb382ca5add3b8510dc63fe1d94071c9e0511f03658582068e3ee2f03` |
| `gha-linux-x64-chromium-5m.json` | the same name | `cdd95fd1677634c73bfe87ce12e5df5b91c4817a270913e4b1b90ff10415a674` |
| `gha-linux-x64-chromium-5m-live-sync.json` | `soak/gha-linux-x64-chromium-5m.json` (renamed when it was copied) | `6089a407e750376c4756fab0e2b90810f6c9c7ab409b54089e19b87b458a5694` |
| `gha-linux-x64-chromium-30m.json` | the same name | `c63460cebfe4e425d66c42ba26d020cdf26ed1df5dba9926b78c1e9436a612ea` |
| `gha-linux-x64-chromium-30m-live-sync.json` | `soak/gha-linux-x64-chromium-30m.json` (renamed when it was copied) | `51bc927927deef4b26ac2c8faf13ab67ababa5865e5aa6cffa7859e2a6a0d680` |
| `gha-linux-x64-firefox-5m.json` | the same name | `90fe2bea001e232ccea35d220a905af78c3a7bf4016073f78897b4cee82969b3` |
| `gha-linux-x64-firefox-5m-live-sync.json` | `soak/gha-linux-x64-firefox-5m.json` (renamed when it was copied) | `df74f7167c2450e3a591b7faa20bbeee9d93f14be4737d1b523e7f4e3c673f01` |
| `gha-linux-x64-firefox-30m.json` | the same name | `067db277163d8641fa7192fd3e4fcab6b43c245d5dfb8262295b7b1f2f72772f` |
| `gha-linux-x64-firefox-30m-live-sync.json` | `soak/gha-linux-x64-firefox-30m.json` (renamed when it was copied) | `513c6ca06f725ee377fe2d3556e9b709fcd8f03ca9ab502c1725b226a5027460` |
| `gha-linux-x64-webkit-5m.json` | the same name | `09f6c57f2ba755cdd34be4e1338af1a7906e304a6d16e449812cb30ecaf64f1b` |
| `gha-linux-x64-webkit-5m-live-sync.json` | `soak/gha-linux-x64-webkit-5m.json` (renamed when it was copied) | `bf9c444292f5a326963e7d67aacadc933a4d98463cc45cb26917e590882ab2b2` |
| `gha-linux-x64-webkit-30m.json` | the same name | `9843430d74440924708c59e788622a2d8b6bf7704102e9dc59094b91a7559aa0` |
| `gha-linux-x64-webkit-30m-live-sync.json` | `soak/gha-linux-x64-webkit-30m.json` (renamed when it was copied) | `4d96836291bd31207de1e0795ee66e0529872e3f1b18f79d637960c779f7edc7` |
| `gha-macos-arm64-webkit.json` | the same name | `6a25e07cf4e7d21a23c1bf331a988d3bcf7814f2d7bdc7333ed547be5047479f` |
| `gha-macos-arm64-webkit-5m.json` | the same name | `cc1fa9bfaed2ad27028f6f296edd91d297aff393f856302fbbd6fb856b02c810` |
| `gha-macos-arm64-webkit-5m-live-sync.json` | `soak/gha-macos-arm64-webkit-5m.json` (renamed when it was copied) | `a6c9e6a2d62a76071ac7f828136c400f910c67c8fcdd27c18d1738bacef7a721` |
<!-- END:EVIDENCE_MANIFEST -->
