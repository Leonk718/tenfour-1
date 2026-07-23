/**
 * tenfour broker — shared server-side helpers: authentication, pair authorization,
 * consent-state derivation, wire-object assembly, per-recipient inbox seq, and typed
 * error construction (bytes owned by adapter strings.ts).
 */
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import {
  ERRORS,
  toWireError,
  type TenfourErrorCode,
} from '../../../adapter/src/strings.ts';
import { PROTOCOL_VERSION, SYSTEM_AGENT } from '../../../schema/src/protocol.ts';
import { sha256Hex } from './ids.ts';

export const BROKER_VERSION = 'tenfour-broker/0.0.0';
export const BROKER_URL = 'https://broker.tenfour.example';

/** A typed protocol error response, shaped by protocol.ts ErrorResponseSchema. */
export type WireError = {
  ok: false;
  error: {
    code: `TENFOUR/${TenfourErrorCode}`;
    message: string;
    human_action: string;
    retryable: false;
    data?: Record<string, unknown>;
  };
};

/** Build a typed { ok:false, error } response. `data.reason` is merged when supplied. */
export function berr(
  code: TenfourErrorCode,
  opts: {
    vars?: Record<string, string | number>;
    data?: Record<string, unknown>;
    reason?: string;
  } = {},
): WireError {
  const wire = toWireError(code, opts.vars ?? {});
  const data: Record<string, unknown> = { ...(opts.data ?? {}) };
  if (opts.reason !== undefined) data.reason = opts.reason;
  const error: WireError['error'] = { ...wire };
  if (Object.keys(data).length > 0) error.data = data;
  return { ok: false, error };
}

export const shortId = (id: string): string => id.slice(0, 8);

/* ── Authentication (AUTH §3.2, CRED-6) ─────────────────────────────────────── */

export type AuthOk = { ok: true; agent: string };
export type AuthResult = AuthOk | WireError;

/**
 * Hash-then-lookup verification (CRED-6). Wrong-token and wrong-agent share one code
 * path. A retained revoked credential → AUTH_REVOKED (REV-2); anything else →
 * AUTH_FAILED (ENUM-1), byte-identical across causes.
 */
export async function authenticate(
  ctx: QueryCtx | MutationCtx,
  token: unknown,
): Promise<AuthResult> {
  if (typeof token !== 'string' || !/^tf1_[A-Za-z0-9_-]{43}$/.test(token)) {
    return berr('AUTH_FAILED');
  }
  const hash = await sha256Hex(token);
  const row = await ctx.db
    .query('agents')
    .withIndex('by_token', (q) => q.eq('token_sha256', hash))
    .unique();
  if (!row) return berr('AUTH_FAILED');
  if (row.status === 'revoked') return berr('AUTH_REVOKED');
  if (row.status !== 'active' || row.role !== 'agent') return berr('AUTH_FAILED');
  return { ok: true, agent: row.address };
}

/* ── Pair authorization (AUTH §4.3) ─────────────────────────────────────────── */

/** The active pair a given agent belongs to, or null. */
export async function activePairFor(
  ctx: QueryCtx | MutationCtx,
  agent: string,
): Promise<Doc<'pairs'> | null> {
  const asA = await ctx.db
    .query('pairs')
    .withIndex('by_member_a', (q) => q.eq('member_a', agent))
    .collect();
  for (const p of asA) if (p.status === 'active') return p;
  const asB = await ctx.db
    .query('pairs')
    .withIndex('by_member_b', (q) => q.eq('member_b', agent))
    .collect();
  for (const p of asB) if (p.status === 'active') return p;
  return null;
}

/** The paired peer of `agent` within an active pair, or null. */
export function peerOf(pair: Doc<'pairs'>, agent: string): string | null {
  if (pair.member_a === agent) return pair.member_b;
  if (pair.member_b === agent) return pair.member_a;
  return null;
}

/* ── Consent-state derivation (CONSENT §2.3) ────────────────────────────────── */

export type ConsentState = 'not_required' | 'none' | 'granted' | 'stale' | 'revoked';

export function consentStateOf(thread: Doc<'threads'>): ConsentState {
  if (thread.root_kind === 'question') return 'not_required';
  if (thread.consent_grant_seq === null) return 'none';
  if (
    thread.reconsent_trigger_seq !== null &&
    thread.reconsent_trigger_seq > thread.consent_grant_seq
  ) {
    return 'stale';
  }
  return 'granted';
}

/** Assemble the wire ConsentRecord (protocol.ts ConsentRecordSchema). */
export function assembleConsent(thread: Doc<'threads'>) {
  return {
    state: consentStateOf(thread),
    granted_at: thread.consent_granted_at,
    granted_via: thread.consent_granted_via,
    scope: 'whole_thread' as const,
  };
}

/** Assemble a wire ThreadSummary (protocol.ts ThreadSummarySchema). */
export function assembleThreadSummary(thread: Doc<'threads'>) {
  return {
    thread_id: thread.thread_id,
    root_kind: thread.root_kind,
    status: thread.status,
    round: thread.round,
    max_rounds: thread.max_rounds,
    head_id: thread.head_id,
    head_seq: thread.head_seq,
    repo: thread.repo,
    consent_state: consentStateOf(thread),
  };
}

/** Assemble the full wire Thread object (protocol.ts ThreadSchema). */
export function assembleThread(thread: Doc<'threads'>) {
  return {
    thread_id: thread.thread_id,
    root_kind: thread.root_kind,
    initiator: thread.initiator,
    recipient: thread.recipient,
    status: thread.status,
    resume_state: thread.resume_state,
    frozen_reason: thread.frozen_reason,
    frozen_by: thread.frozen_by,
    closed_reason: thread.closed_reason,
    round: thread.round,
    max_rounds: thread.max_rounds,
    head_id: thread.head_id,
    head_seq: thread.head_seq,
    repo: thread.repo,
    consent: assembleConsent(thread),
    created_at: thread.created_at,
    updated_at: thread.updated_at,
  };
}

/** Assemble a stamped envelope (protocol.ts StampedEnvelopeSchema) from a message row. */
export function assembleStamped(m: Doc<'messages'>) {
  return {
    protocol: PROTOCOL_VERSION,
    id: m.id,
    client_id: m.client_id,
    thread_id: m.thread_id,
    parent_id: m.parent_id,
    in_reply_to: m.in_reply_to,
    from: m.from,
    to: m.to,
    kind: m.kind,
    repo: m.repo,
    body: m.body,
    artifacts: m.artifacts,
    seq: m.seq,
    ts: m.ts,
    round: m.round,
    status: m.status,
    delivery_state: m.delivery_state,
    consent_token: m.consent_token,
    unfroze: m.unfroze,
  };
}

/** Assemble the compact InboxThreadInfo (protocol.ts InboxThreadInfoSchema). */
export function assembleInboxThreadInfo(thread: Doc<'threads'>) {
  return {
    thread_id: thread.thread_id,
    root_kind: thread.root_kind,
    status: thread.status,
    round: thread.round,
    max_rounds: thread.max_rounds,
    repo: thread.repo,
  };
}

/* ── Inbox rows (DELIVERY §2) ───────────────────────────────────────────────── */

/** Next per-recipient monotonic inbox_seq (DELIVERY §7 DEL-29). */
export async function nextInboxSeq(ctx: MutationCtx, recipient: string): Promise<number> {
  const last = await ctx.db
    .query('messages')
    .withIndex('by_recipient_inbox', (q) => q.eq('recipient', recipient))
    .order('desc')
    .first();
  return (last?.inbox_seq ?? 0) + 1;
}

export { SYSTEM_AGENT, ERRORS };
