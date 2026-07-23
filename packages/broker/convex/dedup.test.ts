import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedPair, sendReq, envFor, ulid, PROTO } from './testutil';

const modules = import.meta.glob('./**/*.*s');

describe('client_id dedup (STATE §3 step 4 / R7)', () => {
  test('same client_id + same content → duplicate:true canonical replay, quota untouched', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const clientId = ulid();
    const env = envFor('question', { to: B.address, body: 'same question' });
    env.client_id = clientId;

    const first = await t.mutation(api.send.send, { request: sendReq(A.token, env) });
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    const originalId = first.message.id;

    // Resend the identical envelope (same client_id, same content).
    const second = await t.mutation(api.send.send, { request: sendReq(A.token, { ...env }) });
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.message.id).toBe(originalId); // canonical original
    expect(second.note).toContain(originalId);
    expect(second.message.delivery_state).toBe('queued');

    // Duplicate consumed no quota / created no new thread.
    const counts = await t.run(async (ctx) => ({
      threads: (await ctx.db.query('threads').collect()).length,
      rate: (await ctx.db.query('rate_events').collect()).length,
      messages: (await ctx.db.query('messages').collect()).length,
    }));
    expect(counts.threads).toBe(1);
    expect(counts.rate).toBe(1); // duplicate did NOT add a rate event
    expect(counts.messages).toBe(1);
  });

  test('same client_id + drifted content → CLIENT_ID_CONFLICT', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const clientId = ulid();
    const env = envFor('question', { to: B.address, body: 'original body' });
    env.client_id = clientId;

    const first = await t.mutation(api.send.send, { request: sendReq(A.token, env) });
    expect(first.ok).toBe(true);

    const drifted = { ...env, body: 'DIFFERENT body' };
    const res = await t.mutation(api.send.send, { request: sendReq(A.token, drifted) });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/CLIENT_ID_CONFLICT');
  });

  test('dedup (step 4) precedes rate (step 5): a retried send is never rate-limited', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const clientId = ulid();
    const env = envFor('question', { to: B.address, body: 'retry me' });
    env.client_id = clientId;
    await t.mutation(api.send.send, { request: sendReq(A.token, env) });
    // Even after the rate window would be a concern, an identical retry short-circuits.
    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(api.send.send, { request: sendReq(A.token, { ...env }) });
      expect(r.ok).toBe(true);
      expect(r.duplicate).toBe(true);
    }
    const rate = await t.run(async (ctx) => (await ctx.db.query('rate_events').collect()).length);
    expect(rate).toBe(1);
  });
});
