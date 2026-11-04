import { execFileSync } from 'node:child_process';
import type { PreregistrationProvenance } from './results.ts';

// Where the plan came from: was the pre-registration file committed, unmodified, when the run started, and in which commit? A hash alone
// shows that the plan did not change between the run and the report; the commit shows that it existed before the data did.

/** Runs `git` with these arguments in the repository and returns its trimmed output, or null when it fails or git is not there. */
export type GitRunner = (args: readonly string[]) => string | null;

export function gitRunnerFor(root: string): GitRunner {
  return (args) => {
    try {
      return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
}

/**
 * `clean`: git says the file has no change against HEAD and is tracked. `commit` and `date`: the last commit that touched it (author date,
 * ISO 8601). The whole answer is null when git cannot say (no repository, or a container that cannot see the git directory of a worktree).
 */
export function preregistrationCommit(path: string, git: GitRunner): PreregistrationProvenance['committed'] {
  const tracked = git(['ls-files', '--error-unmatch', '--', path]);
  const status = git(['status', '--porcelain', '--', path]);
  if (status === null) return null;
  if (tracked === null) return { clean: false, commit: null, date: null };
  const last = git(['log', '-1', '--format=%h%n%aI', '--', path]);
  const [commit, date] = (last ?? '').split('\n');
  return { clean: status === '', commit: commit || null, date: date || null };
}

/** One sentence for the report: what the provenance proves, or does not. */
export function describeProvenance(
  committed: PreregistrationProvenance['committed'],
  runStartedAt: string,
): { proves: boolean; sentence: string } {
  if (committed === null)
    return {
      proves: false,
      sentence:
        'Git could not say whether the pre-registration was committed before the run: this report cannot prove the plan was fixed first.',
    };
  if (!committed.clean || committed.commit === null)
    return {
      proves: false,
      sentence:
        'The pre-registration file was NOT committed, unmodified, when the run started: this report does not prove the plan was fixed before the data.',
    };
  const before = committed.date !== null && Date.parse(committed.date) <= Date.parse(runStartedAt);
  return before
    ? {
        proves: true,
        sentence: `The pre-registration file was committed unmodified in ${committed.commit} on ${committed.date}, before the run started (${runStartedAt}).`,
      }
    : {
        proves: false,
        sentence: `The pre-registration file is committed unmodified (${committed.commit}, ${committed.date}) but the commit is dated after the run started (${runStartedAt}): it does not prove the plan was fixed first.`,
      };
}
