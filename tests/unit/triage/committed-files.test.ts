import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { containsSecret, redact, redactValue } from '../../../triage/redact.ts';

// What is committed from the real failures of the lab (fixtures, results) and what is written about them must hold no secret and nothing of
// the machine or the person that ran the experiments. tools/triage-fixture.ts refuses to write a fixture that does; this reads what is in the
// repository, so that a file added or edited by hand cannot put one there. The name of the user and of the host are read at run time, so that
// no file of the repository has to hold them.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATA = ['tests/fixtures/triage', 'docs/results/triage'];
const PROSE = ['docs/TRIAGE.md', 'docs/decisions/triage.md'];
const CODE = ['triage', 'tests/unit/triage'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const data = DATA.flatMap((dir) => walk(join(ROOT, dir)));
const prose = PROSE.map((file) => join(ROOT, file));
// The code and the tests write their own samples of home paths and addresses (the redaction is tested on them), so only the name of this
// machine's user and host is looked for there.
const code = [
  ...CODE.flatMap((dir) => walk(join(ROOT, dir))),
  ...readdirSync(join(ROOT, 'tools'))
    .filter((name) => name.startsWith('triage-'))
    .map((name) => join(ROOT, 'tools', name)),
];
const relative = (path: string): string => path.slice(ROOT.length);
const read = (path: string): string => readFileSync(path, 'utf8');

/** Files whose text matches, by name: a test that fails says which file, and never prints what it found. */
const offenders = (files: readonly string[], matches: (text: string) => boolean): string[] =>
  files.filter((file) => matches(read(file))).map(relative);

/**
 * Names that say nothing about a person or a host: the accounts and hosts of CI services and containers, which this repository writes
 * about (a Jenkins agent runs as `jenkins`: its own documents name it, and the first Jenkins build that ran the unit tests of triage
 * failed here because of it).
 */
const GENERIC_NAMES = [
  'root',
  'localhost',
  'runner',
  'ubuntu',
  'github',
  'jenkins',
  'agent',
  'node',
  'docker',
  'builder',
];

/** What of the name of a user and of a host could identify a person or a machine of this repository's authors. */
function namesOfThisMachine(username: string, host: string): string[] {
  return [username, host.split('.')[0] ?? '']
    .map((name) => name.trim())
    .filter((name) => name.length >= 4 && !GENERIC_NAMES.includes(name.toLowerCase()));
}

describe('PB-LAB-005 triage: what is committed holds no secret and nothing of a machine', () => {
  it('has the fixtures and the results to check', () => {
    expect(data.filter((file) => file.includes('tests/fixtures/triage/')).length).toBeGreaterThan(100);
    expect(data.some((file) => file.endsWith('docs/results/triage/triage-report.json'))).toBe(true);
    expect(data.some((file) => file.endsWith('docs/results/triage/README.md'))).toBe(true);
    expect(code.some((file) => file.endsWith('tools/triage-mock.ts'))).toBe(true);
    expect(code.length).toBeGreaterThan(30);
  });

  it('holds no token, key, credential or secret assignment of any kind the redaction knows', () => {
    expect(offenders([...data, ...prose], (text) => containsSecret(text) !== null)).toStrictEqual([]);
  });

  it('names no home directory, no CI workspace, no email and no system path of a machine', () => {
    const personal =
      /(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\|\/private\/var\/|\/var\/folders\/)[^\s/\\'"`]+|\/github\/workspace|\/var\/lib\/jenkins\/workspace/;
    expect(offenders([...data, ...prose], (text) => personal.test(text))).toStrictEqual([]);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
    expect(offenders(data, (text) => email.test(text))).toStrictEqual([]);
  });

  it('names no host of a network in the data: the redaction leaves nothing it would take out', () => {
    // The data of a result is what `--redact` leaves, and the fixtures what the reducer leaves: neither may still hold a name the
    // redaction would replace (a corporate hostname, a home directory). The lab's own address, 127.0.0.1, is evidence and stays.
    const hostnames =
      /\b(?!shaka\.)(?:[A-Za-z0-9-]+\.)+(?:internal|local|lan|corp|intranet|home|localdomain)\b/i;
    expect(offenders(data, (text) => hostnames.test(text))).toStrictEqual([]);
  });

  it('takes the account of a CI service, or a generic host, for the name of no person, and keeps the names that identify one', () => {
    expect(namesOfThisMachine('jenkins', 'agent')).toStrictEqual([]);
    expect(namesOfThisMachine('Jenkins', 'a1b2c3d4e5f6')).toStrictEqual(['a1b2c3d4e5f6']);
    expect(namesOfThisMachine('runner', 'localhost')).toStrictEqual([]);
    expect(namesOfThisMachine('root', 'ubuntu.example')).toStrictEqual([]);
    expect(namesOfThisMachine('alice', 'alices-laptop.local')).toStrictEqual(['alice', 'alices-laptop']);
    expect(namesOfThisMachine('bob', 'ab')).toStrictEqual([]);
  });

  it('does not carry the name of the person or of the host that ran the experiments', () => {
    const names = namesOfThisMachine(userInfo().username, hostname());
    for (const name of names) {
      const pattern = new RegExp(
        `(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`,
        'i',
      );
      expect(
        offenders([...data, ...prose, ...code], (text) => pattern.test(text)),
        'a name of this machine',
      ).toStrictEqual([]);
    }
  });

  it('is a fixed point of the redaction of the summarizer: nothing is left in the committed reports that it would take out', () => {
    const reports = data.filter((path) => /triage-report\.(md|json)$/.test(path));
    expect(reports.length).toBeGreaterThanOrEqual(4);
    for (const file of reports) {
      // `--redact` redacts the values of the report (a number such as `inputTokens: 1044` is not a secret, whatever its name), and the text
      // of the Markdown.
      if (file.endsWith('.json')) {
        const parsed: unknown = JSON.parse(read(file));
        expect(redactValue(parsed), relative(file)).toStrictEqual(parsed);
      } else {
        // The Markdown escapes `<` and `>` after the redaction (a placeholder is `&lt;host&gt;` there): read it as the person does.
        const plain = read(file).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        expect(redact(plain) === plain, relative(file)).toBe(true);
      }
    }
  });
});
