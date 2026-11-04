import type shakaTypes from 'shaka-player';
import { configFor, mergePatches } from './configs.ts';
import { PlayerHook } from './hook.ts';
import type { PlayerEnvironment, PlayerLike, VideoLike } from './hook.ts';
import { createHud } from './hud.ts';
import { clearKeyPatch, parsePlayerParams, withoutClearKey } from './params.ts';

// shaka.js, Shaka's own compiled build copied verbatim by tools/build-player.ts, is loaded by index.html before this script
// and defines this global. It is a second script rather than part of this bundle so that the page runs exactly the bytes
// that npm publishes (the build prints their hash), instead of a re-printed copy.
declare const shaka: typeof shakaTypes;

// The page. Order matters, and it is the contract of window.__qa:
//   1. the hook exists synchronously, so a test can `waitForFunction(() => window.__qa)` and then await `qa.ready`;
//   2. the hook listens to the media element before Shaka exists (see PlayerHook);
//   3. Shaka is built, configured and attached inside `boot`, which resolves `qa.ready`;
//   4. only then, if the page was given a manifest, does it load (and, if asked, play) by itself.

const video = document.getElementById('video') as HTMLVideoElement;
const { params, problems } = parsePlayerParams(location.search);

// A ClearKey pair is public, but a browser repeats the page's URL in some of its own console messages (Firefox does): once it is read it
// leaves the address bar, so that it stays out of the logs a failing test attaches.
const search = withoutClearKey(location.search);
if (search !== null) history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);

// Before any source is attached, so that autoplay is allowed in every engine without a gesture (or not, with muted=0).
video.muted = params.muted;

const hook = new PlayerHook({
  video: video as VideoLike,
  now: () => performance.now(),
  params,
  paramProblems: problems,
  userAgent: navigator.userAgent,
});
window.__qa = hook;

window.addEventListener('error', (event) =>
  hook.recordPageError('window.onerror', event.error ?? event.message),
);
window.addEventListener('unhandledrejection', (event) =>
  hook.recordPageError('unhandledrejection', event.reason),
);

const hud = document.getElementById('hud');
if (params.hud && hud) createHud(hud, video, hook);

/** A Shaka enum as { NAME: number }. TypeScript types a numeric enum with reverse (number to name) keys; Shaka's compiled object has none. */
const named = (enumObject: object): Record<string, number> =>
  Object.fromEntries(
    Object.entries(enumObject).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );

async function createEnvironment(): Promise<PlayerEnvironment> {
  shaka.polyfill.installAll();
  const player = new shaka.Player();
  await player.attach(video);
  return {
    // A structural subset of shaka.Player: the hook uses nothing outside it.
    player: player as unknown as PlayerLike,
    shakaVersion: shaka.Player.version,
    supported: shaka.Player.isBrowserSupported(),
    errorNames: { codes: named(shaka.util.Error.Code), categories: named(shaka.util.Error.Category) },
    loadModes: {
      notLoaded: shaka.Player.LoadMode.NOT_LOADED,
      mediaSource: shaka.Player.LoadMode.MEDIA_SOURCE,
      srcEquals: shaka.Player.LoadMode.SRC_EQUALS,
    },
  };
}

async function start(): Promise<void> {
  // The preset's overrides, plus the page parameters that are Shaka settings (ABR off, a ClearKey pair). Applied before anything loads.
  const patch = mergePatches(
    configFor(params.config),
    params.abr ? {} : { abr: { enabled: false } },
    clearKeyPatch(params.clearKey),
  );
  await hook.boot(createEnvironment, patch);
  try {
    await hook.ready;
    if (params.manifest) {
      await hook.load(params.manifest);
      if (params.autoplay) await hook.play();
    }
  } catch {
    // Already on the timeline as an error event (boot, load or play): the page stays up so that a test can read it.
  }
}

void start();
