// TEMPORARY placeholder so that the HTTP service can be built against the MediaStore interface in parallel with the media
// pipeline. The media pipeline branch (p2/media) replaces this file; nobody else edits it.

import type { MediaStore } from './types.ts';

export interface MediaStoreOptions {
  /** Root of the content-addressed stream cache. Default: <repo>/.cache/streams */
  cacheDir?: string;
}

export function createMediaStore(options: MediaStoreOptions = {}): MediaStore {
  throw new Error(
    `createMediaStore(${JSON.stringify(options)}) is not implemented yet (media pipeline, phase 2)`,
  );
}
