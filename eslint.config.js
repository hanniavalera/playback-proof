import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat config. The one project-specific rule: no fixed sleeps in specs. Tests wait on player events (window.__qa),
// never on the clock; a sleep is how a test becomes flaky. See docs/DESIGN_DECISIONS.md (ADR-006).
const noFixedSleeps = [
  {
    selector: "CallExpression[callee.property.name='waitForTimeout']",
    message:
      'No fixed sleeps. Wait on a player event: qa.waitFor(...), qa.waitForMediaTime(...), expect.poll is not a substitute.',
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message: 'No timers in specs. If you need a timeout, pass { timeoutMs } to the event wait.',
  },
  {
    selector: "CallExpression[callee.object.name='Atomics'][callee.property.name='wait']",
    message: 'No blocking sleeps.',
  },
];

// Letting time pass has exactly one home: PlayerHandle.observeFrames (tests/e2e/support/player.ts), which counts animation frames of
// the page for NEGATIVE observations. A spec that wants one calls that; it does not write its own frame loop.
const noAnimationFrames = [
  {
    selector: "CallExpression[callee.name='requestAnimationFrame']",
    message:
      'No frame loops in specs. For a negative observation use player.observeFrames(n); otherwise wait on a player event.',
  },
  {
    selector: "CallExpression[callee.property.name='requestAnimationFrame']",
    message:
      'No frame loops in specs. For a negative observation use player.observeFrames(n); otherwise wait on a player event.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'reports/**',
      'test-results/**',
      '.cache/**',
      'coverage/**',
      'docs/results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='eval']", message: 'No eval.' },
      ],
    },
  },
  {
    files: ['src/player/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Specs and the helpers they use: event-driven waits only, and no frame loops of their own.
    files: ['tests/e2e/**/*.ts', 'tests/live/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noFixedSleeps, ...noAnimationFrames] },
  },
  {
    // The one home of the frame loop (observeFrames).
    files: ['tests/e2e/support/player.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noFixedSleeps] },
  },
);
