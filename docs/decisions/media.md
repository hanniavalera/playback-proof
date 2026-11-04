# Media pipeline decisions (ADR-040 to ADR-049)

The decisions behind `src/server/media`: how the lab's streams are encoded, cut, packaged, described and verified. Each record has the same parts: context, decision,
alternatives considered, consequences, and a paragraph on how to defend it in a review. Numbers come from real runs on one machine (an Apple M2 Pro with 12 cores
shared with other jobs, macOS 27.2, Node 22.11.0, Homebrew ffmpeg 9.0.2, 2026-11-03, `p2/media`); where a Linux ffmpeg 6.1 run is meant, it says so. The contract these decisions
implement is [CONTRACTS.md](../CONTRACTS.md) section 3; the format decision they build on is [ADR-001](../DESIGN_DECISIONS.md).

## ADR-040: VP9 in CMAF fMP4 for DASH and HLS from one set of files, a WebM fixture, test patterns only

**Context.** ADR-001 fixed the matrix: VP9 + AAC in fragmented MP4 plays in Chromium, Firefox and WebKit (macOS); a WebM VP9 + Opus fixture covers the open-codec path. The pipeline has to turn that
into reproducible files for two streaming protocols, with no third-party media and no licensed codec.

**Decision.**

- One ladder for every stream: VP9 profile 0, 8-bit 4:2:0, 30 fps; `v240` 426x240 at 300 kbps, `v360` 640x360 at 700 kbps, `v720` 1280x720 at 1800 kbps; a keyframe at the start of every 2 s segment.
  Audio: AAC-LC 48 kHz stereo 64 kbps in fMP4, Opus 48 kHz stereo 64 kbps in WebM.
- The fMP4 files are CMAF-style segments (`styp` + `moof` + `mdat`, one init segment per representation), referenced by **both** the DASH and the HLS manifest: one set of bytes, two descriptions.
  WebM (one Cluster per segment) is DASH only.
- The picture comes from ffmpeg's `testsrc2`: moving shapes, a timestamp and a frame counter that stay legible at 240p, so a person can tell a wrong or repeated segment. The sound comes from `aevalsrc`: two beeps per
  segment whose pitch climbs one semitone per segment, so different segments have different audio bytes (and different pitch for the ear), silent at the start and at the end of the stream (ADR-042 says why).
  The dev host's ffmpeg has no `drawtext` (no freetype); `testsrc2` needs none.

