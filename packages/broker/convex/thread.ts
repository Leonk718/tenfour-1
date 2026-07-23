/**
 * tenfour/1 — thread query. Party-only read (READ-2): the caller must be the `from`
 * or `to` of the thread root. System messages inside a thread add no parties.
 */
import { query } from './_generated/server';
import { v } from 'convex/values';
import { ThreadRequestSchema } from '../../schema/src/protocol.ts';
import { authenticate, berr, assembleThread, assembleStamped, shortId } from './lib/core.ts';

export const thread = query({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const auth = await authenticate(ctx, (request as { auth?: { token?: unknown } })?.auth?.token);
    if (!auth.ok) return auth;
    const parsed = ThreadRequestSchema.safeParse(request);
    if (!parsed.success) return berr('UNKNOWN_KIND', { reason: 'malformed_request' });
    const { thread_id, after_seq, limit } = parsed.data;
    const agent = auth.agent;

    const th = await ctx.db
      .query('threads')
      .withIndex('by_thread_id', (q) => q.eq('thread_id', thread_id))
      .unique();
    if (!th) return berr('THREAD_NOT_FOUND', { vars: { thread_id } });

    if (agent !== th.initiator && agent !== th.recipient) {
      return berr('NOT_THREAD_PARTY', {
        vars: { thread_short: shortId(thread_id) },
        reason: 'not_party',
      });
    }

    const rows = await ctx.db
      .query('messages')
      .withIndex('by_thread_seq', (q) => q.eq('thread_id', thread_id).gt('seq', after_seq))
      .order('asc')
      .collect();
    // Dedupe the system fan-out (two inbox rows share one thread event id/seq).
    const seen = new Set<string>();
    const uniq = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      uniq.push(r);
    }
    const page = uniq.slice(0, limit);
    const has_more = uniq.length > limit;

    return {
      ok: true,
      thread: assembleThread(th),
      messages: page.map(assembleStamped),
      has_more,
    };
  },
});
