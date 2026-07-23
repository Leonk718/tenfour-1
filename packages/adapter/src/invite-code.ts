/**
 * tenfour adapter — invite-code parsing (AUTH §6.2, INV-3). `tenfour join` verifies the
 * checksum and parses the payload LOCALLY before any network call; a checksum/format
 * failure is TENFOUR/INVITE_INVALID locally (exit 1) with no broker round-trip. WIRE §8.3
 * D29 + protocol.ts (INVITE_CODE_REGEX, InviteCodePayloadSchema) own the wire format.
 */

import {
  INVITE_CODE_REGEX,
  InviteCodePayloadSchema,
  type InviteCodePayload,
} from '../../schema/src/protocol.ts';
import { b64urlToStr, checksum4 } from './ids.ts';

export type DecodeResult =
  { ok: true; payload: InviteCodePayload } | { ok: false; reason: 'malformed' | 'checksum' };

/** Parse `TENFOUR1.<payload_b64url>.<check>`, verify the anti-mangling checksum, parse payload. */
export async function decodeInviteCode(code: string): Promise<DecodeResult> {
  if (!INVITE_CODE_REGEX.test(code)) return { ok: false, reason: 'malformed' };
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'TENFOUR1') return { ok: false, reason: 'malformed' };
  const [, payloadB64, check] = parts;
  const computed = await checksum4(payloadB64);
  if (computed !== check) return { ok: false, reason: 'checksum' };
  try {
    const payload = InviteCodePayloadSchema.parse(JSON.parse(b64urlToStr(payloadB64)));
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
