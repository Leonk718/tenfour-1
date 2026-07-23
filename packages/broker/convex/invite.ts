/**
 * tenfour/1 — invite.redeem (the code IS the credential, WIRE §8.4).
 *
 * Single-use redemption via an atomic outstanding→redeemed compare-and-set (INV-7): mints
 * the agent token, activates the agent, and creates the active pair (PAIR-4) — all in one
 * transaction. Expiry → INVITE_EXPIRED; every other failure → uniform INVITE_INVALID with
 * NO data.reason (INV-6, no oracle).
 */
import { mutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import {
  InviteRedeemRequestSchema,
  InviteCodePayloadSchema,
  PROTOCOL_VERSION,
  LIMITS,
} from '../../schema/src/protocol.ts';
import { COVENANT_LINE } from '../../adapter/src/strings.ts';
import {
  ulid,
  mintAgentToken,
  sha256Hex,
  b64urlToStr,
  checksum4,
  constantTimeEqual,
} from './lib/ids.ts';
import { berr } from './lib/core.ts';

export const redeem = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const now = Date.now();

    const parsed = InviteRedeemRequestSchema.safeParse(request);
    if (!parsed.success) return berr('INVITE_INVALID', { vars: { detail: 'malformed' } });
    const { code } = parsed.data;

    // Parse + checksum-verify the code locally.
    const parts = code.split('.');
    if (parts.length !== 3 || parts[0] !== 'TENFOUR1') {
      return berr('INVITE_INVALID', { vars: { detail: 'malformed' } });
    }
    const [, payloadB64, check] = parts;
    const computedCheck = await checksum4(payloadB64);
    if (computedCheck !== check) return berr('INVITE_INVALID', { vars: { detail: 'checksum' } });

    let payload;
    try {
      const payloadStr = b64urlToStr(payloadB64);
      payload = InviteCodePayloadSchema.parse(JSON.parse(payloadStr));
    } catch {
      return berr('INVITE_INVALID', { vars: { detail: 'malformed' } });
    }

    const invite = await ctx.db
      .query('invites')
      .withIndex('by_invite_id', (q) => q.eq('invite_id', payload.invite_id))
      .unique();
    if (!invite) return berr('INVITE_INVALID', { vars: { detail: 'unknown' } });

    // Secret verification (constant-time, CRED-7) BEFORE expiry (INV-6 ordering).
    const secretHash = await sha256Hex(payload.secret);
    if (!constantTimeEqual(secretHash, invite.secret_sha256)) {
      await ctx.db.patch(invite._id, { redeem_failures: invite.redeem_failures + 1 });
      return berr('INVITE_INVALID', { vars: { detail: 'secret' } });
    }
    if (invite.redeem_failures >= LIMITS.INVITE_REDEEM_MAX_FAILURES) {
      return berr('INVITE_INVALID', { vars: { detail: 'locked' } });
    }
    if (invite.status !== 'outstanding') {
      return berr('INVITE_INVALID', { vars: { detail: 'consumed' } });
    }
    if (invite.exp < now) {
      return berr('INVITE_EXPIRED');
    }

    // CAS: outstanding → redeemed (INV-7).
    await ctx.db.patch(invite._id, { status: 'redeemed' });

    // Resolve the peer to pair with.
    let peer = invite.pair_with;
    if (peer === null) {
      const actives = await ctx.db
        .query('agents')
        .withIndex('by_status', (q) => q.eq('status', 'active'))
        .collect();
      for (const a of actives) {
        if (a.role === 'agent' && a.address !== invite.address) {
          peer = a.address;
          break;
        }
      }
    }

    // Mint the token; activate the agent.
    const token = mintAgentToken();
    const tokenHash = await sha256Hex(token);
    const tokenId = ulid(now);
    const agentRow = await ctx.db
      .query('agents')
      .withIndex('by_address', (q) => q.eq('address', invite.address))
      .unique();
    if (agentRow) {
      await ctx.db.patch(agentRow._id, { status: 'active', token_sha256: tokenHash });
    } else {
      await ctx.db.insert('agents', {
        address: invite.address,
        role: 'agent',
        token_sha256: tokenHash,
        status: 'active',
        created_at: now,
        last_ping_ts: null,
        last_mark: null,
      });
    }

    // Create the active pair (PAIR-4), lexicographically ordered, if a peer exists and no
    // active pair already covers these members.
    if (peer !== null) {
      const existing = await activePairFor(ctx, invite.address, peer);
      if (!existing) {
        const [member_a, member_b] =
          invite.address < peer ? [invite.address, peer] : [peer, invite.address];
        await ctx.db.insert('pairs', {
          pair_id: ulid(now),
          member_a,
          member_b,
          status: 'active',
          max_rounds: invite.max_rounds,
          repo_allowlist: invite.repo_allowlist,
          created_at: now,
        });
      }
    }

    return {
      ok: true,
      agent: invite.address,
      token,
      token_id: tokenId,
      pair: {
        peer: peer ?? invite.address,
        max_rounds: invite.max_rounds,
      },
      broker: {
        protocol_versions: [PROTOCOL_VERSION],
        server_time: now,
      },
      covenant: COVENANT_LINE,
    };
  },
});

/** True iff an active pair already covers both members. */
async function activePairFor(ctx: MutationCtx, a: string, b: string): Promise<boolean> {
  const asA = await ctx.db
    .query('pairs')
    .withIndex('by_member_a', (q) => q.eq('member_a', a < b ? a : b))
    .collect();
  return asA.some(
    (p) =>
      p.status === 'active' &&
      ((p.member_a === a && p.member_b === b) || (p.member_a === b && p.member_b === a)),
  );
}
