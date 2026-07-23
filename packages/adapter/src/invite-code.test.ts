// @vitest-environment node
/** Invite-code local decode + checksum verification (AUTH INV-3) — no network. */
import { describe, it, expect } from 'vitest';
import { decodeInviteCode } from './invite-code.ts';
import { strToB64url, checksum4 } from './ids.ts';

const ULID = '01J1PAVH5N40E3D8QT2W9YRKM3';

async function makeCode(payload: Record<string, unknown>): Promise<string> {
  const obj = { agent: 'jonathan/web', broker_url: 'https://x.convex.cloud', exp: Date.now() + 86400000, invite_id: ULID, secret: 'A'.repeat(43), v: 1, ...payload };
  const b64 = strToB64url(JSON.stringify(obj, Object.keys(obj).sort()));
  const check = await checksum4(b64);
  return `TENFOUR1.${b64}.${check}`;
}

describe('decodeInviteCode', () => {
  it('accepts a well-formed code and returns the payload', async () => {
    const code = await makeCode({});
    const res = await decodeInviteCode(code);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload.agent).toBe('jonathan/web');
  });
  it('rejects a mangled checksum before any network call', async () => {
    const code = await makeCode({});
    const mangled = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    const res = await decodeInviteCode(mangled);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('checksum');
  });
  it('rejects a non-TENFOUR1 code as malformed', async () => {
    const res = await decodeInviteCode('BOGUS.aaa.bbbbbb');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });
});
