import { describe, expect, it } from 'vitest';
import { describeProvenance, preregistrationCommit } from '../../../ab/provenance.ts';
import type { GitRunner } from '../../../ab/provenance.ts';

// Where the plan came from: committed and unmodified before the run, or not.

const fakeGit =
  (answers: { tracked?: string | null; status?: string | null; log?: string | null }): GitRunner =>
  (args) => {
    if (args[0] === 'ls-files') return answers.tracked === undefined ? 'ab/prereg/x.json' : answers.tracked;
    if (args[0] === 'status') return answers.status === undefined ? '' : answers.status;
    if (args[0] === 'log')
      return answers.log === undefined ? 'abc1234\n2026-11-05T08:00:00-06:00' : answers.log;
    return null;
  };

describe('PB-AB provenance of the pre-registration', () => {
  it('a tracked, unmodified file reports the commit that last touched it and its date', () => {
    expect(preregistrationCommit('ab/prereg/x.json', fakeGit({}))).toStrictEqual({
      clean: true,
      commit: 'abc1234',
      date: '2026-11-05T08:00:00-06:00',
    });
  });

  it('a file with changes against HEAD is not clean, and a file git does not track has no commit', () => {
    expect(
      preregistrationCommit('ab/prereg/x.json', fakeGit({ status: ' M ab/prereg/x.json' })),
    ).toMatchObject({ clean: false, commit: 'abc1234' });
    expect(
      preregistrationCommit('ab/prereg/x.json', fakeGit({ tracked: null, status: '?? ab/prereg/x.json' })),
    ).toStrictEqual({
      clean: false,
      commit: null,
      date: null,
    });
  });

  it('is null when git cannot answer at all (no repository, a container that cannot see the git directory)', () => {
    expect(preregistrationCommit('ab/prereg/x.json', fakeGit({ status: null }))).toBeNull();
    expect(preregistrationCommit('ab/prereg/x.json', () => null)).toBeNull();
  });

  it('proves the plan was fixed first only when it was committed, unmodified, before the run started', () => {
    const proof = describeProvenance(
      { clean: true, commit: 'abc1234', date: '2026-11-05T08:00:00-06:00' },
      '2026-11-05T15:00:00.000Z',
    );
    expect(proof.proves).toBe(true);
    expect(proof.sentence).toContain(
      'committed unmodified in abc1234 on 2026-11-05T08:00:00-06:00, before the run started',
    );

    const late = describeProvenance(
      { clean: true, commit: 'abc1234', date: '2026-11-05T12:00:00-06:00' },
      '2026-11-05T15:00:00.000Z',
    );
    expect(late.proves).toBe(false);
    expect(late.sentence).toContain('dated after the run started');

    const dirty = describeProvenance(
      { clean: false, commit: 'abc1234', date: '2026-11-05T08:00:00-06:00' },
      '2026-11-05T15:00:00.000Z',
    );
    expect(dirty.proves).toBe(false);
    expect(dirty.sentence).toContain('was NOT committed, unmodified');

    expect(
      describeProvenance({ clean: false, commit: null, date: null }, '2026-11-05T15:00:00.000Z').proves,
    ).toBe(false);
    const unknown = describeProvenance(null, '2026-11-05T15:00:00.000Z');
    expect(unknown.proves).toBe(false);
    expect(unknown.sentence).toContain('Git could not say');
  });
});
