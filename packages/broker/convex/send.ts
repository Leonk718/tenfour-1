/**
 * tenfour/1 — send mutation.
 *
 * Implements the FULL 13-step ordered validation (STATE-MACHINE §3 / WIRE §7.1 D19 /
 * AUTH §3.4) and the complete kind×state×role transition table (STATE-MACHINE §4–§5),
 * atomically inside one Convex mutation (STATE §8.4).
 *
 * `args` is intentionally permissive (v.any): the whole point of `send` is to observe
 * malformed requests and return the FIRST-by-precedence TENFOUR/<code>, not a framework
 * ArgumentValidationError. Wire shapes are enforced by the Zod authority (protocol.ts).
 */
import { mutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import {
  checkVersion,
  checkSendSemantics,
  contentHash,
  SUBSTANTIVE_KINDS,
  PROTOCOL_VERSION,
  RATE_LIMITS,
  THREAD_SENTINEL,
  type ContentHashInput,
  type Kind,
  type ThreadStatus,
  type ClosedReason,
  type ClientEnvelope,
} from '../../schema/src/protocol.ts';
import {
  ROUND_CAP_SYSTEM_BODY,
  SEND_DUPLICATE_NOTE,
  fmt,
  type TenfourErrorCode,
} from '../../adapter/src/strings.ts';
import { ulid, mintConsentToken } from './lib/ids.ts';
import {
  authenticate,
  activePairFor,
  peerOf,
  berr,
  shortId,
  consentStateOf,
  assembleStamped,
  assembleThreadSummary,
  nextInboxSeq,
  SYSTEM_AGENT,
  type WireError,
} from './lib/core.ts';

/* ── Transition table (STATE-MACHINE §5.1 / §5.2) ───────────────────────────── */

type Cell =
  | { t: 'persist'; to: ThreadStatus; closed?: ClosedReason; freeze?: ThreadStatus }
  | { t: 'role_forbidden' }
  | { t: 'illegal' };

const ILLEGAL: Cell = { t: 'illegal' };
const NTP: Cell = { t: 'role_forbidden' };

/**
 * The cell for (rootKind, active state, kind, role). Frozen/closed states are handled
 * by the caller before this is consulted; `state` here is an active state
 * (task: offered|in_progress|review, question: open). `answer` validity and
 * change_request scope expansion are resolved by the caller after this returns persist.
 */
function cellFor(
  rootKind: 'task' | 'question',
  state: ThreadStatus,
  kind: Kind,
  role: 'I' | 'O',
): Cell {
  if (rootKind === 'question') {
    // Micro-thread; state === 'open'.
    switch (kind) {
      case 'answer':
        return role === 'O' ? { t: 'persist', to: 'closed', closed: 'answered' } : NTP;
      case 'cancel':
        return role === 'I' ? { t: 'persist', to: 'closed', closed: 'cancelled' } : NTP;
      case 'needs_human':
        return { t: 'persist', to: 'frozen', freeze: 'open' };
      default:
        return ILLEGAL; // task, question, accepted, declined, result, change_request, done
    }
  }
  // Task thread.
  switch (kind) {
    case 'task':
      return ILLEGAL;
    case 'question':
      return { t: 'persist', to: state };
    case 'answer':
      return { t: 'persist', to: state };
    case 'accepted':
      if (state === 'offered') return role === 'O' ? { t: 'persist', to: 'in_progress' } : NTP;
      return ILLEGAL;
    case 'declined':
      if (state === 'offered')
        return role === 'O' ? { t: 'persist', to: 'closed', closed: 'declined' } : NTP;
      return ILLEGAL;
    case 'result':
      if (state === 'in_progress' || state === 'review')
        return role === 'O' ? { t: 'persist', to: 'review' } : NTP;
      return ILLEGAL;
    case 'change_request':
      if (state === 'review') return role === 'I' ? { t: 'persist', to: 'in_progress' } : NTP;
      return ILLEGAL;
    case 'cancel':
      return role === 'I' ? { t: 'persist', to: 'closed', closed: 'cancelled' } : NTP;
    case 'done':
      if (state === 'review')
        return role === 'I' ? { t: 'persist', to: 'closed', closed: 'done' } : NTP;
      return ILLEGAL;
    case 'needs_human':
      return { t: 'persist', to: 'frozen', freeze: state };
    default:
      return ILLEGAL;
  }
}

const ALL_KINDS: Kind[] = [
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

/** Kinds the sender's role may persist in the current state (STATE §2 legal_kinds[]). */
function legalKindsFor(
  rootKind: 'task' | 'question',
  state: ThreadStatus,
  role: 'I' | 'O',
): string[] {
  return ALL_KINDS.filter((k) => cellFor(rootKind, state, k, role).t === 'persist');
}

/** Convert a protocol.ts CheckResult failure to a wire error. */
function checkFail(res: { code: string; reason?: string }): WireError {
  const short = res.code.replace('TENFOUR/', '') as TenfourErrorCode;
  return berr(short, { reason: res.reason });
}

/* ── System round-cap freeze fan-out (STATE §8.4 / DELIVERY §10) ─────────────── */

async function postSystemFreeze(
  ctx: MutationCtx,
  thread: Doc<'threads'>,
  resumeState: ThreadStatus,
  now: number,
): Promise<void> {
  const id = ulid(now);
  const seq = thread.head_seq + 1;
  const body = fmt(ROUND_CAP_SYSTEM_BODY, {
    max_rounds: thread.max_rounds,
    thread_short: shortId(thread.thread_id),
  });
  // One thread event, two inbox rows (DEL-42) — one per party.
  for (const recipient of [thread.initiator, thread.recipient]) {
    const inbox_seq = await nextInboxSeq(ctx, recipient);
    await ctx.db.insert('messages', {
      id,
      client_id: id,
      thread_id: thread.thread_id,
      parent_id: thread.head_id,
      in_reply_to: null,
      from: SYSTEM_AGENT,
      to: THREAD_SENTINEL,
      kind: 'needs_human',
      repo: null,
      body,
      artifacts: [],
      seq,
      ts: now,
      round: thread.round,
      status: 'frozen',
      consent_token: null,
      unfroze: false,
      recipient,
      delivery_state: 'queued',
      claim: null,
      prior_attempts: 0,
      inbox_seq,
      acked_attempt_id: null,
      answered: false,
    });
  }
  await ctx.db.patch(thread._id, {
    status: 'frozen',
    resume_state: resumeState,
    frozen_reason: 'round_cap',
    frozen_by: SYSTEM_AGENT,
    head_id: id,
    head_seq: seq,
    updated_at: now,
  });
}

/* ── The send mutation ──────────────────────────────────────────────────────── */

export const send = mutation({
  args: { request: v.any() },
  returns: v.any(),
  handler: async (ctx, { request }): Promise<any> => {
    const now = Date.now();

    // Step 1 — version.
    const ver = checkVersion(request);
    if (!ver.ok) return checkFail(ver);
    const raw = ver.value;

    // Step 2 — auth.
    const auth = await authenticate(ctx, raw.auth?.token);
    if (!auth.ok) return auth;
    const sender = auth.agent;

    // Step 3 — pair.
    const to = (raw.envelope as { to?: unknown }).to;
    const pair = await activePairFor(ctx, sender);
    if (!pair) return berr('PAIR_FORBIDDEN', { vars: { to: typeof to === 'string' ? to : '' } });
    const peer = peerOf(pair, sender);
    if (typeof to !== 'string' || to !== peer) {
      return berr('PAIR_FORBIDDEN', { vars: { to: typeof to === 'string' ? to : '' } });
    }

    // Step 4 — client_id dedup (precedes rate: R11 retries never counted, STATE §3).
    const rawEnv = raw.envelope as Record<string, unknown>;
    const clientId = rawEnv.client_id;
    const hashInput: ContentHashInput = {
      protocol: PROTOCOL_VERSION,
      to: typeof rawEnv.to === 'string' ? rawEnv.to : '',
      kind: (typeof rawEnv.kind === 'string' ? rawEnv.kind : '') as Kind,
      body: typeof rawEnv.body === 'string' ? rawEnv.body : '',
      thread_id: (rawEnv.thread_id as string | null) ?? null,
      parent_id: (rawEnv.parent_id as string | null) ?? null,
      in_reply_to: (rawEnv.in_reply_to as string | null) ?? null,
      repo: (rawEnv.repo as string | null) ?? null,
      artifacts: (Array.isArray(rawEnv.artifacts)
        ? rawEnv.artifacts
        : []) as ContentHashInput['artifacts'],
    };
    let hash: string;
    try {
      hash = await contentHash(hashInput);
    } catch {
      hash = 'sha256:unhashable';
    }
    if (typeof clientId === 'string') {
      const existing = await ctx.db
        .query('dedup')
        .withIndex('by_sender_client', (q) => q.eq('sender', sender).eq('client_id', clientId))
        .unique();
      if (existing) {
        if (existing.content_hash === hash) {
          const orig = await ctx.db
            .query('messages')
            .withIndex('by_msgid', (q) => q.eq('id', existing.message_id))
            .first();
          if (orig) {
            const th = await ctx.db
              .query('threads')
              .withIndex('by_thread_id', (q) => q.eq('thread_id', orig.thread_id))
              .unique();
            return {
              ok: true,
              duplicate: true,
              note: fmt(SEND_DUPLICATE_NOTE, {
                id: orig.id,
                delivery_state: orig.delivery_state,
              }),
              message: assembleStamped(orig),
              thread: th ? assembleThreadSummary(th) : null,
            };
          }
        } else {
          return berr('CLIENT_ID_CONFLICT');
        }
      }
    }

    // Step 5 — rate (sliding log; persisted sends only; both send windows).
    for (const w of RATE_LIMITS.send) {
      const cutoff = now - w.window_s * 1000;
      const events = await ctx.db
        .query('rate_events')
        .withIndex('by_agent_method_ts', (q) =>
          q.eq('agent', sender).eq('method', 'send').gt('ts', cutoff),
        )
        .collect();
      if (events.length >= w.limit) {
        const oldest = Math.min(...events.map((e) => e.ts));
        return berr('RATE_LIMITED', {
          data: {
            method: 'send',
            limit: w.limit,
            window_s: w.window_s,
            oldest_expires_in_s: Math.ceil((oldest + w.window_s * 1000 - now) / 1000),
          },
        });
      }
    }

    // Steps 6-7 — schema/caps + secret scan (body NFC-normalized inside).
    const sem = checkSendSemantics(raw);
    if (!sem.ok) return checkFail(sem);
    const req = sem.value;
    const envelope: ClientEnvelope = req.envelope;
    const kind = envelope.kind;
    const unfreeze = req.unfreeze === true;

    /* ── Root creation (thread_id: null) — STATE §4 ─────────────────────────── */
    if (envelope.thread_id === null) {
      // kind is task|question (client schema guarantees root-legality).
      // Step 12 — allowlist for task repo.
      if (kind === 'task' && pair.repo_allowlist !== null && envelope.repo !== null) {
        if (!pair.repo_allowlist.includes(envelope.repo)) {
          return berr('REPO_NOT_ALLOWED', { vars: { repo: envelope.repo } });
        }
      }
      const threadId = ulid(now);
      const rootId = ulid(now);
      const isTask = kind === 'task';
      const status: ThreadStatus = isTask ? 'offered' : 'open';
      const consentToken = isTask ? mintConsentToken() : null;
      const refs: string[] = [];
      for (const a of envelope.artifacts) {
        if (a.type === 'git_commit' || a.type === 'git_branch') refs.push(`${a.repo} ${a.sha}`);
      }
      const threadDocId = await ctx.db.insert('threads', {
        thread_id: threadId,
        root_kind: isTask ? 'task' : 'question',
        initiator: sender,
        recipient: to,
        status,
        resume_state: null,
        frozen_reason: null,
        frozen_by: null,
        closed_reason: null,
        round: 1,
        max_rounds: pair.max_rounds,
        head_id: rootId,
        head_seq: 1,
        root_id: rootId,
        repo: isTask ? envelope.repo : null,
        pending_repo: null,
        last_substantive_sender: sender,
        consent_granted_at: null,
        consent_granted_via: null,
        consent_grant_seq: null,
        consent_token: consentToken,
        reconsent_trigger_seq: null,
        referenced_repo_shas: refs,
        created_at: now,
        updated_at: now,
      });
      const inbox_seq = await nextInboxSeq(ctx, to);
      const msgId = await ctx.db.insert('messages', {
        id: rootId,
        client_id: envelope.client_id,
        thread_id: threadId,
        parent_id: null,
        in_reply_to: null,
        from: sender,
        to,
        kind,
        repo: isTask ? envelope.repo : null,
        body: envelope.body,
        artifacts: envelope.artifacts,
        seq: 1,
        ts: now,
        round: 1,
        status,
        consent_token: consentToken,
        unfroze: false,
        recipient: to,
        delivery_state: 'queued',
        claim: null,
        prior_attempts: 0,
        inbox_seq,
        acked_attempt_id: null,
        answered: false,
      });
      await ctx.db.insert('dedup', {
        sender,
        client_id: envelope.client_id,
        content_hash: hash,
        message_id: rootId,
      });
      await ctx.db.insert('rate_events', { agent: sender, method: 'send', ts: now });
      const m = (await ctx.db.get(msgId))!;
      const th = (await ctx.db.get(threadDocId))!;
      return {
        ok: true,
        duplicate: false,
        note: null,
        message: assembleStamped(m),
        thread: assembleThreadSummary(th),
      };
    }

    /* ── Existing thread ────────────────────────────────────────────────────── */
    const thread = await ctx.db
      .query('threads')
      .withIndex('by_thread_id', (q) => q.eq('thread_id', envelope.thread_id!))
      .unique();
    if (!thread) return berr('THREAD_NOT_FOUND', { vars: { thread_id: envelope.thread_id } });
    const tShort = shortId(thread.thread_id);

    // Step 8 — party.
    const role: 'I' | 'O' | null =
      sender === thread.initiator ? 'I' : sender === thread.recipient ? 'O' : null;
    if (role === null) {
      return berr('NOT_THREAD_PARTY', { vars: { thread_short: tShort }, reason: 'not_party' });
    }

    // Step 9 — state machine.
    if (thread.status === 'closed') {
      return berr('TERMINAL_THREAD', {
        vars: { thread_short: tShort, closed_reason: thread.closed_reason ?? '' },
      });
    }
    let effState: ThreadStatus = thread.status;
    if (thread.status === 'frozen') {
      if (!unfreeze) {
        return berr('THREAD_FROZEN', {
          vars: { thread_short: tShort, frozen_reason: thread.frozen_reason ?? '' },
        });
      }
      effState = thread.resume_state!;
    }

    const cell = cellFor(thread.root_kind, effState, kind, role);
    if (cell.t === 'illegal') {
      return berr('UNKNOWN_KIND', {
        vars: { kind },
        reason: 'illegal_in_state',
        data: {
          state: effState,
          kind,
          legal_kinds: legalKindsFor(thread.root_kind, effState, role),
        },
      });
    }
    if (cell.t === 'role_forbidden') {
      return berr('NOT_THREAD_PARTY', { vars: { thread_short: tShort }, reason: 'role_forbidden' });
    }

    // answer in_reply_to validity ([A]/[A2]).
    if (kind === 'answer') {
      const irt = envelope.in_reply_to!;
      let valid = false;
      if (thread.root_kind === 'question') {
        valid = irt === thread.root_id;
      } else {
        const q = await ctx.db
          .query('messages')
          .withIndex('by_msgid', (qq) => qq.eq('id', irt))
          .first();
        const counterparty = role === 'I' ? thread.recipient : thread.initiator;
        valid =
          !!q &&
          q.thread_id === thread.thread_id &&
          q.kind === 'question' &&
          q.from === counterparty &&
          q.answered !== true;
      }
      if (!valid) {
        return berr('UNKNOWN_KIND', { vars: { kind }, reason: 'invalid_in_reply_to' });
      }
    }

    // change_request scope expansion ([S]).
    let newStatus: ThreadStatus = cell.to;
    let scopeExpanding = false;
    let repoChanged = false;
    if (kind === 'change_request' && cell.to === 'in_progress') {
      repoChanged = envelope.repo !== null && envelope.repo !== thread.repo;
      const seen = new Set(thread.referenced_repo_shas);
      const newArtifact = envelope.artifacts.some(
        (a) =>
          (a.type === 'git_commit' || a.type === 'git_branch') && !seen.has(`${a.repo} ${a.sha}`),
      );
      scopeExpanding = repoChanged || newArtifact;
      if (scopeExpanding) newStatus = 'offered';
    }

    // Step 10 — head rule.
    if (envelope.parent_id !== thread.head_id) {
      return berr('STALE_HEAD', {
        vars: { thread_short: tShort, head_id: thread.head_id },
        data: { head_id: thread.head_id, head_seq: thread.head_seq },
      });
    }

    // Step 11 — consent.
    if (kind === 'accepted') {
      const block = req.consent;
      if (!block || thread.consent_token === null || block.token !== thread.consent_token) {
        return berr('CONSENT_REQUIRED', {
          vars: {
            operation: 'send:accepted',
            thread_short: tShort,
            consent_state: consentStateOf(thread),
          },
          reason: 'bad_token',
        });
      }
    }
    if (kind === 'result' && consentStateOf(thread) !== 'granted') {
      return berr('CONSENT_REQUIRED', {
        vars: {
          operation: 'send:result',
          thread_short: tShort,
          consent_state: consentStateOf(thread),
        },
        reason: 'consent_not_granted',
      });
    }

    // Step 12 — repo allowlist.
    if (pair.repo_allowlist !== null) {
      const repos: string[] = [];
      if (envelope.repo !== null) repos.push(envelope.repo);
      for (const a of envelope.artifacts) repos.push(a.repo);
      for (const r of repos) {
        if (!pair.repo_allowlist.includes(r)) {
          return berr('REPO_NOT_ALLOWED', { vars: { repo: r } });
        }
      }
    }

    // Step 13 — round admission (atomic; breach → freeze + system fan-out).
    const substantive = (SUBSTANTIVE_KINDS as readonly string[]).includes(kind);
    const unfroze = unfreeze && thread.status === 'frozen';
    const baseRound = unfroze ? 0 : thread.round;
    const baseLastSub = unfroze ? null : thread.last_substantive_sender;
    let newRound = baseRound;
    let newLastSub = baseLastSub;
    if (substantive) {
      let computed: number;
      if (baseLastSub === null) computed = 1;
      else if (sender !== baseLastSub) computed = baseRound + 1;
      else computed = baseRound;
      if (computed > thread.max_rounds) {
        await postSystemFreeze(ctx, thread, effState, now);
        return berr('ROUND_CAP', {
          vars: { thread_short: tShort, max_rounds: thread.max_rounds },
          data: { state: 'frozen', rounds_used: thread.round, max_rounds: thread.max_rounds },
        });
      }
      newRound = computed;
      newLastSub = sender;
    }

    // ── Commit.
    const id = ulid(now);
    const seq = thread.head_seq + 1;
    const inbox_seq = await nextInboxSeq(ctx, to);
    const newConsentToken = kind === 'change_request' && scopeExpanding ? mintConsentToken() : null;

    let finalStatus: ThreadStatus;
    let finalResume: ThreadStatus | null = null;
    let finalFrozenReason: 'round_cap' | 'needs_human' | null = null;
    let finalFrozenBy: string | null = null;
    let finalClosed: ClosedReason | null = null;
    if (cell.freeze !== undefined) {
      finalStatus = 'frozen';
      finalResume = cell.freeze;
      finalFrozenReason = 'needs_human';
      finalFrozenBy = sender;
    } else if (cell.closed !== undefined) {
      finalStatus = 'closed';
      finalClosed = cell.closed;
    } else {
      finalStatus = newStatus;
    }

    const msgConsentToken = newConsentToken; // stamped on scope-expanding change_request
    const msgId = await ctx.db.insert('messages', {
      id,
      client_id: envelope.client_id,
      thread_id: thread.thread_id,
      parent_id: envelope.parent_id,
      in_reply_to: envelope.in_reply_to,
      from: sender,
      to,
      kind,
      repo: envelope.repo,
      body: envelope.body,
      artifacts: envelope.artifacts,
      seq,
      ts: now,
      round: newRound,
      status: finalStatus,
      consent_token: msgConsentToken,
      unfroze,
      recipient: to,
      delivery_state: 'queued',
      claim: null,
      prior_attempts: 0,
      inbox_seq,
      acked_attempt_id: null,
      answered: false,
    });

    // Mark an answered in-thread question ([A]).
    if (kind === 'answer' && thread.root_kind === 'task') {
      const q = await ctx.db
        .query('messages')
        .withIndex('by_msgid', (qq) => qq.eq('id', envelope.in_reply_to!))
        .first();
      if (q) await ctx.db.patch(q._id, { answered: true });
    }

    // Thread patch.
    const refs = [...thread.referenced_repo_shas];
    for (const a of envelope.artifacts) {
      if (a.type === 'git_commit' || a.type === 'git_branch') {
        const k = `${a.repo} ${a.sha}`;
        if (!refs.includes(k)) refs.push(k);
      }
    }
    const patch: Partial<Doc<'threads'>> = {
      head_id: id,
      head_seq: seq,
      status: finalStatus,
      round: newRound,
      last_substantive_sender: newLastSub,
      referenced_repo_shas: refs,
      updated_at: now,
      resume_state: finalStatus === 'frozen' ? finalResume : null,
      frozen_reason: finalStatus === 'frozen' ? finalFrozenReason : null,
      frozen_by: finalStatus === 'frozen' ? finalFrozenBy : null,
      closed_reason: finalStatus === 'closed' ? finalClosed : null,
    };
    if (kind === 'accepted') {
      patch.consent_grant_seq = seq;
      patch.consent_granted_at = now;
      patch.consent_granted_via = req.consent!.granted_via;
      patch.reconsent_trigger_seq = null;
      patch.consent_token = null;
      if (thread.pending_repo !== null) {
        patch.repo = thread.pending_repo;
        patch.pending_repo = null;
      }
    } else if (kind === 'change_request' && scopeExpanding) {
      patch.consent_token = newConsentToken;
      patch.reconsent_trigger_seq = seq;
      if (repoChanged) patch.pending_repo = envelope.repo;
    }
    await ctx.db.patch(thread._id, patch);

    await ctx.db.insert('dedup', {
      sender,
      client_id: envelope.client_id,
      content_hash: hash,
      message_id: id,
    });
    await ctx.db.insert('rate_events', { agent: sender, method: 'send', ts: now });

    const m = (await ctx.db.get(msgId))!;
    const th2 = (await ctx.db.get(thread._id))!;
    return {
      ok: true,
      duplicate: false,
      note: null,
      message: assembleStamped(m),
      thread: assembleThreadSummary(th2),
    };
  },
});
