/**
 * tenfour broker — id / credential / hashing primitives.
 *
 * Runs in the default Convex V8 isolate (no "use node"): uses the ambient Web
 * Crypto API (crypto.subtle / crypto.getRandomValues) — no Node imports.
 *
 * ULIDs match protocol.ts ULID_REGEX; tokens/keys/secrets match the AUTH §3.1 /
 * protocol.ts credential regexes; the invite code matches INVITE_CODE_REGEX.
 */

/** Crockford base32 alphabet (no I, L, O, U) — matches protocol.ts ULID_REGEX. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** base64url alphabet (unpadded) — matches [A-Za-z0-9_-]. */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64URL.length; i++) m[B64URL[i]] = i;
  return m;
})();

/** Encode bytes as unpadded base64url. */
export function bytesToB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64URL[b2 & 0x3f];
  }
  return out;
}

/** Decode unpadded base64url to bytes. Throws on an invalid character. */
export function b64urlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64URL_LOOKUP[s[i]];
    const c1 = B64URL_LOOKUP[s[i + 1]];
    if (c0 === undefined || c1 === undefined) throw new Error('bad base64url');
    out.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < s.length && s[i + 2] !== undefined) {
      const c2 = B64URL_LOOKUP[s[i + 2]];
      if (c2 === undefined) throw new Error('bad base64url');
      out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
      if (i + 3 < s.length && s[i + 3] !== undefined) {
        const c3 = B64URL_LOOKUP[s[i + 3]];
        if (c3 === undefined) throw new Error('bad base64url');
        out.push(((c2 & 0x03) << 6) | c3);
      }
    }
  }
  return new Uint8Array(out);
}

export function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

export function b64urlToStr(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

/** Random bytes from the platform CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Mint a ULID (Crockford base32, 26 chars): 48-bit ms timestamp + 80 random bits.
 * First char is 0-7 for any ms epoch value, satisfying protocol.ts ULID_REGEX.
 */
export function ulid(now: number = Date.now()): string {
  let ts = Math.floor(now);
  let time = '';
  for (let i = 9; i >= 0; i--) {
    time = CROCKFORD[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return time + r;
}

/** Mint an agent bearer token: `tf1_` + 43 base64url chars (256-bit). */
export function mintAgentToken(): string {
  return 'tf1_' + bytesToB64url(randomBytes(32));
}

/** Mint an admin key: `tfadmin_` + 43 base64url chars (256-bit). */
export function mintAdminKey(): string {
  return 'tfadmin_' + bytesToB64url(randomBytes(32));
}

/** Mint a 256-bit invite secret carried inside the invite code (43 base64url chars). */
export function mintInviteSecret(): string {
  return bytesToB64url(randomBytes(32));
}

/** Mint a 128-bit consent token: 22 base64url chars (protocol.ts CONSENT_TOKEN_REGEX). */
export function mintConsentToken(): string {
  return bytesToB64url(randomBytes(16)).slice(0, 22);
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** First 4 bytes of SHA-256, as base64url (6 chars) — the invite-code checksum (AUTH §6.2). */
export async function checksum4(payloadB64url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadB64url));
  return bytesToB64url(new Uint8Array(digest).slice(0, 4));
}

/** Constant-time equality over two equal-length hex digests (CRED-7 intent). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
