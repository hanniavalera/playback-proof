// What the server hands out for the encrypted stream, read the way a spec reads it: from the bytes, with nothing of the media
// pipeline's own code (a check made with the code that wrote the manifest could not disagree with it).

/** The ClearKey system id (W3C EME `org.w3.clearkey`) as DASH writes it. */
export const CLEARKEY_SYSTEM_ID = 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e';
/** The generic Common Encryption element, whose `cenc:default_KID` names the key the content is encrypted under. */
export const MP4_PROTECTION_SCHEME = 'urn:mpeg:dash:mp4protection:2011';

export interface ProtectionElement {
  schemeIdUri: string;
  value: string | null;
  defaultKid: string | null;
}

function attribute(element: string, name: string): string | null {
  const match = new RegExp(`\\s${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(element);
  return match ? (match[1] as string) : null;
}

/** The `ContentProtection` elements of each `AdaptationSet` of a DASH manifest, in document order. */
export function protectionOfAdaptationSets(mpd: string): ProtectionElement[][] {
  const sets = [...mpd.matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g)];
  return sets.map(([set]) =>
    [...(set as string).matchAll(/<ContentProtection\b[^>]*>/g)].map(([element]) => ({
      schemeIdUri: attribute(element, 'schemeIdUri') ?? '',
      value: attribute(element, 'value'),
      defaultKid: attribute(element, 'cenc:default_KID'),
    })),
  );
}

/** A key id of 32 hex digits as the UUID text a manifest carries: 8-4-4-4-12. */
export function uuidOfKeyId(keyId: string): string {
  const hex = keyId.toLowerCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * Every way the key could be written into a text document, by name: hex in both cases, base64 (padded and not) and base64url. A
 * manifest that contains any of them has leaked the key. Named, so that a failure says how it was written and never prints the key.
 */
export function textFormsOfKey(keyHex: string): Record<string, string> {
  const bytes = Buffer.from(keyHex, 'hex');
  const base64 = bytes.toString('base64');
  return {
    hex: keyHex.toLowerCase(),
    'upper-case hex': keyHex.toUpperCase(),
    base64,
    'base64 without padding': base64.replace(/=+$/, ''),
    base64url: bytes.toString('base64url'),
  };
}

/** What an init segment says about itself, from its bytes: a protected sample entry (`encv`/`enca`), a `tenc` box and which key ids it names. */
export interface InitProtection {
  protectedEntries: string[];
  hasTenc: boolean;
  namesKeyId: boolean;
  containsKey: boolean;
}

export function protectionOfInit(init: Buffer, drm: { keyId: string; key: string }): InitProtection {
  return {
    protectedEntries: ['encv', 'enca'].filter((type) => init.includes(type, 0, 'latin1')),
    hasTenc: init.includes('tenc', 0, 'latin1'),
    namesKeyId: init.includes(Buffer.from(drm.keyId, 'hex')),
    containsKey: init.includes(Buffer.from(drm.key, 'hex')),
  };
}
