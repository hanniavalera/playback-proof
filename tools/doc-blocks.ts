// Generated blocks in Markdown documents. A pair of HTML comments marks a region whose content is rendered from code:
//
//   <!-- BEGIN:LIVE_CRITERIA -->
//   ...rendered table...
//   <!-- END:LIVE_CRITERIA -->
//
// Everything here works on strings, so it is unit-tested without touching the disk (tests/unit/docs).

export function blockMarkers(name: string): { begin: string; end: string } {
  return { begin: `<!-- BEGIN:${name} -->`, end: `<!-- END:${name} -->` };
}

export type BlockLocation =
  | {
      found: true;
      /** Offset just after the BEGIN marker. */
      innerStart: number;
      /** Offset of the END marker. */
      innerEnd: number;
      /** The text between the markers, as written. */
      inner: string;
      /** 1-based line number of the first line after the BEGIN marker. */
      firstLine: number;
    }
  | { found: false; reason: string };

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

export function locateBlock(markdown: string, name: string): BlockLocation {
  const { begin, end } = blockMarkers(name);
  const begins = countOccurrences(markdown, begin);
  const ends = countOccurrences(markdown, end);
  if (begins === 0 && ends === 0) return { found: false, reason: `markers ${begin} and ${end} not found` };
  if (begins !== 1 || ends !== 1) {
    return {
      found: false,
      reason: `expected exactly one ${begin} and one ${end}, found ${begins} and ${ends}`,
    };
  }
  const beginAt = markdown.indexOf(begin);
  const endAt = markdown.indexOf(end);
  if (endAt < beginAt) return { found: false, reason: `${end} comes before ${begin}` };
  const innerStart = beginAt + begin.length;
  return {
    found: true,
    innerStart,
    innerEnd: endAt,
    inner: markdown.slice(innerStart, endAt),
    firstLine: markdown.slice(0, innerStart).split('\n').length + 1,
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/** The block's content without the padding lines around it, or undefined when the block cannot be located. */
export function blockBody(markdown: string, name: string): string | undefined {
  const located = locateBlock(markdown, name);
  return located.found ? normalize(located.inner) : undefined;
}

/** Replaces the content between the markers; everything outside them is left untouched. */
export function replaceBlock(markdown: string, name: string, body: string): string {
  const located = locateBlock(markdown, name);
  if (!located.found) throw new Error(`cannot replace block ${name}: ${located.reason}`);
  return `${markdown.slice(0, located.innerStart)}\n${normalize(body)}\n${markdown.slice(located.innerEnd)}`;
}

export type Freshness = { fresh: true } | { fresh: false; reason: string };

/** The first line where two texts differ, 1-based within the text, with both versions (shortened). */
export function firstDifference(expected: string, found: string): string {
  const a = normalize(expected).split('\n');
  const b = normalize(found).split('\n');
  const shorten = (line: string | undefined): string =>
    line === undefined ? 'nothing' : `"${line.length > 100 ? `${line.slice(0, 100)}...` : line}"`;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i])
      return `line ${i + 1} of the block: expected ${shorten(a[i])} but found ${shorten(b[i])}`;
  }
  return 'no difference';
}

/** Whether the block holds exactly the freshly rendered body (blank padding around it does not matter). */
export function checkBlockFresh(markdown: string, name: string, body: string): Freshness {
  const located = locateBlock(markdown, name);
  if (!located.found) return { fresh: false, reason: located.reason };
  if (normalize(located.inner) === normalize(body)) return { fresh: true };
  return { fresh: false, reason: `out of date (${firstDifference(body, located.inner)})` };
}
