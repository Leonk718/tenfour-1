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
  type T,
  type Party,
} from './testutil';

const modules = import.meta.glob('./**/*.*s');

/**
 * Independent transcription of STATE-MACHINE §5.1 / §5.2 (NOT imported from the impl).
 * Returns the outcome the broker must produce for (rootKind, state, kind, role).
 *
 * Note (STATE §2 / §24): the state table is consulted ONLY after the envelope-level
 * schema checks (§3 step 6) pass. `task` is never schema-valid on an existing thread
 * ("task always opens a thread: thread_id must be null"), so every task-on-existing-
 * thread cell is preempted at step 6 → TENFOUR/UNKNOWN_KIND, the SAME code the table's
 * illegal_in_state cell would emit at step 9.
 */
type Expect =
  | { kind: 'unreachable' }
  | { kind: 'ok'; to: string; closed?: string }
  | { kind: 'err'; code: string };

function expectCell(
  rootKind: 'task' | 'question',
  state: string,
  kind: string,
  role: 'I' | 'O' | 'SYS',
): Expect {
  if (role === 'SYS') return { kind: 'unreachable' }; // ✗SYS: system has no wire send path
  if (kind === 'task') return { kind: 'err', code: 'UNKNOWN_KIND' }; // schema-preempted, any state
  if (state === 'closed') return { kind: 'err', code: 'TERMINAL_THREAD' };
  if (state === 'frozen') return { kind: 'err', code: 'THREAD_FROZEN' };

  if (rootKind === 'question') {
    // state === 'open'
    switch (kind) {
      case 'answer':
        return role === 'O'
          ? { kind: 'ok', to: 'closed', closed: 'answered' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' };
      case 'cancel':
        return role === 'I'
          ? { kind: 'ok', to: 'closed', closed: 'cancelled' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' };
      case 'needs_human':
        return { kind: 'ok', to: 'frozen' };
      default: // question, accepted, declined, result, change_request, done
        return { kind: 'err', code: 'UNKNOWN_KIND' };
    }
  }

  // Task thread, active state (offered | in_progress | review).
  switch (kind) {
    case 'question':
      return { kind: 'ok', to: state };
    case 'answer':
      return { kind: 'ok', to: state };
    case 'accepted':
      return state === 'offered'
        ? role === 'O'
          ? { kind: 'ok', to: 'in_progress' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' }
        : { kind: 'err', code: 'UNKNOWN_KIND' };
    case 'declined':
      return state === 'offered'
        ? role === 'O'
          ? { kind: 'ok', to: 'closed', closed: 'declined' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' }
        : { kind: 'err', code: 'UNKNOWN_KIND' };
    case 'result':
      return state === 'in_progress' || state === 'review'
        ? role === 'O'
          ? { kind: 'ok', to: 'review' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' }
        : { kind: 'err', code: 'UNKNOWN_KIND' };
    case 'change_request':
      return state === 'review'
        ? role === 'I'
          ? { kind: 'ok', to: 'in_progress' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' }
        : { kind: 'err', code: 'UNKNOWN_KIND' };
    case 'cancel':
      return role === 'I'
        ? { kind: 'ok', to: 'closed', closed: 'cancelled' }
        : { kind: 'err', code: 'NOT_THREAD_PARTY' };
    case 'done':
      return state === 'review'
        ? role === 'I'
          ? { kind: 'ok', to: 'closed', closed: 'done' }
          : { kind: 'err', code: 'NOT_THREAD_PARTY' }
        : { kind: 'err', code: 'UNKNOWN_KIND' };
    case 'needs_human':
      return { kind: 'ok', to: 'frozen' };
    default:
      return { kind: 'err', code: 'UNKNOWN_KIND' };
  }
}

const KINDS = [
  'task',
  'question',
  'answer',
  'accepted',
  'declined',
  'result',
  'change_request',
  'cancel',
  'done',
  'needs_human',
];
const ROLES: Array<'I' | 'O' | 'SYS'> = ['I', 'O', 'SYS'];
const TASK_STATES = ['offered', 'in_progress', 'review', 'frozen', 'closed'];
const Q_STATES = ['open', 'frozen', 'closed'];

async function runCell(
  t: T,
  A: Party,
  B: Party,
  rootKind: 'task' | 'question',
  state: string,
  kind: string,
  role: 'I' | 'O',
): Promise<{ res: any; threadId: string }> {
  const sender = role === 'I' ? A : B;
  const to = role === 'I' ? B.address : A.address;
  // Isolate each cell from the per-agent rate window (rate is exercised in its own suite).
  await t.run(async (ctx) => {
    for (const e of await ctx.db.query('rate_events').collect()) await ctx.db.delete(e._id);
  });
  const active = state === 'offered' || state === 'in_progress' || state === 'review' || state === 'open';
  const isAccOffered = kind === 'accepted' && state === 'offered';
  const consentToken = isAccOffered ? mintConsentToken() : null;
  const grantSeq = isAccOffered ? null : active ? 1 : null;

  // Task-thread answer needs an open question authored by the counterparty (becomes head).
  const openQuestionFrom =
    rootKind === 'task' && kind === 'answer' && active ? (role === 'I' ? B.address : A.address) : null;

  const seed = await seedThread(t, {
    rootKind,
    status: state,
    initiator: A.address,
    recipient: B.address,
    round: 1,
    maxRounds: 10,
    lastSub: A.address,
    consentGrantSeq: grantSeq,
    consentToken,
    resumeState: state === 'frozen' ? (rootKind === 'task' ? 'in_progress' : 'open') : null,
    frozenReason: state === 'frozen' ? 'needs_human' : null,
    frozenBy: state === 'frozen' ? A.address : null,
    closedReason: state === 'closed' ? 'cancelled' : null,
    openQuestionFrom,
  });

  const inReplyTo = kind === 'answer' ? (seed.inReplyTo ?? seed.rootId) : null;
  const env = envFor(kind, {
    thread_id: seed.threadId,
    parent_id: seed.headId,
    to,
    in_reply_to: inReplyTo,
  });
  if (kind === 'task') {
    // Force task onto the existing thread to exercise the schema-preempt path.
    env.thread_id = seed.threadId;
    env.parent_id = seed.headId;
  }

  const extra: any = {};
  if (kind === 'accepted') {
    extra.consent = { token: consentToken ?? 'AAAAAAAAAAAAAAAAAAAAAA', granted_via: 'cli_accept' };
  }
  const res = await t.mutation(api.send.send, { request: sendReq(sender.token, env, extra) });
  return { res, threadId: seed.threadId };
}

describe('state machine (STATE-MACHINE §5.1 / §5.2 — every kind×state×role cell)', () => {
  test('table-driven: walk every cell and assert its exact outcome', async () => {
    const t = convexTest(schema, modules);
    const { A, B } = await seedPair(t, { maxRounds: 10 });

    const combos: Array<['task' | 'question', string, string, 'I' | 'O' | 'SYS']> = [];
    for (const s of TASK_STATES) for (const k of KINDS) for (const r of ROLES) combos.push(['task', s, k, r]);
    for (const s of Q_STATES) for (const k of KINDS) for (const r of ROLES) combos.push(['question', s, k, r]);

    let covered = 0;
    let io = 0;
    let sys = 0;

    for (const [rootKind, state, kind, role] of combos) {
      covered++;
      const cellId = `${rootKind}.${state}.${kind}.${role}`;
      const exp = expectCell(rootKind, state, kind, role);

      if (role === 'SYS' || exp.kind === 'unreachable') {
        // ✗SYS: `tenfour/system` cannot authenticate (ID-4), so no wire path emits this cell.
        sys++;
        continue;
      }
      io++;

      const { res, threadId } = await runCell(t, A, B, rootKind, state, kind, role as 'I' | 'O');

      if (exp.kind === 'ok') {
        expect(res.ok, `${cellId}: expected ok → ${exp.to}, got ${JSON.stringify(res.error ?? {})}`).toBe(true);
        expect(res.thread.status, `${cellId}: status`).toBe(exp.to);
        if (exp.closed) {
          const closedReason = await t.run(async (ctx) => {
            const th = await ctx.db
              .query('threads')
              .withIndex('by_thread_id', (q: any) => q.eq('thread_id', threadId))
              .unique();
            return th?.closed_reason;
          });
          expect(closedReason, `${cellId}: closed_reason`).toBe(exp.closed);
        }
      } else {
        expect(res.ok, `${cellId}: expected err ${exp.code}, got ok`).toBe(false);
        expect(res.error.code, `${cellId}: code`).toBe(`TENFOUR/${exp.code}`);
      }
    }

    // Coverage accounting: task 5×10×3 + question 3×10×3 = 240 cells; 160 I/O, 80 ✗SYS.
    expect(covered).toBe(240);
    expect(io).toBe(160);
    expect(sys).toBe(80);
  });
});
