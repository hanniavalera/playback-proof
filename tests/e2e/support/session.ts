import type { ServiceClient } from '../../../src/lab/service-client.ts';
import type { SessionInfo } from '../../../src/shared/api.ts';

/**
 * A session made by `newSession`: every field of its `SessionInfo` (`id`, `manifestUrl`, `live`...), plus the service it lives on,
 * which is what `waitForRequest` and the log helpers need. The service client is the only thing added.
 */
export type TestSession = SessionInfo & { readonly service: ServiceClient };
