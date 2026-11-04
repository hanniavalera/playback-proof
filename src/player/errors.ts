import { toJsonSafe } from './timeline.ts';

// What a failure report needs from a Shaka error, and nothing that cannot cross the Playwright boundary. In the compiled
// build `error.message` is only "Shaka Error 1001", so the names of the code and the category are looked up in Shaka's own
// enums (passed in, so this file stays free of Shaka and runs in the unit tests).

export interface ErrorNames {
  /** `shaka.util.Error.Code`: { BAD_HTTP_STATUS: 1001, ... } */
  codes?: Record<string, number>;
  /** `shaka.util.Error.Category`: { NETWORK: 1, ... } */
  categories?: Record<string, number>;
}

export interface ErrorDigest {
  code: number;
  codeName?: string;
  category: number;
  severity: number;
  message: string;
  data?: unknown[];
}

const MAX_DATA_ITEMS = 8;
const MAX_ITEM_CHARS = 200;

function nameOf(table: Record<string, number> | undefined, value: number): string | undefined {
  if (!table) return undefined;
  for (const [name, candidate] of Object.entries(table)) if (candidate === value) return name;
  return undefined;
}

function digestItem(item: unknown): unknown {
  if (item === null) return null;
  if (typeof item === 'string')
    return item.length > MAX_ITEM_CHARS ? `${item.slice(0, MAX_ITEM_CHARS)}…` : item;
  if (typeof item === 'number') return Number.isFinite(item) ? item : null;
  if (typeof item === 'boolean') return item;
  if (item instanceof ArrayBuffer) return `[${item.byteLength} bytes]`;
  if (ArrayBuffer.isView(item)) return `[${item.byteLength} bytes]`;
  if (typeof item === 'object') {
    const text = JSON.stringify(toJsonSafe(item));
    return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text;
  }
  return String(item).slice(0, MAX_ITEM_CHARS);
}

/** A short, JSON-safe digest of a `shaka.util.Error` (or whatever was thrown): code and its name, category, severity, data. */
export function digestShakaError(error: unknown, names: ErrorNames = {}): ErrorDigest {
  if (typeof error !== 'object' || error === null) {
    return { code: 0, category: 0, severity: 1, message: String(error) };
  }
  const fields = error as {
    code?: unknown;
    category?: unknown;
    severity?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const code = typeof fields.code === 'number' ? fields.code : 0;
  const category = typeof fields.category === 'number' ? fields.category : 0;
  const severity = typeof fields.severity === 'number' ? fields.severity : 1;
  const codeName = nameOf(names.codes, code);
  const categoryName = nameOf(names.categories, category);
  const original = typeof fields.message === 'string' ? fields.message : '';
  const label = [categoryName, codeName].filter(Boolean).join('.');
  const message = label ? `${label}${original ? `: ${original}` : ''}` : original || `error ${code}`;
  const data = Array.isArray(fields.data) ? fields.data.slice(0, MAX_DATA_ITEMS).map(digestItem) : undefined;
  return {
    code,
    ...(codeName ? { codeName } : {}),
    category,
    severity,
    message,
    ...(data && data.length > 0 ? { data } : {}),
  };
}
