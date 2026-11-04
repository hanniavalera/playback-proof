import { describe, expect, it } from 'vitest';
import type { HealthInfo } from '../../../src/shared/api.ts';
import { STREAM_IDS } from '../../../src/shared/streams.ts';
import { describeUnreadyService } from '../../../tests/e2e/support/global-setup.ts';

function health(overrides: Partial<HealthInfo> = {}, missing: string[] = []): HealthInfo {
  return {
    status: 'ok',
    version: '0.1.0',
    ffmpeg: '9.0.2',
    streams: Object.fromEntries(
      STREAM_IDS.map((id) => [id, missing.includes(id) ? 'missing' : 'ready']),
    ) as HealthInfo['streams'],
    player: 'built',
    uptimeSec: 3,
    ...overrides,
  };
}

describe('describeUnreadyService: the global setup of the e2e suites', () => {
  it('accepts a service that has every stream and the player page', () => {
    expect(describeUnreadyService('http://127.0.0.1:4650', health())).toBeNull();
  });

  it('names the missing streams and the command that generates them', () => {
    expect(describeUnreadyService('http://127.0.0.1:4650', health({}, ['live-cmaf', 'vod-webm']))).toBe(
      'the test data service at http://127.0.0.1:4650 cannot serve the specs: it reports missing streams (vod-webm, live-cmaf): run `npm run generate:streams`; then start the service again',
    );
  });

  it('says when the player page is not built, and reports both problems at once', () => {
    expect(describeUnreadyService('http://x', health({ player: 'missing' }))).toContain(
      'it has no player page: run `npm run build:player`',
    );
    const both = describeUnreadyService('http://x', health({ player: 'missing' }, ['vod-cmaf'])) ?? '';
    expect(both).toContain('missing streams (vod-cmaf)');
    expect(both).toContain('no player page');
  });
});
