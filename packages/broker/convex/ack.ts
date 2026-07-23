/**
 * tenfour/1 — ack mutation. Ack means MODEL-RECEIVED (R2).
 *
 * Recipient + referenced-attempt only; idempotent; an ack from a non-holder of the
 * referenced attempt (a demoted/superseded session) is rejected AUTH_FAILED (DEL-10/14).
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { AckRequestSchema } from '../../schema/src/protocol.ts';
import { ACK_OK_NOTE, ACK_DUPLICATE_NOTE } from '../../adapter/src/strings.ts';
import { authenticate, berr } from './lib/core.ts';

export const ack = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const auth = await authenticate(ctx, (request as { auth?: { token?: unknown } })?.auth?.token);
    if (!auth.ok) return auth;
    const parsed = AckRequestSchema.safeParse(request);
    if (!parsed.success) return berr('UNKNOWN_KIND', { reason: 'malformed_request' });
    const { message_id, attempt_id, state } = parsed.data;
    const agent = auth.agent;

    // Locate the message event; disambiguate not-found vs not-your-row (DEL-11 / READ-4).
    const anyRow = await ctx.db
      .query('messages')
      .withIndex('by_msgid', (q) => q.eq('id', message_id))
      .first();
    if (!anyRow) return berr('THREAD_NOT_FOUND', { vars: { thread_id: message_id } });

    const row = await ctx.db
      .query('messages')
      .withIndex('by_msgid_recipient', (q) => q.eq('id', message_id).eq('recipient', agent))
      .first();
    if (!row) {
      return berr('NOT_THREAD_PARTY', { vars: { thread_short: message_id.slice(0, 8) } });
    }

    // Already terminal → success-shaped idempotent (JOURNEYS §4 doctrine).
    if (row.delivery_state === 'acked') {
      return {
        ok: true,
        message_id,
        delivery_state: 'acked',
        duplicate: true,
        note: ACK_DUPLICATE_NOTE,
      };
    }

    // The referenced attempt must be the row's current attempt (not superseded) — DEL-10.
    if (row.claim === null || row.claim.attempt_id !== attempt_id) {
      return berr('AUTH_FAILED');
    }

    if (state === 'injected') {
      const duplicate = row.delivery_state === 'injected';
      if (!duplicate) await ctx.db.patch(row._id, { delivery_state: 'injected' });
      return { ok: true, message_id, delivery_state: 'injected', duplicate, note: ACK_OK_NOTE };
    }
    // state === 'acked'
    await ctx.db.patch(row._id, { delivery_state: 'acked', acked_attempt_id: attempt_id });
    return { ok: true, message_id, delivery_state: 'acked', duplicate: false, note: ACK_OK_NOTE };
  },
});
