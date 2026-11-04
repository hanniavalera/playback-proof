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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const data = DATA.flatMap((dir) => walk(join(ROOT, dir)));
const prose = PROSE.map((file) => join(ROOT, file));
const relative = (path: string): string => path.slice(ROOT.length);
const read = (path: string): string => readFileSync(path, 'utf8');

/** Files whose text matches, by name: a test that fails says which file, and never prints what it found. */
const offenders = (files: readonly string[], matches: (text: string) => boolean): string[] =>
  files.filter((file) => matches(read(file))).map(relative);

describe('PB-LAB-005 triage: what is committed holds no secret and nothing of a machine', () => {
  it('has the fixtures and the results to check', () => {
    expect(data.filter((file) => file.includes('tests/fixtures/triage/')).length).toBeGreaterThan(100);
    expect(data.some((file) => file.endsWith('docs/results/triage/triage-report.json'))).toBe(true);
    expect(data.some((file) => file.endsWith('docs/results/triage/README.md'))).toBe(true);
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

  it('does not carry the name of the person or of the host that ran the experiments', () => {
    const names = [userInfo().username, hostname().split('.')[0] ?? '']
      .map((name) => name.trim())
      .filter(
        (name) => name.length >= 4 && !['root', 'localhost', 'runner', 'ubuntu', 'github'].includes(name),
      );
    for (const name of names) {
      const pattern = new RegExp(
        `(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`,
        'i',
      );
      expect(
        offenders([...data, ...prose], (text) => pattern.test(text)),
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
