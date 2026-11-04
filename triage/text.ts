import { stripVTControlCharacters } from 'node:util';

// Small text helpers shared by the collector, the rules and the writers. They are here so that "what a line looks like" is decided once.

export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

/** At most `max` characters; a cut text ends with `…`. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** The text without control characters, except the line feed and the tab: what a model may have written is not trusted to be only text. */
export function withoutControlCharacters(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join('');
}

/** One line: whitespace runs collapse, then the cut. For a table cell and for a line of a prompt. */
export function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** `1 test`, `2 tests`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
