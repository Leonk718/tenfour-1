import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedAgent, seedAdminKey, PROTO } from './testutil';

const modules = import.meta.glob('./**/*.*s');

const CLIENT_INFO = { platform: 'darwin', adapter_version: '0.0.0' };

async function issueFor(t: any, adminKey: string, agent: string) {
  return t.mutation(api.admin.issueInvite, {
    request: { protocol: PROTO, admin_key: adminKey, agent },
  });
}

describe('auth / pair / invite lifecycle (AUTH.md)', () => {
  test('issue → redeem → pair; second redeem fails; revoked token → AUTH_REVOKED', async () => {
    const t = convexTest(schema, modules);
    const adminKey = await seedAdminKey(t);
    await seedAgent(t, 'jonathan/web', 'active'); // the existing peer

    const issue = await issueFor(t, adminKey, 'brian/design');
    expect(issue.ok).toBe(true);
    expect(issue.invite.code).toMatch(/^TENFOUR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6}$/);

    const redeem = await t.mutation(api.invite.redeem, {
      request: { protocol: PROTO, code: issue.invite.code, client_info: CLIENT_INFO },
    });
    expect(redeem.ok).toBe(true);
    expect(redeem.agent).toBe('brian/design');
    expect(redeem.pair.peer).toBe('jonathan/web');
    expect(redeem.token).toMatch(/^tf1_[A-Za-z0-9_-]{43}$/);
    expect(redeem.covenant).toContain('You say go');

    const pairCount = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('pairs')
            .withIndex('by_status', (q: any) => q.eq('status', 'active'))
            .collect()
        ).length,
    );
    expect(pairCount).toBe(1);

    // INV-7: single-use — a second redemption of the same code fails uniform INVITE_INVALID.
    const second = await t.mutation(api.invite.redeem, {
      request: { protocol: PROTO, code: issue.invite.code, client_info: CLIENT_INFO },
    });
    expect(second.ok).toBe(false);
    expect(second.error.code).toBe('TENFOUR/INVITE_INVALID');
    expect(second.error.data).toBeUndefined(); // INV-6: no data.reason oracle

    // The freshly minted token authenticates.
    const ping = await t.mutation(api.diag.ping, {
      request: { protocol: PROTO, auth: { token: redeem.token } },
    });
    expect(ping.ok).toBe(true);
    expect(ping.agent).toBe('brian/design');

    // Revoke the agent → its token now returns AUTH_REVOKED (REV-2).
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('agents')
        .withIndex('by_address', (q: any) => q.eq('address', 'brian/design'))
        .unique();
      await ctx.db.patch(row!._id, { status: 'revoked' });
    });
    const ping2 = await t.mutation(api.diag.ping, {
      request: { protocol: PROTO, auth: { token: redeem.token } },
    });
    expect(ping2.ok).toBe(false);
    expect(ping2.error.code).toBe('TENFOUR/AUTH_REVOKED');
  });

  test('bad admin key → AUTH_FAILED (ENUM-1, byte-uniform)', async () => {
    const t = convexTest(schema, modules);
    await seedAdminKey(t);
    const res = await issueFor(t, 'tfadmin_' + 'B'.repeat(43), 'brian/design');
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/AUTH_FAILED');
  });

  test('expired invite → INVITE_EXPIRED (INV-6)', async () => {
    const t = convexTest(schema, modules);
    const adminKey = await seedAdminKey(t);
    await seedAgent(t, 'jonathan/web', 'active');
    const issue = await issueFor(t, adminKey, 'brian/design');
    // Backdate the invite past its TTL.
    await t.run(async (ctx) => {
      const inv = await ctx.db
        .query('invites')
        .withIndex('by_invite_id', (q: any) => q.eq('invite_id', issue.invite.invite_id))
        .unique();
      await ctx.db.patch(inv!._id, { exp: Date.now() - 1000 });
    });
    const res = await t.mutation(api.invite.redeem, {
      request: { protocol: PROTO, code: issue.invite.code, client_info: CLIENT_INFO },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/INVITE_EXPIRED');
  });

  test('tampered invite code → INVITE_INVALID (checksum)', async () => {
    const t = convexTest(schema, modules);
    const adminKey = await seedAdminKey(t);
    await seedAgent(t, 'jonathan/web', 'active');
    const issue = await issueFor(t, adminKey, 'brian/design');
    const parts = issue.invite.code.split('.');
    // Flip one payload char (breaks the checksum).
    const badChar = parts[1][0] === 'A' ? 'B' : 'A';
    parts[1] = badChar + parts[1].slice(1);
    const res = await t.mutation(api.invite.redeem, {
      request: { protocol: PROTO, code: parts.join('.'), client_info: CLIENT_INFO },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/INVITE_INVALID');
  });

  test('admin key on a data-plane method → AUTH_FAILED (ADM-1)', async () => {
    const t = convexTest(schema, modules);
    const adminKey = await seedAdminKey(t);
    const res = await t.mutation(api.diag.ping, {
      request: { protocol: PROTO, auth: { token: adminKey } },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/AUTH_FAILED');
  });
});
