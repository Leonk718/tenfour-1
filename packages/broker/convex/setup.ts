/**
 * tenfour broker — control-plane bootstrap.
 *
 * NOT a tenfour/1 wire method (the wire API is exactly the 7 in protocol.ts METHODS).
 * This is deploy-time setup, analogous to setting a server env var: it stores the broker
 * admin-key hash once. `tenfour init --create-broker` calls it right after `convex deploy`.
 *
 * Idempotent-safe by refusal: if a `config` row already exists, this does NOT overwrite it
 * (that would be a takeover vector) — it returns { ok:false }. The admin key is provided
 * in plaintext over the (TLS) Convex call and only its sha256 is stored.
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { sha256Hex } from './lib/ids.ts';
import { ADMIN_KEY_REGEX } from '../../schema/src/protocol.ts';

export const initConfig = mutation({
  args: { admin_key: v.string() },
  returns: v.any(),
  handler: async (ctx, { admin_key }): Promise<{ ok: boolean; error?: string }> => {
    const existing = await ctx.db.query('config').first();
    if (existing) return { ok: false, error: 'config already initialized' };
    if (!ADMIN_KEY_REGEX.test(admin_key)) return { ok: false, error: 'bad admin key format' };
    const hash = await sha256Hex(admin_key);
    await ctx.db.insert('config', { admin_key_sha256: hash });
    return { ok: true };
  },
});
