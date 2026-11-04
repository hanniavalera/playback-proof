// A strict, small XML reader for the manifests the lab produces (and nothing else): elements, attributes, text, comments, the five
// predefined entities and numeric character references. It rejects what a lenient parser would let through: a DOCTYPE, CDATA, undefined
// entities, duplicate attributes, '<' in an attribute value, mismatched or unclosed tags, more than one root, text after the root.
// Used by tools/verify-streams.ts and by the unit tests as an independent check of the manifest builders.

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside the element (whitespace between children included). */
  text: string;
}

const NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function parseXml(source: string): XmlElement {
  let i = 0;
  const where = (at: number): string => {
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    return `line ${line}, column ${at - before.lastIndexOf('\n')}`;
  };
  const fail = (message: string, at = i): never => {
    throw new XmlError(`${message} (${where(at)})`);
  };
  const startsWith = (s: string): boolean => source.startsWith(s, i);
  const skipSpace = (): void => {
    while (i < source.length && /[ \t\r\n]/.test(source[i] as string)) i++;
  };
  const name = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(source);
    if (!m) return fail('expected a name');
    i += m[0].length;
    return m[0];
  };
  const decode = (raw: string, at: number): string =>
    raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (_m, ref: string) => {
      if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
      if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
      const v = ENTITIES[ref];
      if (v === undefined) return fail(`undefined entity &${ref};`, at);
      return v;
    });
  const assertNoBareAmpersand = (raw: string, at: number): void => {
    if (/&(?!(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);)/.test(raw)) fail("'&' that does not start an entity", at);
  };
  const skipComment = (): void => {
    const end = source.indexOf('-->', i + 4);
    if (end < 0) fail('unterminated comment');
    if (source.slice(i + 4, end).includes('--')) fail("'--' inside a comment");
    i = end + 3;
  };

  if (startsWith('<?xml')) {
    const end = source.indexOf('?>', i);
    if (end < 0) fail('unterminated XML declaration');
    i = end + 2;
  }
  const element = (): XmlElement => {
    if (source[i] !== '<') fail("expected '<'");
    i++;
    const el: XmlElement = { name: name(), attrs: {}, children: [], text: '' };
    for (;;) {
      const before = i;
      skipSpace();
      if (startsWith('/>')) {
        i += 2;
        return el;
      }
      if (source[i] === '>') {
        i++;
        break;
      }
      if (i === before) fail('expected whitespace before an attribute');
      const attr = name();
      skipSpace();
      if (source[i] !== '=') fail("expected '='");
      i++;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") fail('attribute value must be quoted');
      const end = source.indexOf(quote as string, i + 1);
      if (end < 0) fail('unterminated attribute value');
      const raw = source.slice(i + 1, end);
      if (raw.includes('<')) fail("'<' inside an attribute value", i);
      assertNoBareAmpersand(raw, i);
      if (attr in el.attrs) fail(`duplicate attribute '${attr}'`);
      el.attrs[attr] = decode(raw, i);
      i = end + 1;
    }
    for (;;) {
      const lt = source.indexOf('<', i);
      if (lt < 0) fail(`unclosed element <${el.name}>`);
      const text = source.slice(i, lt);
      assertNoBareAmpersand(text, i);
      el.text += decode(text, i);
      i = lt;
      if (startsWith('<!--')) {
        skipComment();
      } else if (startsWith('<![CDATA[') || startsWith('<!')) {
        fail('CDATA and DOCTYPE are not supported');
      } else if (startsWith('<?')) {
        fail('processing instructions are not supported');
      } else if (startsWith('</')) {
        i += 2;
        const close = name();
        skipSpace();
        if (source[i] !== '>') fail("expected '>'");
        i++;
        if (close !== el.name) fail(`</${close}> closes <${el.name}>`);
        return el;
      } else {
        el.children.push(element());
      }
    }
  };

  skipSpace();
  while (startsWith('<!--')) {
    skipComment();
    skipSpace();
  }
  if (startsWith('<!')) fail('DOCTYPE is not supported');
  const root = element();
  skipSpace();
  while (startsWith('<!--')) {
    skipComment();
    skipSpace();
  }
  if (i < source.length) fail('content after the root element');
  return root;
}

export const childrenNamed = (el: XmlElement, name: string): XmlElement[] =>
  el.children.filter((c) => c.name === name);
