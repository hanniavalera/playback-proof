import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../../../triage/cli.ts';
import { STEPS } from '../../../triage/redact.ts';
import { NO_RULE, RULES } from '../../../triage/rules.ts';
import { DEFAULT_API_VERSION, DEFAULT_MODEL } from '../../../triage/summarize.ts';
import { CATEGORIES } from '../../../triage/types.ts';

// The documentation of triage lists what the code has (the rules in their order, the categories, the redaction steps, the options, the
// variables), and a list written by hand drifts. These tests read the pages and fail when the code and the page disagree, so that adding a
// rule without its row, or a step without its name, is a failure of the unit stage and not a surprise for a reader.

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const guide = read('docs/TRIAGE.md');
const decisions = read('docs/decisions/triage.md');
const contracts = read('docs/CONTRACTS.md');
const LIVE_COMMAND =
  'ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-haiku-5-5 npm run triage -- --from reports --summarize';

describe('PB-LAB-005 triage documentation: the page says what the code has', () => {
  it('has a row for every rule, in the order of the table, and for the rule that stands for no match', () => {
    const at = RULES.map((rule) => guide.indexOf(`| \`${rule.name}\` |`));
    expect(at.filter((position) => position < 0)).toStrictEqual([]);
    expect([...at].sort((a, b) => a - b)).toStrictEqual(at);
    expect(guide).toContain(
      `| — | \`${NO_RULE.name}\` | \`${NO_RULE.category}\` | ${NO_RULE.failureClass} |`,
    );
  });

  it('puts every rule in the category and the class the code gives it', () => {
    for (const rule of RULES) {
      const row = guide.split('\n').find((line) => line.includes(`| \`${rule.name}\` |`));
      expect(row, rule.name).toContain(`| \`${rule.category}\` | ${rule.failureClass} |`);
    }
  });

  it('names every category', () => {
    for (const category of CATEGORIES) expect(guide, category).toContain(`\`${category}\``);
  });

  it('names every redaction step', () => {
    for (const step of STEPS) expect(guide, step.name).toContain(`\`${step.name}\``);
  });

  it('describes every option of the command', () => {
    const options = [...new Set(USAGE.match(/--[a-z][a-z-]*/g) ?? [])];
    expect(options.length).toBeGreaterThanOrEqual(8);
    for (const option of options) expect(guide, option).toContain(`\`${option}`);
  });

  it('names the variables the code reads, here and in the contract of the lab', () => {
    for (const variable of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_WORKSPACE_ID',
      'PB_TRIAGE_FROM',
    ]) {
      expect(guide, variable).toContain(variable);
      expect(contracts, variable).toContain(variable);
    }
  });
});

describe('PB-LAB-005 triage documentation: the decisions and the plain statements', () => {
  it('has the ten decisions in order, each with the five parts of the format', () => {
    const headings = [...decisions.matchAll(/^## ADR-(\d+): /gm)].map((match) => Number(match[1]));
    expect(headings).toStrictEqual([160, 161, 162, 163, 164, 165, 166, 167, 168, 169]);
    const bodies = decisions.split(/^## ADR-\d+: /m).slice(1);
    for (const [index, body] of bodies.entries()) {
      const parts = ['Context', 'Decision', 'Alternatives considered', 'Consequences', 'Defending it'].map(
        (part) => body.indexOf(`**${part}.`),
      );
      expect(
        parts.filter((position) => position < 0),
        `ADR-${160 + index}`,
      ).toStrictEqual([]);
      expect(
        [...parts].sort((a, b) => a - b),
        `ADR-${160 + index}`,
      ).toStrictEqual(parts);
    }
  });

  it('gives the command to run with a key, exactly, where a person will look for it', () => {
    expect(guide).toContain(LIVE_COMMAND);
    expect(decisions).toContain(LIVE_COMMAND);
    expect(LIVE_COMMAND).toContain(DEFAULT_MODEL);
  });

  it('says plainly that the live service has not been called, and that the mock is not it', () => {
    expect(guide).toMatch(/never been run against the live service/);
    expect(decisions).toMatch(/never run against the live service/);
    expect(decisions).toMatch(/There is no API key on the machine/);
    expect(guide).toMatch(/proves nothing about what the model writes/);
  });

  it('cites the version and the model it was built on, and the pages it was checked against', () => {
    expect(decisions).toContain(`\`anthropic-version: ${DEFAULT_API_VERSION}\``);
    expect(decisions).toContain(`\`${DEFAULT_MODEL}\``);
    for (const page of [
      'api/messages/create',
      'api/overview',
      'manage-claude/authentication',
      'api/versioning',
      'api/errors',
      'api/rate-limits',
      'models/overview',
      'build-with-claude/thinking',
    ]) {
      expect(decisions, page).toContain(`https://platform.claude.com/docs/en/${page}`);
    }
  });

  it('does not name a company or a product of the streaming business', () => {
    for (const name of ['Netflix', 'Disney', 'Hulu', 'Amazon Prime', 'HBO', 'YouTube', 'Spotify']) {
      expect(guide, name).not.toContain(name);
      expect(decisions, name).not.toContain(name);
    }
  });
});