**Alternatives considered.** H.264 (the most compatible, but licensed, and the lab's point is that it needs none). AV1 (encodes far slower, WebKit support is partial). Opus in fMP4 (WebKit cannot play it, ADR-001).
MPEG-TS segments for HLS (a second packaging of the same content, not CMAF). Single-file fMP4 with byte-range requests (needs a `sidx`, which the live loop would have to rewrite: ADR-044). A real clip (copyright, and no frame counter).

**Consequences.** The software VP9 encode is the cost: the whole catalog takes 110 s of wall-clock with 4 ffmpeg threads on this machine (once per cache key). HLS plays through Shaka's MSE-based parser, not through a browser's native HLS.
The audio is a sparse tone: its measured peak is about 36.9 kbps, far below its 64 kbps encoder target, and the manifests declare the measured number (ADR-043).

**Defending it.** "The lab tests a player, so the content has to be something every engine decodes, that nobody can claim a licence on, and that tells you where you are: the frame counter and the climbing pitch
make a wrong segment, a skipped segment or a loop restart visible and audible. One set of CMAF files behind two manifests means a DASH run and an HLS run play the same bytes, so a difference between them is the player's, not the content's."

## ADR-041: Each stream is a pure function of its own spec; the cache key hashes the spec and the resolved ffmpeg arguments

**Context.** The catalog has five streams (the fifth, ClearKey, is the same pipeline with an encryption step: ADR-049). `vod-cmaf-short` (12 s) and `live-cmaf` (24 s) look like prefixes of `vod-cmaf` (60 s).
The cache must change whenever anything that changes the bytes changes, and only then.

**Decision.**

- `src/server/media/specs.ts` holds the streams as plain data (`CATALOG`). `ffmpegPlan(spec, rep)` turns a spec into the exact ffmpeg arguments (without `-threads` and without paths).
  `specHash(spec)` is the sha256 of the canonical JSON (sorted keys) of `{ generator: GENERATOR_VERSION, spec, plans }`: the resolved argument list is part of the key, so editing an encoder option, the test pattern or a rung changes the key
  without anyone remembering to bump a number. `GENERATOR_VERSION` covers what the arguments cannot: the segmenter, the box writers, the init normalization, the shape of `stream.json` (it is 2 because the WebM init segment changed, ADR-044).
- The directory is `.cache/streams/<specHash>/<streamId>/`. Every stream has its own key, so changing one stream regenerates only that stream.
- Every stream is encoded on its own: `vod-cmaf-short` and `live-cmaf` are **not** derived from `vod-cmaf`. Any stream can be generated alone (`--streams vod-cmaf-short` takes 11 s) and no cache depends on another.
- `tests/unit/media/specs.test.ts` pins a golden hash per catalog stream, so a change to a spec is a changed constant in a review, not a silently invalidated cache.

**Alternatives considered.** Slice `vod-cmaf-short` and `live-cmaf` out of `vod-cmaf` (about 30 % less encoding). A comparison made after the decision shows slicing would have produced the same bytes: the encoder runs without look-ahead or alt-ref
frames and with forced keyframes, so a segment does not depend on the length of the clip, and the 12 segments of `live-cmaf` and the 6 of `vod-cmaf-short` have the same sha256 as the first segments of `vod-cmaf` for every rung (and for the audio of `live-cmaf`).
Slicing is therefore a safe future optimization; it was not chosen because it couples the caches. One hash for the whole catalog (any edit regenerates everything). Hashing only the spec data (an edit to the argument builder would go unnoticed).

**Consequences.** About 35 s of encoding that slicing would not need. Every change to `specs.ts` that affects bytes invalidates that stream's cache on every machine: that is the point. The golden hashes must be updated on purpose.

**Defending it.** "The cache key decides whether a result is stale, so it has to be impossible to forget. Hashing the resolved ffmpeg argument list instead of a version number I would have to remember to bump is what makes it impossible.
And a key per stream means a one-line change to the short stream does not cost a two-minute regeneration of the rest."

## ADR-042: The audio cutting rule, the equal loop length and the AAC priming frame

**Context.** An AAC frame is 1024 samples; 2 s of 48 kHz audio is 93.75 frames, so audio segments cannot all be the same length. ffmpeg's `dash` muxer cuts a segment once "at least 2 s have passed since the previous segment started":
every segment becomes 94 frames (2.0053 s), the audio drifts 5.3 ms per segment against the video, a 24 s loop would be 64 ms longer for audio than for video, and every further loop would add another 64 ms.
Separately, the native AAC encoder emits one extra *priming* frame (1024 samples of pre-roll) before the first real frame.

**Decision.**

- **The rule.** Segment `k` starts at the first frame whose start time is `>= (k-1) x 2 s`: frame index `ceil((k-1) x 96000 / 1024)`, in exact integer arithmetic (`audioSegmentStartFrames`). The counts repeat `94, 94, 94, 93`: 375 frames are exactly 8 s, so the
  error never exceeds one frame and never accumulates. A unit test uses `94, 94, 94, 93` as the oracle; `npm run verify:streams` checks it again on ffprobe's packet counts, assigned to segments by byte position.
- **Whole frames, never past the video.** The audio of a VOD stream holds `floor(duration x 48000 / 1024)` frames: 60 s is 2812 frames (59.989 s), 12 s is 562 (11.989 s). The audio ends up to one frame before the video, never after it, so the presentation duration
  is the video's: a player sees `duration == 60` and `StreamInfo.durationSec` is true.
- **The live loop.** `live-cmaf` is 12 segments: 1125 AAC frames = 1,152,000 ticks at 48 kHz = 24 s, and 720 video frames = 368,640 ticks at 15,360 = 24 s. `loopTicks / timescale` is equal for every track **to the tick**, checked by integer cross-multiplication
  (`audio.loopTicks x video.timescale == video.loopTicks x audio.timescale`) in `checkStreamIndex`, at generation, at load, in the verification tool, and by a spec test that requires a live loop to be a multiple of 8 s.
- **The priming frame is dropped.** For `N` frames of input the encoder emits `N + 1` packets and the first decodes to the pre-roll before the signal. The generator drops it, so packet `i` is frame `i`, covers samples `[i x 1024, (i+1) x 1024)` and starts at tick `i x 1024`.
  No edit list is written (the init segments are checked to have none): the media timeline is the presentation timeline. Measured on a real stream (`vod-cmaf-short`): the decoded audio is exactly `frames x 1024` samples long and the first beep starts where the signal puts it
  (sample 4877 for a beep that starts at 4800 and fades in over 20 ms; with the priming frame it would be about 1024 samples later).
- **Silence at both ends.** The first frame is decoded without the overlap partner the dropped priming frame would have given it, and a loop splices the last frame onto the first. The tone is silent in the first and the last 2048 samples (43 ms), so neither is audible; the pipeline test measures it.

**Alternatives considered.** ffmpeg's cut (drift, and the loop invariant is impossible). Keep the priming frame (a constant 21.3 ms audio/video offset). An edit list that skips the priming frame (`elst`): players apply edit lists inconsistently to MSE content, and the loop rewrite would
have to keep it consistent. `-f segment` with explicit cut times (the right cut, but every file carries its own init and timestamp conventions). Round the audio up to whole frames (the audio then outlives the video by up to 21 ms and the presentation duration is no longer the video's).

**Consequences.** VOD audio is 10.7 ms shorter than the video (60 s and 12 s: the last audio segment holds 93 frames, not 94). Manifests have to carry real durations (ADR-043). The design relies on the signal being silent at its edges; a signal that is not would click at every loop.
HE-AAC (not used) has a different priming length.

**Defending it.** "The loop invariant is a one-line integer equation, so I made the numbers satisfy it instead of hoping: 12 segments are 1125 frames, which is exactly 24 seconds. The cut rule is the same equation applied per segment, tested against an independent oracle (94-94-94-93)
and against ffprobe on the real files. The priming frame is the classic way to get 21 ms of lip-sync error, so a test decodes the audio and looks at the sample where the first beep starts."

## ADR-043: Manifests carry the real timing; codec strings and bandwidth come from the files

**Context.** A manifest that says "2.000 s per audio segment" is wrong by up to one frame per segment, and players stall or skip. Codec strings and bandwidths written from constants go stale the day an encoder option changes.

**Decision.**

- **DASH** uses `SegmentTemplate` with `$Number$` addressing and a `SegmentTimeline`: `startNumber` is the first listed segment number, `t` its real start in ticks, `r` repeats equal contiguous segments, `t` is written again only after a discontinuity.
  Video is `<S t="0" d="30720" r="29"/>`; audio is `<S t="0" d="96256" r="2"/><S d="95232"/>...`. For live the `S` entries come from `liveTiming(rep, n)`: each track carries its own real times, the loop included.
  Alignment is derived from the data: `segmentAlignment` and `subsegmentAlignment` are written only when every representation of the set has the identical timeline, which is also what lets them share one `SegmentTemplate`.
  `maxSegmentDuration` is rounded **up** to the millisecond (2.00533 s is announced as 2.006 s). `minBufferTime` is one segment (in Shaka 5.3.3 it only feeds the live presentation-delay fallback; it does not touch `rebufferingGoal`).
  Live adds `UTCTiming` (`urn:mpeg:dash:utc:http-iso:2014`, value `/api/time`, an absolute path that resolves against the manifest URL) after the `Period`, where the schema puts it.
  `profiles` is `urn:mpeg:dash:profile:isoff-live:2011` for fMP4; the WebM stream says `urn:mpeg:dash:profile:full:2011`, because the ISO BMFF live profile promises ISO BMFF segments.
- **HLS** (version 7) has `EXTINF` with six decimals (`2.005333`, `1.984000`), `#EXT-X-MAP`, `#EXT-X-INDEPENDENT-SEGMENTS`, audio as an `EXT-X-MEDIA` group, `#EXT-X-PLAYLIST-TYPE:VOD` + `ENDLIST` for VOD, and for live a sliding window with
  `#EXT-X-MEDIA-SEQUENCE` equal to the first listed segment number and a `#EXT-X-PROGRAM-DATE-TIME` on every segment (AST plus the segment's live start). `#EXT-X-TARGETDURATION` is `ceil(max EXTINF)` over the whole source loop,
  not over the window (it must not change while a playlist slides): 2 for video, 3 for AAC (94 frames = 2.0053 s). RFC 8216 only requires `round(EXTINF) <= TARGETDURATION`, so 2 would also be legal; 3 is the conservative reading.
  `BANDWIDTH` of a variant is the video peak plus the audio peak, `AVERAGE-BANDWIDTH` comes from the segment sizes.
- **Codec strings come from the bitstream.** `vp09.PP.LL.DD` is read from `vpcC` (profile, level, bit depth) and checked against the key frame's uncompressed header (profile, bit depth, width) and against the level that the picture size and frame rate need
  (the VP9 level table): a disagreement fails generation. `mp4a.40.2` comes from the `esds` descriptor (object type 0x40, audio object type 2). WebM has no `vpcC`, so its VP9 string comes from the key frame header and the same level table; Opus is `opus`.
  Width, height, frame rate, channels and sample rate come from the files too (`RepInfo.channels` and `sampleRate` are new optional fields of the contract).
- **Declared `bandwidth` is the measured peak**: `ceil(max over segments of bytes x 8 / real duration)`. For `vod-cmaf` that is 305,000 / 709,900 / 1,808,424 bit/s for the three rungs (targets 300 / 700 / 1800 kbps) and 36,878 for the audio
  (target 64 kbps, average 35,298). Every 2 s segment of the CBR-style encode is between 93.6 % and 101.7 % of its target size (the keyframe segment is the largest).

**Alternatives considered.** Nominal 2.000 s timing (wrong, see context). `SegmentTemplate@duration` (cannot express 94 and 93 frames). A template per Representation always (larger, and the alignment claim would be an assertion instead of a fact). Codec strings
from constants (it is how a wrong `vp09` level reaches a manifest: ffmpeg's `vpcC` level is right here, but now the pipeline checks it). Declaring the average as bandwidth (players would choose rungs they cannot sustain through a segment peak).

**Consequences.** Manifests are a few hundred bytes larger than with a uniform timeline. A new encoder option changes the declared bandwidth, which is correct. The level table is a second source for the level; it is checked against `vpcC`, so a disagreement is an error, not a guess.

**Defending it.** "A manifest is a claim about files, so every number in it is derived from the files, and then the claim is checked from the other side: the verification tool fetches every segment the MPD lists and compares the times the MPD says with the times ffprobe finds in the bytes."

## ADR-044: Re-segmenting in Node with a strict ISO BMFF writer and an EBML splitter, no `sidx`

**Context.** ffmpeg's `dash`, `hls`, `segment` and `webm_chunk` muxers cut audio by their own rules (ADR-042), write files with their own conventions, and change between versions; the lab must work with the 9.0 of the dev host and the 6.1 of Ubuntu 24.04 (the CI runners).
The live loop rewrites decode times, so anything in a segment that records a time or an offset has to be understood, and patched, by the lab.

**Decision.**

- ffmpeg only **encodes**, once per representation, into an intermediate file (fragmented MP4 or WebM). Node reads the packets (`readIsobmffPackets`, `readWebmPackets`), decides where every segment starts, **synthesizes the timestamps from the packet index**
  (512 ticks per 30 fps frame at 15,360; 1024 per AAC frame at 48,000; `round(i x 1000 / 30)` ms for WebM video; `20 i` ms for Opus) and writes the files.
- fMP4 segment: `styp` (`msdh`), `moof` = `mfhd` + one `traf` (`tfhd` with default-base-is-moof, `tfdt` **version 1**, `trun` with per-sample duration, size and flags), `mdat`. One fragment per segment and **no `sidx`**: it holds offsets and times the rewrite
  would otherwise have to patch. `tfdt` is version 1 always: a 32-bit field would wrap after about 77 hours of 15,360-tick video or 25 hours of 48 kHz audio.
- The init segment is ffmpeg's `ftyp` + `moov` without the empty `udta` and without any edit list (`removeBoxes` fixes the container sizes).
- WebM: ffmpeg's EBML header and `Tracks` bytes are kept, `Info` is written by the lab (timecode scale, no duration), each segment is exactly one Cluster whose timecode is its first block's. ffmpeg's own Opus block timestamps are jittered by 1 ms by rounding (0, 21, 41, 61, ...);
  they are replaced by the exact 20 ms grid, and the encoder's extra tail packet is dropped so every audio segment holds exactly 100 packets. **`DefaultDuration`** (frame duration in the track header) is written by the lab because ffmpeg 9 writes it and ffmpeg 6.1 does not
  (found by running the generator in Docker); segment durations are derived from it, and the init segment is now the same whichever ffmpeg made the packets.
- The reader is strict: every size is bounds-checked against its container, 64-bit sizes and `size == 0` are handled, sample defaults fall back `trun` -> `tfhd` -> `trex`, laced blocks are refused. Every segment the generator writes is parsed back and checked
  (`inspectRep`: one `moof` + one `mdat`, samples tiling the `mdat`, a key frame first, no `sidx`) before the index is built from it.

**Alternatives considered.** `-f dash` (the audio rule). `-f segment` with `-segment_times` (the right audio cut, but every file has its own `moov`). `webm_chunk` (cuts audio by duration, not by the grid). Shaka Packager or MP4Box (a new dependency on every CI runner).
Trust ffmpeg's fragments for video and re-cut only audio (two code paths, and the video would depend on the muxer version).

**Consequences.** The lab owns a reader and writer for two container formats (`isobmff.ts`, `ebml.ts`) with property tests. In return the bytes of a segment depend only on the encoder's packets, and every timestamp in the lab is decided in one place.
A segment is decodable only with its init segment, so verification concatenates them (ADR-048).

**Defending it.** "The two things I have to control, where the audio is cut and what every timestamp says, are exactly the two things the muxers decide for me. So ffmpeg does what it is good at, encoding, and I wrote the part that decides the rest, and I check it
against ffprobe on every segment instead of trusting it. Running it on ffmpeg 6.1 found a real portability bug in my first version, which is the argument for having done it."

## ADR-045: Determinism: identical bytes for one ffmpeg build at any thread count, and what is not promised

**Context.** "Reproducible streams" is a claim on a resume. It has to be true, and its limits have to be stated.

**Decision.** The generation is bit-exact for one ffmpeg build, and that was measured.

- Pinned: `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1` (no encoder strings, timestamps or creation times), explicit libvpx options (`-deadline good -cpu-used 4 -tile-columns 2 -frame-parallel 0 -auto-alt-ref 0 -lag-in-frames 0`),
  forced keyframes, AAC `-aac_coder twoloop -profile:a aac_low`, Opus `-vbr off -frame_duration 20 -compression_level 10`.
- **`-row-mt 0` is pinned, and that is the finding.** With `-row-mt 1` the libvpx VP9 bitstream depends on whether the encoder runs on one thread or on several: on a 6 s 720p clip, 1 thread gives md5 `a7f1e0de...` (1,310,205 bytes), 2 and 4 threads give
  `4ee7adae...` (1,311,541 bytes). With `-row-mt 0` the output is identical for 1, 2, 3 and 4 threads (`a7f1e0de...`). A unit test (`produces identical bytes whatever the ffmpeg thread count`) fails when the flag is set to 1 (checked by mutation) and a spec test pins it.
- **Experiment on the whole catalog**, two clean caches, the same machine and ffmpeg 9.0.2: `--threads 4` took 112.2 s and `--threads 1` took 183.0 s. **All 282 files are identical byte for byte** (124 + 28 + 64 + 52 + 14 per stream; compared with `shasum` over both cache trees, not only through the hashes recorded in `stream.json`)
  and the five `contentHash` values are equal. Subsets generated earlier in the work reproduced the same hashes as well, and the four older streams kept their hashes when the encrypted stream was added (ADR-049 touched none of their bytes).
- The thread count is not part of the cache key.

**Not promised.** Byte equality across ffmpeg versions, builds or platforms: libvpx has different SIMD paths per CPU, `aevalsrc` evaluates `sin` with the platform's libm, the native AAC encoder changes between releases, and a muxer may write the same element with another header size.
The version is recorded in `stream.json` and `StreamInfo.ffmpegVersion`. Measured: the streams generated in Docker with Ubuntu's ffmpeg 6.1.1 (aarch64, 4 CPUs) have the `contentHash` `cac90e8344ae` (`vod-cmaf`), `0757d6892b9e` (`vod-cmaf-short`), `637a981739b5` (`vod-webm`),
`7baf3de387ba` (`live-cmaf`) and `d5fc537f25cd` (`vod-cmaf-clearkey`), identical in every clean run (three for the first four streams, two for the encrypted one); the macOS run with ffmpeg 9.0.2 has `66738540703f`, `52288c8dbedb`, `ed602bbaec0d`, `edf24480e424` and `f1d6817ae459`. Same specs, same spec hashes, different bytes: both statements above are true at the same time.

**Alternatives considered.** Check the streams in (50 MB of binary in git, and no way to see what made them). Two-pass VBR (slower, and no determinism benefit). Ignore thread dependence and pin `-threads 1` (the encode takes about 60 % longer on this machine).

**Consequences.** CI generates its own streams (the cache is per runner and per ffmpeg build) and tests never assert a content hash across environments. Byte-for-byte reproducibility on one machine is a regression test for the generator: any change to a segment is a change to code or to a spec.

**Defending it.** "I did not trust it, I tried to break it: first one clip at 1, 2, 3 and 4 threads, which found that row-mt changes the bitstream, then the whole catalog at 1 and 4 threads. I can tell you exactly what I promise (same ffmpeg build, same bytes, any thread count)
and what I do not (another build)."

## ADR-046: The live loop is a rewrite of `tfdt`, not a re-encode and not a Period per loop

**Context.** The live source is 24 s. A soak test has to run for hours, with timestamps that keep increasing, from content that is encoded once.

**Decision.** Live segment `n` is source segment `((n-1) mod 12) + 1` with the `baseMediaDecodeTime` of every fragment moved by `floor((n-1)/12) x loopTicks` of **its own track** (`rewriteTfdt`, `MediaStore.liveSegment`).
The function copies the segment and patches the 8 bytes of each `tfdt` in place, so everything else is byte-identical (property-tested: delta 0 is the identity; `a` then `b` equals `a + b`; only the `tfdt` bytes differ; a version 0 field never wraps, it throws).
Initialization segments are unchanged. The result is simulated for 1000 loops (12,000 segments per track): every segment starts where the previous one ended (`start(n+1) == start(n) + duration(n)`) in both tracks, and audio and video are at the same instant at every loop boundary, to the tick.
The same is checked on the bytes the real store serves, and by ffprobe on a window around segment 100 and on one that straddles a loop boundary (ADR-048). There is no cache of rewritten buffers: a rewrite is one buffer copy (a segment is at most about 450 KB, the top rung) plus a handful of
patched bytes, and an HTTP response needs a buffer anyway. That is by construction, not by measurement: this work was not allowed to take performance measurements on a shared host.

**Alternatives considered.** Run ffmpeg in real time (non-deterministic and CPU-hungry, which would distort the performance runs the lab exists to take). A new `Period` per loop (players treat a period change as a transition, so a soak would test period switching instead of the live edge).
HLS `#EXT-X-DISCONTINUITY` at each wrap (the loop becomes a visible discontinuity). Presentation time offsets in the manifest (every client implements them slightly differently). One very long pre-encoded file (it would still need a loop).

**Consequences.** One limit follows from the contract's "byte-identical everywhere else": `mfhd.sequence_number` repeats every loop (1 to 12, then 1 to 12 again) instead of increasing. No player or demuxer used here reads it (ffmpeg and browsers ignore it for MSE and HLS), but a validator
that insists on increasing fragment sequence numbers would object. The picture repeats every 24 s with its timestamp restarting at 0: that is intentional, it makes the loop visible.

**Defending it.** "The loop is the whole difficulty of simulating live with a pre-encoded file, and it is eight bytes of arithmetic per fragment. I made the arithmetic exact (ADR-042), tested it with properties instead of examples, ran it for a thousand loops, and had a real demuxer
read across the boundary. The `mfhd` sequence number is the one thing I know is not monotonic, and I say so."

## ADR-047: A content-addressed cache, installed atomically, verified by hash on demand

**Context.** Streams take minutes to generate and must never be served half written; several processes (a CI job, a developer's server, the verification tool) may look at the same directory.

**Decision.**

- Layout: `.cache/streams/<specHash>/<streamId>/stream.json` + `<rep>/init.mp4|webm` + `<rep>/<n>.m4s|webm`. `stream.json` holds the `StreamIndex`, the spec hash, the generator version, the ffmpeg version, the generation time and the size and sha256 of every file;
  the stream's `contentHash` is the sha256 over the spec hash and every file's path and hash.
- Generation writes into `<specHash>/.tmp-<id>-<pid>-<random>/` and installs the finished directory with **one rename**; `stream.json` is part of that directory, so a stream directory that exists is complete. A forced or repaired install moves the old directory aside first.
  Temporary directories of processes that died are removed at the start of the next run (only when their pid is gone).
- "Complete" means: `stream.json` matches the spec hash and the generator version, the index satisfies its invariants, `contentHash` matches the file hashes, and every listed file exists with its recorded size. That costs milliseconds, is what a no-op run and `MediaStore.has()` use, and starts no ffmpeg.
  `--verify` additionally re-hashes every file and fails, naming the file, on a mismatch.
- `createMediaStore` decides readiness once, at construction; it never throws for a missing or damaged stream and says why in the error of `index()`.
- Real run: first generation 112.2 s; the second run 0.68 s including Node and tsx start-up (no ffmpeg is started: a unit test proves it by pointing `PB_FFMPEG` at nothing); `--verify` of all 43.46 MB in 282 files, 0.45 s for the whole command.

**Alternatives considered.** Generate into the final directory and write `stream.json` last (a crash leaves something that looks like a stream, and a reader can see it half written). Hash every file on every start (cheap here, but it blurs "complete" and "intact").
A lock file (needs stale-lock handling, and the rename already gives the atomicity).

**Consequences.** A file changed on disk without changing its size is found only by `--verify` (a unit test documents it). Two generators racing on one stream both finish, the later install wins, and the bytes are identical because the content is deterministic.

**Defending it.** "'Looks complete' and 'is complete' are different, and the cheap trick is to make the first imply the second: build elsewhere, rename once. Then 'is it intact' is a separate question with a separate switch, and the answer takes half a second."

## ADR-048: The verification does not trust the code it verifies

**Context.** A parser that marks its own output valid proves nothing. Every number the manifests carry has to be checked by something that has never seen this repository's code.

**Decision.** `npm run verify:streams` (`tools/verify-streams.ts`) checks every stream against ffprobe and ffmpeg:

1. `init + segment 1 + ... + segment N` of every representation is written to a file and decoded with `ffmpeg -xerror`: no error; frame counts equal 30 x duration for video (1800 for `vod-cmaf`) and the cutting rule's count for audio; audio and video lengths agree within one audio frame.
2. For every segment, the first-sample time and duration the lab's parser reports equal ffprobe's packet-level numbers. **Packets are assigned to segments by their byte position in the concatenated file**, not by the parser's own sample counts, and a segment's duration
   is where the next one starts. Packet counts per segment must equal the oracle (94, 94, 94, 93 for AAC, 60 for video). Packets must be gapless and overlap-free.
3. Every video segment starts with a key frame and holds exactly one; all rungs have identical segment starts (read from ffprobe, not from the index).
4. Manifests: a local server lays the files out as the contract's URLs say. **HLS** goes through ffmpeg's HLS demuxer (master and playlists; VOD; a live window of 15 segments around n = 100, where the 12-segment loop has wrapped 8 times; and a window of segments 10 to 16 that straddles a loop boundary):
   streams, codecs, durations, decoding, and per-stream timestamps that must be monotonic and gapless across the wrap. **DASH** goes through an independent DASH client (`tools/lib/dash-client.ts`) that expands the `SegmentTemplate` and `SegmentTimeline` like a player,
   fetches the init segment and every listed segment over HTTP, and compares the times the MPD **claims** (`S@t`, `S@d`) with the times ffprobe **finds** in the bytes, plus codecs, sizes, channels, the declared bandwidth against the measured peak, the `UTCTiming` URL and the same live windows.
   Whenever the ffmpeg build has a DASH demuxer, the tool also reads the MPD through it.
5. It prints a table (stream, representations, segments, bytes, duration, content hash, checks passed), lists skipped checks, and exits non-zero on any failure.
6. For the encrypted stream, ffmpeg decrypts every representation with the key and has to reproduce the unencrypted twin (packets and frames), must fail without the key, and the init segments and the manifest must name the same key id (ADR-049).

Findings that came from running it, not from design: (a) the Homebrew ffmpeg 9.0.2 of the dev host has **no DASH demuxer** (it is built without libxml2; Ubuntu's 6.1.1 has one), so `ffprobe manifest.mpd` cannot be the DASH check there: hence the independent client (the demuxer
checks are reported as skipped, not as passed) and the Docker run, where the real demuxer exists. (b) ffprobe reports Opus-in-WebM packets at *block timecode minus the track's `CodecDelay`* (6.5 ms, 7 ticks): the check applies that documented offset; the cluster timecodes themselves are on
the 2000 ms grid. (c) ffprobe leaves video packet durations empty in fMP4, so a video segment's duration is taken from where the next one starts. (d) Running generation under ffmpeg 6.1 in Docker found the missing `DefaultDuration` (ADR-044). (e) The same run found two defects of the tool itself that the dev host could not show:
ffprobe 6.1 omits the duration of the first packet of a stream (9.0 prints it), which the tool now fills in from the timestamp spacing for that one packet (any other missing duration still fails the checks that need it), and the DASH-demuxer path used `-map` before `-i` and the HLS-only `-live_start_index`,
which the 9.0.2 host never executed because it has no DASH demuxer. After the fixes the Docker run passes 407 of 407 checks with nothing skipped (all five streams, including both live windows and the encrypted stream through the real DASH demuxer), and the loop-boundary window is gapless in all four tracks.

**Alternatives considered.** Validate with the lab's own parser (circular). Only `ffprobe manifest.mpd` (does not exist for DASH on the dev host, and a demuxer's live mode tolerates things a player does not). Browsers (not allowed for this component, and they would test the browser).

**Consequences.** The tool takes about 23 s for the catalog on this machine and needs ffmpeg and ffprobe (as does generation). Its DASH route is a reading of the standard that I wrote, which is why the builders are also tested by a round trip through it and by a strict XML reader,
and why the demuxer-based check runs in Docker. Ports 4620 to 4629 only; the server is always closed.

**Defending it.** "Verification that shares code with the thing it verifies is a mirror. This one asks ffprobe what is in the bytes and asks the manifest what it claims, and fails if they differ. When the tool I wanted, the DASH demuxer, was not on this machine, I said so,
built the next best independent thing, and ran the real one in Docker."

## ADR-049: ClearKey (`vod-cmaf-clearkey`): CENC AES-CTR applied by the lab after the cut

**Context.** The lab wants one encrypted stream for ClearKey tests (`v360` + `a-aac`, CENC AES-CTR, a public throw-away key pair, DASH only, `ContentProtection` in the manifest). The preferred way is ffmpeg's own `-encryption_scheme cenc-aes-ctr`; writing the encryption by hand is acceptable only when that is small and ffmpeg's own decryption (`-decryption_key`) can verify it.

**What was measured before deciding.**

- ffmpeg 9.0.2 (the dev host) can do it: with the pinned VP9 plan the muxer writes `encv` with `sinf`/`tenc` and, in every `traf`, `senc`, `saio` and `saiz`; two runs under `-fflags +bitexact` are byte-identical (the IV is a counter from 0);
  `ffmpeg -decryption_key` returns exactly the unencrypted stream (360 of 360 packets and decoded frames equal) and fails without the key or with a wrong one.
- **ffmpeg 6.1.1, the version of the CI image (Ubuntu 24.04), cannot.** It encrypts the samples but writes no per-fragment information: `senc`, `saio` and `saiz` appear once, empty, inside the `stbl` of the init segment, and none of the fragments' `traf` boxes has them. Its own demuxer then cannot read what its muxer wrote:
  on a 6 s clip (180 frames) `ffmpeg -decryption_key ... -c copy` returns 0 packets (the unencrypted twin: 180), and without the key it stops with "saio atom found without saiz". None of six `-movflags` combinations changes that. The upstream source says the same:
  `ff_mov_cenc_write_stbl_atoms` is called from the fragment writer only from release 8.0 on (`libavformat/movenc.c` read at the tags n6.1.1, n7.0, n7.1, n8.0).
- The lab re-cuts the audio on its own grid and drops the AAC priming sample (ADR-042), so per-sample information has to be sliced and moved anyway, whoever writes it.

**Decision.** The lab encrypts, after the cut, with one code path that behaves the same on every ffmpeg (`src/server/media/cenc.ts`):

- AES-128 in CTR mode through Node's `crypto`; the counter block is the sample's 8-byte IV followed by a 64-bit block counter that starts at 0 for every sample; whole samples, no subsample map. The IV of a sample is its index in the track's own timeline (video 0 to N-1, audio 0 to N-1 after the priming sample is gone).
- `protectInit` turns the one sample entry `vp09` / `mp4a` into `encv` / `enca` and appends a `sinf` (`frma` = the real format, `schm` = `cenc` 1.0, `schi` > `tenc`: protected, 8-byte IVs, the key id), the layout ffmpeg writes too. `buildMediaSegment` writes `senc`, `saio` and `saiz` after the `trun`; `saio` points at the first IV and `saiz` says every sample's information is its IV.
  The reader checks all three against each other and against the sample count.
- The stream's ffmpeg plans are the plans of an unencrypted stream, so its plaintext is exactly the unencrypted twin's; `drm` is part of the spec and so of the cache key. The key pair is public (16 ASCII bytes each, `StreamInfo.drm`).
- The DASH manifest carries `ContentProtection` for `urn:mpeg:dash:mp4protection:2011` (`value="cenc"`, `cenc:default_KID` as a UUID) and for the ClearKey system id in both AdaptationSets, before the `SegmentTemplate` as the schema orders them; the key is never in it.

**Why this is not hand-rolled cryptography.** The cipher is the platform's AES-128-CTR, checked against the published vector NIST SP 800-38A F.5.1 (a unit test). What the lab wrote is the framing: which bytes are encrypted under which counter, and the boxes. Framing is what a decryptor tells you if it is wrong, and the decryptor is not the lab's:
`tools/verify-streams.ts` generates the same spec without encryption into its scratch directory and requires that **ffmpeg with the key** turns every encrypted representation into exactly the unencrypted twin, packet by packet (the plaintext bytes) and frame by frame (360 and 562 of them for the 12 s stream),
that without the key or with a wrong one it does **not**, that the init segments name the right key id (a literal byte scan, not the lab's parser) and that the manifest's `cenc:default_KID` is the init segment's. In Docker, ffmpeg 6.1.1's real DASH demuxer reads the MPD and decodes the stream end to end with `-cenc_decryption_key`.
Mutation checks: putting the IV into the other half of the counter block, and writing the `senc` entries in reverse order, each fail the unit tests and the ffmpeg decryption. Under ffmpeg 6.1.1 in Docker the stream is generated and verified with the same 52 checks (the 48 of the dev host plus the four of the real DASH demuxer).

**Alternatives considered.** ffmpeg's encryption where it exists and the lab's where it does not (two code paths whose bytes differ by build, and nothing gained over one path that works everywhere). Requiring ffmpeg 8.0 or later (not the CI image). A packager such as Bento4 or Shaka Packager (a new dependency for 12 s of media).
Checking in encrypted fixtures (no way to see what made them).

**Consequences and limits.**

- The key is public and the IVs are counters, and video sample `i` and audio sample `i` use the same IV under the same key: for real content that would be a keystream reuse. It is a fixture that protects nothing, and says so.
- **Not tried in a browser** (no browsers were allowed for this component): what is verified is that ffmpeg decrypts it and that the manifest and the init segments agree on the key id. The whole VP9 sample is encrypted, without leaving the uncompressed header in the clear; the software ClearKey implementations of browsers decrypt before decoding, but a decryptor that
  needs the header in the clear would need a subsample map in `senc` (a local change in `cenc.ts` and the writer). No `pssh` box is written: a player is expected to start from the manifest's `ContentProtection` with the key configured (`clearKeys` in Shaka).
  **Since measured** (PB-EME-001, [ADR-104 and ADR-105](e2e-eme.md)): the stream plays unchanged, with this layout, in Chromium 156 and Firefox 157 through the browser's own ClearKey module, and in macOS WebKit 27.2 because Shaka 5.3.3 decrypts it itself; Playwright's Linux WebKit has no EME. Neither the missing `pssh` nor the whole-sample VP9 was a problem, so the layout, and the content hash, did not change.
- DASH only, VOD only, one key for both tracks, `cenc` (AES-CTR) and no `cbcs`.

**Defending it.** "My first choice was ffmpeg's own encryption. It works on my laptop and not on the CI image, and I proved that from a run and from the upstream source before writing a line. So I wrote one small path that behaves the same everywhere, used the platform's AES for the cipher, and had ffmpeg's own decryption judge it against an unencrypted
twin, with a negative control. If I had got the counter wrong, ffmpeg would have shown me noise; it showed me the same 360 frames."
