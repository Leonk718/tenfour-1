import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * tenfour/1 broker schema.
 *
 * Column shapes follow packages/schema/src/protocol.ts (the wire authority) and the
 * normative specs (AUTH.md, STATE-MACHINE.md, DELIVERY.md, CONSENT.md). Wire-level
 * shape enforcement lives in the Zod schemas of protocol.ts; these validators guard
 * what the broker persists.
 */

// Thread status enum (protocol.ts THREAD_STATUSES).
const threadStatus = v.union(
  v.literal('offered'),
  v.literal('in_progress'),
  v.literal('review'),
  v.literal('closed'),
  v.literal('frozen'),
  v.literal('open'),
);

const deliveryState = v.union(
  v.literal('queued'),
  v.literal('claimed'),
  v.literal('injected'),
  v.literal('acked'),
);

export default defineSchema({
  // AUTH §2.2 — principals.
  agents: defineTable({
    address: v.string(),
    role: v.union(v.literal('agent'), v.literal('system')),
    token_sha256: v.union(v.null(), v.string()),
    status: v.union(v.literal('invited'), v.literal('active'), v.literal('revoked')),
    created_at: v.number(),
    // diag.ping presence beacon (READ-6 / WIRE D26).
    last_ping_ts: v.union(v.null(), v.number()),
    last_mark: v.union(v.null(), v.string()),
  })
    .index('by_address', ['address'])
    .index('by_token', ['token_sha256'])
    .index('by_status', ['status']),

  // AUTH §4.1 — the pair model (max_rounds + repo_allowlist copied from the invite).
  pairs: defineTable({
    pair_id: v.string(),
    member_a: v.string(), // lexicographically < member_b
    member_b: v.string(),
    status: v.union(v.literal('active'), v.literal('dissolved')),
    max_rounds: v.number(),
    repo_allowlist: v.union(v.null(), v.array(v.string())),
    created_at: v.number(),
  })
    .index('by_member_a', ['member_a'])
    .index('by_member_b', ['member_b'])
    .index('by_status', ['status']),

  // AUTH §6.1 — invites.
  invites: defineTable({
    invite_id: v.string(),
    address: v.string(),
    pair_with: v.union(v.null(), v.string()),
    secret_sha256: v.string(),
    exp: v.number(),
    status: v.union(
      v.literal('outstanding'),
      v.literal('redeemed'),
      v.literal('revoked'),
      v.literal('superseded'),
    ),
    redeem_failures: v.number(),
    max_rounds: v.number(),
    repo_allowlist: v.union(v.null(), v.array(v.string())),
    created_at: v.number(),
  })
    .index('by_invite_id', ['invite_id'])
    .index('by_address', ['address']),

  // ThreadSchema (protocol.ts) + broker-internal round/consent/scope bookkeeping.
  threads: defineTable({
    thread_id: v.string(),
    root_kind: v.union(v.literal('task'), v.literal('question')),
    initiator: v.string(),
    recipient: v.string(),
    status: threadStatus,
    resume_state: v.union(v.null(), threadStatus),
    frozen_reason: v.union(v.null(), v.literal('round_cap'), v.literal('needs_human')),
    frozen_by: v.union(v.null(), v.string()),
    closed_reason: v.union(
      v.null(),
      v.literal('answered'),
      v.literal('declined'),
      v.literal('cancelled'),
      v.literal('done'),
    ),
    round: v.number(),
    max_rounds: v.number(),
    head_id: v.string(),
    head_seq: v.number(),
    root_id: v.string(),
    repo: v.union(v.null(), v.string()),
    // Internal (never on the wire).
    pending_repo: v.union(v.null(), v.string()),
    last_substantive_sender: v.union(v.null(), v.string()),
    consent_granted_at: v.union(v.null(), v.number()),
    consent_granted_via: v.union(v.null(), v.literal('cli_accept'), v.literal('standing_rule')),
    consent_grant_seq: v.union(v.null(), v.number()),
    consent_token: v.union(v.null(), v.string()),
    reconsent_trigger_seq: v.union(v.null(), v.number()),
    referenced_repo_shas: v.array(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index('by_thread_id', ['thread_id']),

  // Stamped envelope (protocol.ts StampedEnvelopeSchema) fused with the per-recipient
  // inbox row (DELIVERY §2). A system fan-out creates two rows sharing (id, seq).
  messages: defineTable({
    id: v.string(),
    client_id: v.string(),
    thread_id: v.string(),
    parent_id: v.union(v.null(), v.string()),
    in_reply_to: v.union(v.null(), v.string()),
    from: v.string(),
    to: v.string(), // AgentName or the "thread" sentinel (system fan-out)
    kind: v.string(),
    repo: v.union(v.null(), v.string()),
    body: v.string(),
    artifacts: v.array(v.any()),
    seq: v.number(),
    ts: v.number(),
    round: v.number(),
    status: threadStatus, // thread status AFTER this message
    consent_token: v.union(v.null(), v.string()),
    unfroze: v.boolean(),
    // Per-recipient delivery state (DELIVERY §2).
    recipient: v.string(),
    delivery_state: deliveryState,
    claim: v.union(
      v.null(),
      v.object({
        attempt_id: v.string(),
        holder: v.string(),
        lease_expires: v.number(),
      }),
    ),
    prior_attempts: v.number(),
    inbox_seq: v.number(),
    acked_attempt_id: v.union(v.null(), v.string()),
    answered: v.boolean(), // question rows: closed by an answer
  })
    .index('by_thread_seq', ['thread_id', 'seq'])
    .index('by_recipient_inbox', ['recipient', 'inbox_seq'])
    .index('by_msgid', ['id'])
    .index('by_msgid_recipient', ['id', 'recipient']),

  // STATE §9 — exact sliding-log rate window, per sending agent + method.
  rate_events: defineTable({
    agent: v.string(),
    method: v.string(),
    ts: v.number(),
  }).index('by_agent_method_ts', ['agent', 'method', 'ts']),

  // WIRE §7.1 step 4 — client_id ↔ content-hash dedup.
  dedup: defineTable({
    sender: v.string(),
    client_id: v.string(),
    content_hash: v.string(),
    message_id: v.string(),
  }).index('by_sender_client', ['sender', 'client_id']),

  // Broker control-plane config (admin key hash). Singleton.
  config: defineTable({
    admin_key_sha256: v.string(),
  }),
});
