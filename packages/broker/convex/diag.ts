/**
 * tenfour/1 — diag.ping mutation (R6). Not a thread. Echoes the nonce, records the
 * optional mark presence beacon (WIRE D26), and discloses the paired peer's presence
 * to the paired peer ONLY (READ-6). Agent tokens only; the admin key gets AUTH_FAILED.
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { DiagPingRequestSchema, PROTOCOL_VERSION } from '../../schema/src/protocol.ts';
import { authenticate, berr, activePairFor, peerOf, BROKER_VERSION } from './lib/core.ts';

export const ping = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const now = Date.now();
    const auth = await authenticate(ctx, (request as { auth?: { token?: unknown } })?.auth?.token);
    if (!auth.ok) return auth;
    const parsed = DiagPingRequestSchema.safeParse(request);
    if (!parsed.success) return berr('UNKNOWN_KIND', { reason: 'malformed_request' });
    const { nonce, mark } = parsed.data;
    const agent = auth.agent;

    // Record this agent's presence beacon.
    const me = await ctx.db
      .query('agents')
      .withIndex('by_address', (q) => q.eq('address', agent))
      .unique();
    if (me) {
      await ctx.db.patch(me._id, {
        last_ping_ts: now,
        last_mark: mark !== undefined ? mark : me.last_mark,
      });
    }

    // Peer presence — paired peer only.
    let peer: { agent: string; last_ping_ts: number; last_mark: string | null } | null = null;
    const pair = await activePairFor(ctx, agent);
    if (pair) {
      const peerAddr = peerOf(pair, agent);
      if (peerAddr) {
        const peerRow = await ctx.db
          .query('agents')
          .withIndex('by_address', (q) => q.eq('address', peerAddr))
          .unique();
        if (peerRow && peerRow.last_ping_ts !== null) {
          peer = {
            agent: peerAddr,
            last_ping_ts: peerRow.last_ping_ts,
            last_mark: peerRow.last_mark,
          };
        }
      }
    }

    return {
      ok: true,
      pong: true,
      nonce: nonce ?? null,
      agent,
      server_time: now,
      protocol_versions: [PROTOCOL_VERSION],
      broker_version: BROKER_VERSION,
      peer,
    };
  },
});
