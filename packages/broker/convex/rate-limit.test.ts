import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedPair, sendReq, envFor } from './testutil';

const modules = import.meta.glob('./**/*.*s');

describe('rate limiting (STATE §9 — exact sliding log, send 12/60s AND 120/3600s)', () => {
  test('12/60s boundary: the 13th send within the window → RATE_LIMITED', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    for (let i = 0; i < 12; i++) {
      const r = await t.mutation(api.send.send, {
        request: sendReq(A.token, envFor('question', { to: B.address, body: `q${i}` })),
      });
      expect(r.ok, `send ${i} should admit`).toBe(true);
    }
    const r13 = await t.mutation(api.send.send, {
      request: sendReq(A.token, envFor('question', { to: B.address, body: 'q13' })),
    });
    expect(r13.ok).toBe(false);
    expect(r13.error.code).toBe('TENFOUR/RATE_LIMITED');
    expect(r13.error.data.method).toBe('send');
    expect(r13.error.data.limit).toBe(12);
    expect(r13.error.data.window_s).toBe(60);
    expect(typeof r13.error.data.oldest_expires_in_s).toBe('number');
  });

  test('rate is per-agent: A limited never blocks B (§9.3)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    for (let i = 0; i < 12; i++) {
      await t.mutation(api.send.send, {
        request: sendReq(A.token, envFor('question', { to: B.address, body: `q${i}` })),
      });
    }
    const aLimited = await t.mutation(api.send.send, {
      request: sendReq(A.token, envFor('question', { to: B.address, body: 'over' })),
    });
    expect(aLimited.ok).toBe(false);
    expect(aLimited.error.code).toBe('TENFOUR/RATE_LIMITED');

    // B is unaffected.
    const bOk = await t.mutation(api.send.send, {
      request: sendReq(B.token, envFor('question', { to: A.address, body: 'from B' })),
    });
    expect(bOk.ok).toBe(true);
  });

  test('a rejected send does not consume quota (§9.1)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    // 6 admitted sends.
    for (let i = 0; i < 6; i++) {
      await t.mutation(api.send.send, {
        request: sendReq(A.token, envFor('question', { to: B.address, body: `q${i}` })),
      });
    }
    // A rejected send (unknown kind) — must not add a rate event.
    await t.mutation(api.send.send, {
      request: sendReq(A.token, { ...envFor('question', { to: B.address }), kind: 'bogus' }),
    });
    const rate = await t.run(async (ctx) => (await ctx.db.query('rate_events').collect()).length);
    expect(rate).toBe(6);
  });
});
