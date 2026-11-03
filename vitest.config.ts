import { defineConfig } from 'vitest/config';

// Unit and integration tests of the lab itself (media pipeline, fault engine, stats, flake math, triage...).
// The browser suites live under tests/e2e and tests/live and run with Playwright, not here.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The media tests shell out to ffmpeg; keep concurrency modest so they do not starve each other on small CI runners.
    pool: 'forks',
    maxWorkers: 4,
  },
});
