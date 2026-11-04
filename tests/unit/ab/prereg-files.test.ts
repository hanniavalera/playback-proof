import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPreregistration } from '../../../ab/prereg.ts';

// Every pre-registration committed under ab/prereg/ is valid, and is named for its id: a plan that does not validate must fail here, in the
// unit tests, and not for the first time when the runner is started on a machine that was set aside for it.

const folder = resolve(import.meta.dirname, '../../../ab/prereg');
const files = readdirSync(folder)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('PB-AB the pre-registrations committed in ab/prereg', () => {
  it('has the pipeline check', () => {
    expect(files).toContain('pipeline-check.json');
  });

  it.each(files)('%s is a valid pre-registration, named for its id', (name) => {
    const loaded = loadPreregistration(join(folder, name));
    expect(loaded.prereg.id).toBe(name.replace(/\.json$/, ''));
  });

  it('runs six sessions of one condition: a warm-up block and two measured blocks, with no hypothesis about B', () => {
    const { prereg } = loadPreregistration(join(folder, 'pipeline-check.json'));
    expect(prereg.kind).toBe('pipeline-check');
    expect(prereg.conditions).toHaveLength(1);
    expect(2 * (prereg.warmupSessionsPerArm + prereg.sessionsPerArm)).toBe(6);
    expect(prereg.engine).toBe('chromium');
  });
});
