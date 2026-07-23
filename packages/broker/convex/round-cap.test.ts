import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedPair, seedThread, sendReq, envFor } from './testutil';

const modules = import.meta.glob('./**/*.*s');

describe('round-cap breach (STATE §8.4) — atomic freeze + system needs_human fan-out', () => {
  test('a substantive send exceeding max_rounds → ROUND_CAP, thread frozen, system needs_human to BOTH parties', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t, { maxRounds: 2 });
    // A task thread at the cap: rounds_used = max_rounds, last substantive = initiator.
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'in_progress',
      initiator: A.address,
      recipient: B.address,
      round: 2,
      maxRounds: 2,
      lastSub: A.address,
      consentGrantSeq: 1, // granted, so `result` passes the consent gate (step 11)
    });

    // Owner sends `result` (substantive, alternates → would be round 3 > 2).
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        B.token,
        envFor('result', { thread_id: seed.threadId, parent_id: seed.headId, to: A.address }),
      ),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/ROUND_CAP');
    expect(res.error.data.state).toBe('frozen');
    expect(res.error.data.max_rounds).toBe(2);

    // Thread is frozen by the system with resume_state recorded.
    const thread = await t.run(async (ctx) =>
      ctx.db
        .query('threads')
        .withIndex('by_thread_id', (q: any) => q.eq('thread_id', seed.threadId))
        .unique(),
    );
    expect(thread!.status).toBe('frozen');
    expect(thread!.frozen_reason).toBe('round_cap');
    expect(thread!.frozen_by).toBe('tenfour/system');
    expect(thread!.resume_state).toBe('in_progress');

    // DEL-42: exactly ONE thread event, TWO inbox rows (one per party), sharing (id, seq).
    const sys = await t.run(async (ctx) => {
      const all = await ctx.db
        .query('messages')
        .withIndex('by_thread_seq', (q: any) => q.eq('thread_id', seed.threadId))
        .collect();
      return all.filter((m: any) => m.from === 'tenfour/system');
    });
    expect(sys.length).toBe(2);
    expect(sys[0].id).toBe(sys[1].id); // one thread event id
    expect(sys[0].seq).toBe(sys[1].seq);
    expect(sys[0].kind).toBe('needs_human');
    const recipients = sys.map((m: any) => m.recipient).sort();
    expect(recipients).toEqual([A.address, B.address].sort());

    // The breaching `result` was NOT persisted.
    const results = await t.run(async (ctx) => {
      const all = await ctx.db
        .query('messages')
        .withIndex('by_thread_seq', (q: any) => q.eq('thread_id', seed.threadId))
        .collect();
      return all.filter((m: any) => m.kind === 'result');
    });
    expect(results.length).toBe(0);
  });

  test('landing exactly on the cap is legal; the NEXT alternating substantive breaches (§8.3 rows 9–10)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t, { maxRounds: 10 });
    // (9, O) — an alternating change_request by I lands on round 10 (legal).
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'review',
      initiator: A.address,
      recipient: B.address,
      round: 9,
      maxRounds: 10,
      lastSub: B.address,
      consentGrantSeq: 1,
    });
    const cr = await t.mutation(api.send.send, {
      request: sendReq(
        A.token,
        envFor('change_request', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: B.address,
          body: 'one more change',
        }),
      ),
    });
    expect(cr.ok).toBe(true);
    expect(cr.thread.round).toBe(10); // landing on the cap admits

    // (10, I) — owner's alternating result would be round 11 → breach.
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        B.token,
        envFor('result', { thread_id: seed.threadId, parent_id: cr.thread.head_id, to: A.address }),
      ),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/ROUND_CAP');
  });
});
