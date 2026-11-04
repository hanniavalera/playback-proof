import type { ServiceClient } from '../../../src/lab/service-client.ts';
import type { SessionInfo } from '../../../src/shared/api.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';

/**
 * A session made by `newSession`: every field of its `SessionInfo` (`id`, `manifestUrl`, `live`...), plus the service it lives on,
 * which is what `waitForRequest` and the log helpers need. The service client is the only thing added.
 */
export type TestSession = SessionInfo & { readonly service: ServiceClient };

/**
 * The catalog entry of the session's stream: duration, segment count, rungs, DRM test key, content hash. Specs read these from the
 * service and never hard-code them (src/shared/streams.ts): a seek target is a fraction of `durationSec`, not "30".
 */
export async function streamInfoOf(session: Pick<TestSession, 'stream' | 'service'>): Promise<StreamInfo> {
  const streams = await session.service.streams();
  const found = streams.find((stream) => stream.id === session.stream);
  if (!found) {
    throw new Error(
      `the service does not list the stream ${session.stream} (it lists: ${streams.map((s) => s.id).join(', ') || 'none'})`,
    );
  }
  return found;
}
