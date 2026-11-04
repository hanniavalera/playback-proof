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

/** How long the player plays at the far position in PB-VOD-008 before the way back: enough for it to append there and move its playhead on. */
export const EVICTION_PLAY_SEC = 3;

// ---- Where the clock is, in seconds

/**
 * How close to the end of the title `ended` must fire. The video track is exactly as long as the title (`durationSec`), the audio ends up
 * to one frame (21.3 ms) before it and the last video frame is 33 ms long, so an `ended` that comes from the clock reaching the end of the
 * media is within about 55 ms of `durationSec`; it was measured within 0.000001 s of it in every engine. 0.1 s is three video frames. A
 * title cut short by a missing last segment ends two seconds early, or never.
 */
export const END_TOLERANCE_SEC = 0.1;

/**
 * How far from the target a seek may land. Every engine reports the target to within a frame: measured 0 to 0.049 s past it (the
 * largest, once, in Linux WebKit with the container busy), and 0.0002 to 0.0008 s in Chromium. A quarter of a second is five times the
 * largest of those, and a quarter of what a landing at the start of the segment costs: every target of the specs is the middle of a
 * segment, a whole second from either boundary.
 */
export const SEEK_LANDING_TOLERANCE_SEC = 0.25;

/**
 * How far past the position a wait was for the clock may be when the wait returns: the wait is driven by `timeupdate` and by video
 * frames, so it overshoots by a frame or two (0 to 0.067 s measured in the four engines). Half a second is seven times that, and a
 * jump of the clock (to the start of a segment, to the next one) is a second or more.
 */
export const CLOCK_OVERSHOOT_TOLERANCE_SEC = 0.5;

/**
 * How far the media time of the resumed player may be from where it was paused. A resume is not instantaneous: the `playing` event came
 * 0 to 0.101 s of media time after the paused position (Firefox once 0.101 s, Chromium a steady 0.05 s, Linux WebKit up to 0.079 s).
 * A jump is a segment or a GOP long (2 s); the pause is placed in the middle of one, so a rewind to its start or a skip to the next is
 * a second away: half a second is five times the largest latency and half the smallest jump.
 */
export const RESUME_TOLERANCE_SEC = 0.5;

/** How far from the start of the title the first `playing` of a restart after `ended` may be: measured 0 to 0.074 s. */
export const RESTART_TOLERANCE_SEC = 0.5;

// ---- Frames and clocks of the instrument (PB-VOD-012)

/**
 * How many frames the decoded and the presented counters of an uninterrupted first play may differ by, once the frames the clock ran
 * through before the first presented frame are added back (the presented counter starts at the first frame callback). The decoder runs
 * ahead of the presentation by the frames its output queue holds: 3 to 7 in Chromium and WebKit at about 3 s of play, the presented
 * counter ahead by up to 3 in Firefox (ADR-065), and within one frame in nine of nine Linux WebKit runs after the correction (raw 0 to 14
 * with the container busy). Ten frames are a third of a second of 30 fps video and 1.4 times the largest of those; a counter that
 * doubles, repeats or restarts differs by a second of video or more.
 */
export const FRAME_AGREEMENT_TOLERANCE = 10;

/** The effective frame rate of a window may be this share off the frame rate of the stream (27 to 33 fps for 30): every window measured in the four engines was exactly 30. */
export const FPS_TOLERANCE_SHARE = 0.1;

/** The media time `measureFrames` looks at: long enough to hold sixty frames, short enough for a test of a few seconds. */
export const FRAME_WINDOW_SEC = 2;

/** The resolution of the clocks compared across processes (the origin's milliseconds are integers or hundredths, the page's are fractions): two milliseconds. */
export const CLOCK_RESOLUTION_MS = 2;
