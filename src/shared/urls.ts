import type { Protocol, StreamId } from './streams.ts';
import type { PlayerPageParams } from './qa.ts';

// One place that knows the URL layout, so the server, the player, the tests and the tools cannot drift apart.

export const DEFAULT_PORT = 4600;

export function manifestPath(sessionId: string, stream: StreamId, protocol: Protocol): string {
  return `/s/${sessionId}/${stream}/${protocol}/${protocol === 'dash' ? 'manifest.mpd' : 'master.m3u8'}`;
}

export function initPath(sessionId: string, stream: StreamId, rep: string, ext: string): string {
  return `/s/${sessionId}/${stream}/seg/${rep}/init.${ext}`;
}

export function segmentPath(
  sessionId: string,
  stream: StreamId,
  rep: string,
  num: number,
  ext: string,
): string {
  return `/s/${sessionId}/${stream}/seg/${rep}/${num}.${ext}`;
}

export interface ParsedPath {
  sessionId: string;
  stream: string;
  kind: 'manifest' | 'init' | 'segment' | 'media-playlist' | 'other';
  protocol?: Protocol;
  rep?: string;
  /** 1-based segment number. */
  number?: number;
}

/** Parses /s/<session>/<stream>/... paths. Returns null for anything outside that namespace. */
export function parseServicePath(pathname: string): ParsedPath | null {
  const m = /^\/s\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return null;
  const [, sessionId, stream, rest] = m as unknown as [string, string, string, string];
  let r: RegExpExecArray | null;
  if ((r = /^(dash)\/manifest\.mpd$/.exec(rest)) || (r = /^(hls)\/master\.m3u8$/.exec(rest))) {
    return { sessionId, stream, kind: 'manifest', protocol: r[1] as Protocol };
  }
  if ((r = /^hls\/([^/]+)\.m3u8$/.exec(rest))) {
    return { sessionId, stream, kind: 'media-playlist', protocol: 'hls', rep: r[1] };
  }
  if ((r = /^seg\/([^/]+)\/init\.[a-z0-9]+$/.exec(rest))) {
    return { sessionId, stream, kind: 'init', rep: r[1] };
  }
  if ((r = /^seg\/([^/]+)\/(\d+)\.[a-z0-9]+$/.exec(rest))) {
    return { sessionId, stream, kind: 'segment', rep: r[1], number: Number(r[2]) };
  }
  return { sessionId, stream, kind: 'other' };
}

/** URL of the player page for a manifest (path relative to the service origin). */
export function playerUrl(params: PlayerPageParams): string {
  const q = new URLSearchParams();
  if (params.manifest !== undefined) q.set('manifest', params.manifest);
  if (params.config !== undefined) q.set('config', params.config);
  if (params.autoplay !== undefined) q.set('autoplay', params.autoplay ? '1' : '0');
  if (params.muted !== undefined) q.set('muted', params.muted ? '1' : '0');
  if (params.start !== undefined) q.set('start', String(params.start));
  if (params.abr !== undefined) q.set('abr', params.abr ? '1' : '0');
  if (params.hud !== undefined) q.set('hud', params.hud ? '1' : '0');
  const s = q.toString();
  return `/player/${s ? `?${s}` : ''}`;
}
