/**
 * tenfour/1 — inbox mutation (claim / peek + cursor pagination).
 *
 * A mutation because `mode: "claim"` writes the delivery lease (DELIVERY §2.3).
 * Correctness derives from durable rows + leases + cursor-on-ack (DEL-01).
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { InboxRequestSchema, LIMITS } from '../../schema/src/protocol.ts';
import { ulid } from './lib/ids.ts';
import {
  authenticate,
  berr,
  assembleStamped,
  assembleInboxThreadInfo,
} from './lib/core.ts';

export const inbox = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const now = Date.now();

    // version → auth → schema (AUTH §3.4 prefix).
    const auth = await authenticate(ctx, (request as { auth?: { token?: unknown } })?.auth?.token);
    if (!auth.ok) return auth;
    const parsed = InboxRequestSchema.safeParse(request);
    if (!parsed.success) return berr('UNKNOWN_KIND', { reason: 'malformed_request' });
    const { cursor, limit, mode, holder } = parsed.data;
    const agent = auth.agent;

    // D22: an expired/malformed/over-long cursor is treated as null (restart the sweep).
    const cursorStart = cursor !== null && /^[0-9]+$/.test(cursor) ? Number(cursor) : 0;

    // DEL-33: every unacked row is returned; the cursor bounds the scan, not the set.
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_inbox', (q) =>
        q.eq('recipient', agent).gt('inbox_seq', cursorStart),
      )
      .order('asc')
      .collect();
    const deliverable = rows.filter((r) => r.delivery_state !== 'acked');
    const page = deliverable.slice(0, limit);
    const has_more = deliverable.length > limit;

    const items: unknown[] = [];
    for (const r of page) {
      let attempt_id: string | null = null;
      let delivery_state = r.delivery_state;
      let prior_attempts = r.prior_attempts;

      if (mode === 'claim' && holder !== undefined) {
        const sameHolderLive =
          r.claim !== null && r.claim.holder === holder && r.claim.lease_expires > now;
        let att: string;
        let pa = r.prior_attempts;
        if (sameHolderLive) {
          att = r.claim!.attempt_id; // DEL-05 renew
        } else {
          att = ulid(now);
          if (r.claim !== null) pa = r.prior_attempts + 1; // DEL-06/08 supersede or expiry reclaim
        }
        await ctx.db.patch(r._id, {
          delivery_state: 'claimed',
          claim: { attempt_id: att, holder, lease_expires: now + LIMITS.CLAIM_LEASE_MS },
          prior_attempts: pa,
        });
        attempt_id = att;
        delivery_state = 'claimed';
        prior_attempts = pa;
      }

      const thread = await ctx.db
        .query('threads')
        .withIndex('by_thread_id', (q) => q.eq('thread_id', r.thread_id))
        .unique();
      if (!thread) continue;
      items.push({
        message: { ...assembleStamped(r), delivery_state },
        attempt_id,
        delivery_state,
        prior_attempts,
        thread: assembleInboxThreadInfo(thread),
      });
    }

    const cursorOut = page.length > 0 ? String(page[page.length - 1].inbox_seq) : String(cursorStart);
    return { ok: true, items, cursor: cursorOut, has_more, server_time: now };
  },
});
