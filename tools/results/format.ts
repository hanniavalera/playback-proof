// Formatting shared by the results blocks: tables whose cells cannot break the table, and numbers written the same way everywhere.
import { formatNumber } from '../policy-tables.ts';

/** One cell: no line breaks, no bare pipes. */
export const cell = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

export function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = header.length;
  for (const row of rows) {
    if (row.length !== width) throw new Error(`a table row has ${row.length} cells under ${width} headings`);
  }
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/** An inline code span that survives backticks inside the text. */
export function code(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** The text cut to `max` characters, at a word when it can be, with an ellipsis. */
export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** At most `digits` decimals, none that are only zeros: 37.05, 111.5, 30. */
export function fixed(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  return formatNumber(Object.is(rounded, -0) ? 0 : rounded);
}

export const ms = (value: number, digits = 2): string => `${fixed(value, digits)} ms`;

export const seconds = (valueMs: number): string => `${formatNumber(Math.round(valueMs / 1000))} s`;

/** A ratio as a percentage with one decimal, the way the policy tables write it; null when the ratio is not defined. */
export const percent = (ratio: number | null, digits = 1): string =>
  ratio === null ? 'n/a' : `${(ratio * 100).toFixed(digits)} %`;

export const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
  `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;

export const day = (iso: string): string => iso.slice(0, 10);

/** A list as a sentence fragment: `a`, `a and b`, `a, b and c`. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A Markdown link. The README is at the root, so a repository path is already relative to it. */
export const link = (label: string, path: string): string => `[${label}](${path})`;
