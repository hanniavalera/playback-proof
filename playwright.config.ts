import { defineConfig, devices } from '@playwright/test';

// One config for the three engines plus the CPU-throttled "low-end TV" profile. See docs/CONTRACTS.md.
//
//   npx playwright test --project=chromium --grep @merge
//
// Environment:
//   PB_PORT     port of the test data service (default 4600). Every agent/CI job uses its own, see docs/CONTRACTS.md.
//   PB_WORKERS  parallel workers (default 4 locally, 2 in CI). Performance runs never use this config: they run alone.
const PORT = Number(process.env.PB_PORT ?? 4600);

export default defineConfig({
  testDir: 'tests',
  testMatch: ['e2e/**/*.spec.ts', 'live/**/*.spec.ts'],
  // Fails fast, before the first test, when the service cannot serve the streams or the player page.
  globalSetup: './tests/e2e/support/global-setup.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry in CI. A retry that turns red into green is not hidden: the flake tracker records it (flake/), and the
  // flake gate fails the build when the rate passes its threshold. Locally there is no retry.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.PB_WORKERS ? Number(process.env.PB_WORKERS) : process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/playwright.json' }],
    ['html', { open: 'never', outputFolder: 'reports/html' }],
    // Records every attempt of every test in reports/flake/run.json: the source of the flake history (flake/, docs/FLAKE.md).
    ['./flake/reporter.ts'],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Autoplay in headless engines is allowed for muted media; the player page mutes by default (see docs/CONTRACTS.md).
    launchOptions: {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Chromium with CDP Emulation.setCPUThrottlingRate (a 4x slowdown) to stand in for a low-end TV or set-top box.
    // The throttle is applied by the shared fixture from this metadata (tests/e2e/support). Firefox and WebKit have no equivalent.
    {
      name: 'chromium-cpu4x',
      use: { ...devices['Desktop Chrome'] },
      metadata: { cpuThrottleRate: 4 },
      grep: /@cpu/,
    },
  ],
  webServer: {
    // The player bundle is built first (the service serves dist/player), then the service starts. The service refuses to start when
    // a stream is missing and prints "run npm run generate:streams"; stdout and stderr are piped so that message stays visible.
    command: 'npm run build:player && npm run serve',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { PB_PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
