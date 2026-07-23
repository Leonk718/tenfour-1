/**
 * tenfour/1 — admin.issueInvite (control-plane; admin key only, ADM-1).
 *
 * Mints an invite: creates/re-invites the agent row (invited), stores sha256(secret),
 * and emits the wire code `TENFOUR1.<payload_b64url>.<check>` (WIRE §8.3 D29). A bad or
 * absent admin key returns AUTH_FAILED, byte-identical to any bad credential (ENUM-1).
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import {
  AdminIssueInviteRequestSchema,
  RESERVED_AGENT_PREFIX,
  InviteCodePayloadSchema,
} from '../../schema/src/protocol.ts';
import {
  ulid,
  mintInviteSecret,
  sha256Hex,
  strToB64url,
  checksum4,
  constantTimeEqual,
} from './lib/ids.ts';
import { berr, BROKER_URL, activePairFor } from './lib/core.ts';

export const issueInvite = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const now = Date.now();

    // Admin-key check FIRST (control-plane credential).
    const parsed = AdminIssueInviteRequestSchema.safeParse(request);
    const config = await ctx.db.query('config').first();
    if (!config) return berr('AUTH_FAILED');
    const presentedKey =
      typeof (request as { admin_key?: unknown })?.admin_key === 'string'
        ? ((request as { admin_key: string }).admin_key)
        : '';
    const presentedHash = await sha256Hex(presentedKey);
    if (!constantTimeEqual(presentedHash, config.admin_key_sha256)) {
      return berr('AUTH_FAILED');
    }
    if (!parsed.success) return berr('AUTH_FAILED');
    const { agent, ttl_s, max_rounds, repo_allowlist, note: _note } = parsed.data;

    // ID-2 — the tenfour/ namespace is reserved.
    if (agent.startsWith(RESERVED_AGENT_PREFIX)) {
      return berr('PAIR_FORBIDDEN', { vars: { to: agent } });
    }

    // PAIR-6 — an invite that would create a second active pair is rejected at issuance.
    const activeAsA = await ctx.db
      .query('pairs')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .collect();
    for (const p of activeAsA) {
      if (p.member_a !== agent && p.member_b !== agent) {
        return berr('PAIR_FORBIDDEN', { vars: { to: agent } });
      }
    }

    // Derive pair_with = an existing active agent (role=agent) other than the invitee.
    const actives = await ctx.db
      .query('agents')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .collect();
    let pairWith: string | null = null;
    for (const a of actives) {
      if (a.role === 'agent' && a.address !== agent) {
        pairWith = a.address;
        break;
      }
    }

    // INV-10 — supersede any outstanding invite for this address.
    const priorInvites = await ctx.db
      .query('invites')
      .withIndex('by_address', (q) => q.eq('address', agent))
      .collect();
    for (const inv of priorInvites) {
      if (inv.status === 'outstanding') await ctx.db.patch(inv._id, { status: 'superseded' });
    }

    // Upsert the agent row (ID-6 (none)→invited, revoked→invited).
    const existingAgent = await ctx.db
      .query('agents')
      .withIndex('by_address', (q) => q.eq('address', agent))
      .unique();
    if (existingAgent) {
      await ctx.db.patch(existingAgent._id, { status: 'invited' });
    } else {
      await ctx.db.insert('agents', {
        address: agent,
        role: 'agent',
        token_sha256: null,
        status: 'invited',
        created_at: now,
        last_ping_ts: null,
        last_mark: null,
      });
    }

    // Mint the invite.
    const inviteId = ulid(now);
    const secret = mintInviteSecret();
    const secretHash = await sha256Hex(secret);
    const exp = now + ttl_s * 1000;
    await ctx.db.insert('invites', {
      invite_id: inviteId,
      address: agent,
      pair_with: pairWith,
      secret_sha256: secretHash,
      exp,
      status: 'outstanding',
      redeem_failures: 0,
      max_rounds,
      repo_allowlist: repo_allowlist ?? null,
      created_at: now,
    });

    // Build the code — payload keys sorted, no whitespace (AUTH §6.2).
    const payloadObj = {
      agent,
      broker_url: BROKER_URL,
      exp,
      invite_id: inviteId,
      secret,
      v: 1,
    };
    // Sanity: the payload validates against the wire schema.
    InviteCodePayloadSchema.parse(payloadObj);
    const payloadStr = JSON.stringify(payloadObj, Object.keys(payloadObj).sort());
    const payloadB64 = strToB64url(payloadStr);
    const check = await checksum4(payloadB64);
    const code = `TENFOUR1.${payloadB64}.${check}`;

    return {
      ok: true,
      invite: {
        invite_id: inviteId,
        code,
        agent,
        expires_at: exp,
        max_rounds,
        repo_allowlist: repo_allowlist ?? null,
      },
    };
  },
});
