/**
 * tenfour broker — control-plane bootstrap.
 *
 * NOT a tenfour/1 wire method (the wire API is exactly the 7 in protocol.ts METHODS).
 * Deploy-time setup, analogous to setting server env vars: stores the broker admin-key
 * hash AND this deployment's own URL (embedded verbatim in every invite code so the
 * joiner reaches the right broker). `tenfour init --create-broker` calls it after
 * `convex deploy`, passing the deployment's client URL.
 *
 * Owner-only and idempotent: on first call it inserts the row. On later calls it NEVER
 * overwrites the admin-key hash (takeover guard) — it only (re)sets broker_url, and only
 * when the presented admin key matches the stored hash (proving ownership). The admin key
 * arrives over TLS; only its sha256 is stored.
 */
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { sha256Hex } from './lib/ids.ts';
import { ADMIN_KEY_REGEX } from '../../schema/src/protocol.ts';

const brokerUrlOk = (u: string): boolean => /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(u);

export const initConfig = mutation({
  args: { admin_key: v.string(), broker_url: v.string() },
  returns: v.any(),
  handler: async (
    ctx,
    { admin_key, broker_url },
  ): Promise<{ ok: boolean; error?: string; updated?: boolean }> => {
    if (!ADMIN_KEY_REGEX.test(admin_key)) return { ok: false, error: 'bad admin key format' };
    if (!brokerUrlOk(broker_url)) return { ok: false, error: 'bad broker_url' };
    const hash = await sha256Hex(admin_key);
    const existing = await ctx.db.query('config').first();
    if (existing) {
      // Never overwrite the admin key. Only the key-holder may (re)set broker_url.
      if (existing.admin_key_sha256 !== hash)
        return { ok: false, error: 'config already initialized' };
      await ctx.db.patch(existing._id, { broker_url });
      return { ok: true, updated: true };
    }
    await ctx.db.insert('config', { admin_key_sha256: hash, broker_url });
    return { ok: true };
  },
});
