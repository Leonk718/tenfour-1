import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedPair, sendReq, envFor, PROTO } from './testutil';

const modules = import.meta.glob('./**/*.*s');

async function sendQuestion(t: any, from: any, to: any) {
  const r = await t.mutation(api.send.send, {
    request: sendReq(from.token, envFor('question', { to: to.address, body: 'q' })),
  });
  return r.message.id as string;
}

describe('delivery: claim / lease / ack (DELIVERY.md)', () => {
  test('claim → ack → idempotent re-ack', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const msgId = await sendQuestion(t, A, B);

    const inbox = await t.mutation(api.inbox.inbox, {
      request: { protocol: PROTO, auth: { token: B.token }, mode: 'claim', holder: 'h1' },
    });
    expect(inbox.ok).toBe(true);
    expect(inbox.items.length).toBe(1);
    const item = inbox.items[0];
    expect(item.delivery_state).toBe('claimed');
    expect(item.attempt_id).toBeTruthy();
    expect(item.prior_attempts).toBe(0);

    const ack = await t.mutation(api.ack.ack, {
      request: {
        protocol: PROTO,
        auth: { token: B.token },
        message_id: msgId,
        attempt_id: item.attempt_id,
      },
    });
    expect(ack.ok).toBe(true);
    expect(ack.delivery_state).toBe('acked');
    expect(ack.duplicate).toBe(false);

    const reack = await t.mutation(api.ack.ack, {
      request: {
        protocol: PROTO,
        auth: { token: B.token },
        message_id: msgId,
        attempt_id: item.attempt_id,
      },
    });
    expect(reack.ok).toBe(true);
    expect(reack.duplicate).toBe(true);
  });

  test('peek mode does not claim (attempt_id null, state unchanged)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    await sendQuestion(t, A, B);
    const peek = await t.mutation(api.inbox.inbox, {
      request: { protocol: PROTO, auth: { token: B.token }, mode: 'peek' },
    });
    expect(peek.ok).toBe(true);
    expect(peek.items.length).toBe(1);
    expect(peek.items[0].attempt_id).toBe(null);
    expect(peek.items[0].delivery_state).toBe('queued');
  });

  test('crash point C5: claim then never ack → redeliver after lease expiry (new attempt, prior_attempts++)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const msgId = await sendQuestion(t, A, B);

    const c1 = await t.mutation(api.inbox.inbox, {
      request: { protocol: PROTO, auth: { token: B.token }, mode: 'claim', holder: 'h1' },
    });
    const att1 = c1.items[0].attempt_id;
    expect(c1.items[0].prior_attempts).toBe(0);

    // Simulate a dead session: force the lease into the past (DEL-06 lazy reclaim).
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('messages')
        .withIndex('by_msgid', (q: any) => q.eq('id', msgId))
        .first();
      await ctx.db.patch(row!._id, {
        claim: { attempt_id: att1, holder: 'h1', lease_expires: Date.now() - 1 },
      });
    });

    const c2 = await t.mutation(api.inbox.inbox, {
      request: { protocol: PROTO, auth: { token: B.token }, mode: 'claim', holder: 'h2' },
    });
    expect(c2.items.length).toBe(1);
    const att2 = c2.items[0].attempt_id;
    expect(att2).not.toBe(att1);
    expect(c2.items[0].prior_attempts).toBe(1);

    // DEL-10/14: an ack referencing the superseded attempt (a demoted session) → AUTH_FAILED.
    const badAck = await t.mutation(api.ack.ack, {
      request: { protocol: PROTO, auth: { token: B.token }, message_id: msgId, attempt_id: att1 },
    });
    expect(badAck.ok).toBe(false);
    expect(badAck.error.code).toBe('TENFOUR/AUTH_FAILED');

    // The current attempt acks fine.
    const goodAck = await t.mutation(api.ack.ack, {
      request: { protocol: PROTO, auth: { token: B.token }, message_id: msgId, attempt_id: att2 },
    });
    expect(goodAck.ok).toBe(true);
  });

  test('ack by a non-recipient (the sender) → NOT_THREAD_PARTY (READ-4)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const msgId = await sendQuestion(t, A, B);
    const c1 = await t.mutation(api.inbox.inbox, {
      request: { protocol: PROTO, auth: { token: B.token }, mode: 'claim', holder: 'h1' },
    });
    const attempt = c1.items[0].attempt_id;
    const res = await t.mutation(api.ack.ack, {
      request: {
        protocol: PROTO,
        auth: { token: A.token },
        message_id: msgId,
        attempt_id: attempt,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/NOT_THREAD_PARTY');
  });

  test('ack of an unknown message_id → THREAD_NOT_FOUND (DEL-11)', async () => {
    const t = convexTest(schema, modules);
    const { B } = await seedPair(t);
    const res = await t.mutation(api.ack.ack, {
      request: {
        protocol: PROTO,
        auth: { token: B.token },
        message_id: '01J1PAVH5N40E3D8QT2W9YRKM3',
        attempt_id: '01J1PAVH5N40E3D8QT2W9YRKM4',
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/THREAD_NOT_FOUND');
  });
});
