import { convexTest } from 'convex-test';
import { expect, test, describe } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import {
  seedPair,
  seedThread,
  sendReq,
  envFor,
  mintConsentToken,
  PROTO,
  GIT_SHA,
  TEST_REPO,
} from './testutil';

const modules = import.meta.glob('./**/*.*s');

describe('consent (CONSENT.md — structured gesture, broker record)', () => {
  test('gestured accepted with the valid token on an offered thread → in_progress + consent record (C2)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const token = mintConsentToken();
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'offered',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: null,
      consentToken: token,
    });
    // Owner (consent party) accepts.
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        B.token,
        envFor('accepted', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: A.address,
          body: '',
        }),
        { consent: { token, granted_via: 'cli_accept' } },
      ),
    });
    expect(res.ok).toBe(true);
    expect(res.thread.status).toBe('in_progress');
    expect(res.thread.consent_state).toBe('granted');

    const thread = await t.run(async (ctx) =>
      ctx.db
        .query('threads')
        .withIndex('by_thread_id', (q: any) => q.eq('thread_id', seed.threadId))
        .unique(),
    );
    expect(thread!.consent_granted_via).toBe('cli_accept');
    expect(thread!.consent_token).toBe(null); // single-use: consumed
  });

  test('gestured accepted with a wrong/stale token → CONSENT_REQUIRED (bad_token) (C3)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'offered',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: null,
      consentToken: mintConsentToken(),
    });
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        B.token,
        envFor('accepted', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: A.address,
          body: '',
        }),
        { consent: { token: mintConsentToken(), granted_via: 'cli_accept' } }, // wrong token
      ),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/CONSENT_REQUIRED');
    expect(res.error.data.reason).toBe('bad_token');
  });

  test('gesture by the initiator (not the consent party) → NOT_THREAD_PARTY (C4)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const token = mintConsentToken();
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'offered',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: null,
      consentToken: token,
    });
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        A.token,
        envFor('accepted', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: B.address,
          body: '',
        }),
        { consent: { token, granted_via: 'cli_accept' } },
      ),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/NOT_THREAD_PARTY');
    expect(res.error.data.reason).toBe('role_forbidden');
  });

  test('result without an active grant → CONSENT_REQUIRED (consent_not_granted) (C10 gate)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'in_progress',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: null, // no grant
    });
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        B.token,
        envFor('result', { thread_id: seed.threadId, parent_id: seed.headId, to: A.address }),
      ),
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('TENFOUR/CONSENT_REQUIRED');
    expect(res.error.data.reason).toBe('consent_not_granted');
  });

  test('scope-expanding change_request → stale + review→offered + rotated token (C8)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'review',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: 1, // granted
      lastSub: B.address,
      referencedRepoShas: [], // nothing referenced yet → a new artifact expands scope
    });
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        A.token,
        envFor('change_request', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: B.address,
          body: 'rework with a new commit',
          artifacts: [{ type: 'git_commit', repo: TEST_REPO, ref: 'main', sha: GIT_SHA }],
        }),
      ),
    });
    expect(res.ok).toBe(true);
    expect(res.thread.status).toBe('offered'); // structural re-offer [S]
    expect(res.thread.consent_state).toBe('stale');
    expect(res.message.consent_token).toBeTruthy(); // fresh reconsent token stamped
  });

  test('non-expanding change_request → review→in_progress, consent stays granted (C9)', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t);
    const seed = await seedThread(t, {
      rootKind: 'task',
      status: 'review',
      initiator: A.address,
      recipient: B.address,
      consentGrantSeq: 1,
      lastSub: B.address,
      referencedRepoShas: [`${TEST_REPO} ${GIT_SHA}`], // already referenced
    });
    const res = await t.mutation(api.send.send, {
      request: sendReq(
        A.token,
        envFor('change_request', {
          thread_id: seed.threadId,
          parent_id: seed.headId,
          to: B.address,
          body: 'small tweak, same commit',
          artifacts: [{ type: 'git_commit', repo: TEST_REPO, ref: 'main', sha: GIT_SHA }],
        }),
      ),
    });
    expect(res.ok).toBe(true);
    expect(res.thread.status).toBe('in_progress');
    expect(res.thread.consent_state).toBe('granted');
  });
});
