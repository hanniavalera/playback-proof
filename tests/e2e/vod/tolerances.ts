// Every number a VOD spec compares a measurement with, in one place, each with what it was derived from. They are not guesses and not
// the numbers that happen to pass: each is set from the content of the lab's streams (30 fps, 2 s segments and GOPs, audio that ends up
// to one 21 ms frame before the video) and from what the four engines were measured to do (Chromium 156 and WebKit 27.2 on macOS,
// Firefox 157 and Linux WebKit 27.2 in the Playwright image with 3 CPUs; five runs of one recording spec in each, on the machine of
// ADR-092), with a margin over the largest value seen that is still far from the failure the check is there to find. ADR-092 has the table.

// ---- Waiting and watching

/** Media time a player must play after a seek, a resume or a restart for "playback went on from there" to be shown. */
export const CONTINUE_SEC = 1;

/**
 * A negative observation lets this many animation frames of the page go by (`observeFrames`). Thirty frames are half a second at 60 Hz;
 * the media clock of a playing player moved 0.47 to 0.61 s across them in Chromium, WebKit and Firefox and 0.78 to 1.31 s in Linux WebKit,
 * whose page paints at 23 to 38 frames a second in the container.
 */
export const OBSERVED_FRAMES = 30;

/** What the clock of a PLAYING player must advance across `OBSERVED_FRAMES` for "the paused clock did not move" to be able to fail: three video frames, a fifth of the smallest advance measured (0.47 s). */
export const MIN_CONTROL_ADVANCE_SEC = 0.1;

/** Real time on top of the media still to play that `waitForEnded` allows: a slow runner takes longer, and the wait is on the media clock, not the wall clock. */
export const END_MARGIN_MS = 15_000;

/** How long a spec whose `play()` was rejected looks on, in the failure, for the player to restart by itself: twice Shaka's `streaming.minTimeBetweenRecoveries` (5 s), the time it keeps between two resets of the MediaSource. It is a diagnosis and not a retry: the verdict is the rejection. */
export const RECOVERY_LOOKOUT_MS = 10_000;

/** How long the player plays at the far position in PB-VOD-008 before the way back: enough for it to append there and move its playhead on. */
export const EVICTION_PLAY_SEC = 3;

/**
 * From which media time on nothing is buffered for a player a few seconds into the title: the buffer reaches the playhead plus its
 * 10 s goal and the segment in flight (`[0, 14]` at 3 s of play in Chromium and WebKit, measured), so with the playhead below 4 s the
 * buffer ends before 16 s, and a seek to a position at or beyond it needs the origin.
 */
export const UNBUFFERED_FROM_SEC = 16;

// ---- Where the clock is

// There is no fixed distance in seconds here, on purpose. Every position of the media clock that a spec reads (the `seeked` event, the
// `playing` event after a resume or a restart, the return of `waitForMediaTime`) is read by the page, or by a call into the page, LATE
// when the page is starved, and the clock does not wait: it runs at rate 1 meanwhile. The first CI run on a 3-CPU macOS runner read
// `seeked` 0.3 to 0.4 s past a target and a wait for 8 s return at 11.4 s, where the same specs had read 0 to 0.1 s on an M2 Pro. A bound
// of the form "within X seconds of the position" is therefore a statement about the machine. The sound bound is about time: between two
// readings of the media clock, taken from a player at rate 1, the clock advanced no more than the wall clock did (plus a frame period
// and the resolution of the clocks), and did not go back by more than that. `expectClockPace` of `seeking.ts` is that bound; the wall
// clock it uses is the one of the test process (`stopwatch`), started before the call that began the span and read after the reading
// that ended it, so it brackets whatever the page did in between however late it did it. A real defect is far outside it: a landing at
// the start of the segment is a second before the target, a skip to the next segment or GOP is a second or two ahead of a wall clock
// that ran for a fraction of one.

/**
 * How close to the end of the title `ended` must fire. The video track is exactly as long as the title (`durationSec`), the audio ends up
 * to one frame (21.3 ms) before it and the last video frame is 33 ms long, so an `ended` that comes from the clock reaching the end of the
 * media is within about 55 ms of `durationSec`; it was measured within 0.000001 s of it in every engine. 0.1 s is three video frames. A
 * title cut short by a missing last segment ends two seconds early, or never. A late reading cannot move it: the clock stops at the end,
 * so the page reads the same position whenever it handles the event (a CI run on macOS read exactly 12 s of a 12 s title).
 */
export const END_TOLERANCE_SEC = 0.1;

// ---- Frames and clocks of the instrument (PB-VOD-012)

/**
 * How many frames the decoded counter may differ from the presented one plus the dropped one plus the frames the clock ran through
 * before the first presented frame. `getVideoPlaybackQuality().totalVideoFrames` is the frames displayed plus the frames dropped
 * (Media Playback Quality, "total video frame count"; Firefox's `GetTotalFrames()` is `mPresentedFrames + GetDroppedFrames()`; METRICS.md
 * defines the dropped ratio as dropped over decoded), so a decoded frame is either presented or dropped, and what is left is the decoder
 * running ahead of the presentation by the frames of its output queue, and the presented counter being stale: the page counts it in
 * frame callbacks, which a starved page runs late. Over the runs of the final series (readings of PB-VOD-012, at about 5 s of play):
 * decoded minus presented was 3 to 7 in Chromium (ten runs; the 7 was the run that dropped 7 frames, which the identity makes 0), 4 to 5
 * in WebKit (six), minus 2 to minus 1 in Firefox (six: the presented counter ahead) and, in Linux WebKit with the container busy, minus 1
 * to 1 after the correction for the first frame (26 runs). On the 3-CPU macOS runner the two WebKit runs that dropped 12 and 21 frames
 * differed by 22 and 24 frames before the dropped ones were counted and by 10 and 3 after. Fifteen frames are half a second of 30 fps
 * video: 1.5 times the largest difference that remains and half of what a counter that doubles, repeats or restarts shows (a second of
 * video or more).
 */
export const FRAME_AGREEMENT_TOLERANCE = 15;

/**
 * The most frames per media second a window may present, as a share of the stream's frame rate: a page cannot show more frames than
 * the stream has, and every window measured in an unloaded engine was exactly 30 fps (60 frames in 2 s), so 10 % is for the frame
 * callbacks at the two ends of the window.
 */
export const FPS_MAX_SHARE = 1.1;

/**
 * The fewest, as a share of the stream's rate: the instrument is alive. This is NOT a quality bound, and it is not tight on purpose:
 * Linux WebKit with the container busy presented 46 frames in 2 s (23 fps, 77 %) with 46 decoded, so the counters were right and the
 * machine slow, and a bound at 27 fps failed a correct instrument. Whether 30 fps is held is what the performance baselines measure
 * on a quiet machine (PB-PERF-002); half the stream's rate is where the picture is no longer playing at all, and a counter that
 * undercounts by half is also caught by the agreement of the two counters.
 */
export const FPS_MIN_SHARE = 0.5;

/** The media time `measureFrames` looks at: long enough to hold sixty frames, short enough for a test of a few seconds. */
export const FRAME_WINDOW_SEC = 2;

/** The resolution of the clocks compared across processes (the origin's milliseconds are integers or hundredths, the page's are fractions): two milliseconds. */
export const CLOCK_RESOLUTION_MS = 2;
