import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { seedPair, seedAgent, sendReq, envFor, mintAgentToken, PROTO } from './testutil';

const modules = import.meta.glob('./**/*.*s');

describe('send validation order (STATE §3 / WIRE D19 — first-by-precedence)', () => {
  test('bad version + oversized body → UNSUPPORTED_VERSION (step 1 wins)', async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(api.send.send, {
      request: {
        protocol: 'tenfour/0',
        auth: { token: mintAgentToken() },
        envelope: {
          protocol: 'tenfour/0',
          client_id: '01J1PAVH5N40E3D8QT2W9YRKM3',
          to: 'bob/dev',
          kind: 'task',
          body: 'x'.repeat(20000),
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/UNSUPPORTED_VERSION');
  });

  test('revoked token + bad `to` → AUTH_REVOKED before PAIR_FORBIDDEN (step 2 wins)', async () => {
    const t = convexTest(schema, modules);
    const revoked = await seedAgent(t, 'ghost/dev', 'revoked');
    const res = await t.mutation(api.send.send, {
      request: sendReq(revoked.token, envFor('question', { to: 'nobody/x', body: 'hi' })),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/AUTH_REVOKED');
  });

  test('unknown token → AUTH_FAILED (byte-uniform)', async () => {
    const t = convexTest(schema, modules);
    await seedPair(t);
    const res = await t.mutation(api.send.send, {
      request: sendReq(mintAgentToken(), envFor('question', { to: 'bob/dev', body: 'hi' })),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/AUTH_FAILED');
  });

  test('valid auth + non-peer `to` + unknown kind → PAIR_FORBIDDEN before UNKNOWN_KIND (step 3 wins)', async () => {
    const t = convexTest(schema, modules);
    const { A } = await seedPair(t);
    const res = await t.mutation(api.send.send, {
      request: {
        protocol: PROTO,
        auth: { token: A.token },
        envelope: {
          protocol: PROTO,
          client_id: '01J1PAVH5N40E3D8QT2W9YRKM3',
          thread_id: null,
          to: 'stranger/x',
          kind: 'bogus_kind',
          body: 'hi',
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/PAIR_FORBIDDEN');
  });

  test('self-send → PAIR_FORBIDDEN (PAIR-7)', async () => {
    const t = convexTest(schema, modules);
    const { A } = await seedPair(t);
    const res = await t.mutation(api.send.send, {
      request: sendReq(A.token, envFor('question', { to: A.address, body: 'hi' })),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/PAIR_FORBIDDEN');
  });

  test('auth+pair ok, unknown kind → UNKNOWN_KIND (step 6)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const res = await t.mutation(api.send.send, {
      request: {
        protocol: PROTO,
        auth: { token: A.token },
        envelope: {
          protocol: PROTO,
          client_id: '01J1PAVH5N40E3D8QT2W9YRKM4',
          thread_id: null,
          to: B.address,
          kind: 'bogus_kind',
          body: 'hi',
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/UNKNOWN_KIND');
    expect(res.error.data.reason).toBe('unrecognized_kind');
  });
});
