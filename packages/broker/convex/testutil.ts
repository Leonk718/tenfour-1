/**
 * Shared test seeding helpers. Deliberately imports NO test framework (convex-test /
 * vitest) so it stays bundle-safe for `convex codegen`/deploy; it only uses the ambient
 * id/crypto lib and the generated api. Tests pass their `t` handle in.
 */
import { ulid, mintAgentToken, mintConsentToken, sha256Hex } from './lib/ids.ts';
import { PROTOCOL_VERSION } from '../../schema/src/protocol.ts';

// Vite provides import.meta.glob at build time; declare it so the strict tsc run (which
// has no Vite client types) accepts the test harness's module map.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

export const PROTO = PROTOCOL_VERSION;
export { ulid, mintAgentToken, mintConsentToken, sha256Hex };

/** Minimal structural view of a convex-test handle (avoids importing convex-test). */
export interface T {
  run<O>(fn: (ctx: any) => Promise<O>): Promise<O>;
  mutation(ref: any, args?: any): Promise<any>;
  query(ref: any, args?: any): Promise<any>;
}

export interface Party {
  address: string;
  token: string;
}

/** Seed two active agents and their active pair. initiator=A, owner/recipient=B. */
export async function seedPair(
  t: T,
  opts: { a?: string; b?: string; maxRounds?: number; repoAllowlist?: string[] | null } = {},
): Promise<{ A: Party; B: Party }> {
  const A: Party = { address: opts.a ?? 'alice/dev', token: mintAgentToken() };
  const B: Party = { address: opts.b ?? 'bob/dev', token: mintAgentToken() };
  const ha = await sha256Hex(A.token);
  const hb = await sha256Hex(B.token);
  const maxRounds = opts.maxRounds ?? 10;
  const repoAllowlist = opts.repoAllowlist ?? null;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('agents', {
      address: A.address,
      role: 'agent',
      token_sha256: ha,
      status: 'active',
      created_at: now,
      last_ping_ts: null,
      last_mark: null,
    });
    await ctx.db.insert('agents', {
      address: B.address,
      role: 'agent',
      token_sha256: hb,
      status: 'active',
      created_at: now,
      last_ping_ts: null,
      last_mark: null,
    });
    const [member_a, member_b] =
      A.address < B.address ? [A.address, B.address] : [B.address, A.address];
    await ctx.db.insert('pairs', {
      pair_id: ulid(),
      member_a,
      member_b,
      status: 'active',
      max_rounds: maxRounds,
      repo_allowlist: repoAllowlist,
      created_at: now,
    });
  });
  return { A, B };
}

/** Seed a single agent row directly. */
export async function seedAgent(
  t: T,
  address: string,
  status: 'invited' | 'active' | 'revoked',
): Promise<Party> {
  const token = mintAgentToken();
  const hash = await sha256Hex(token);
  await t.run(async (ctx) => {
    await ctx.db.insert('agents', {
      address,
      role: 'agent',
      token_sha256: hash,
      status,
      created_at: Date.now(),
      last_ping_ts: null,
      last_mark: null,
    });
  });
  return { address, token };
}

/** Seed the broker admin key; returns the plaintext key. */
export async function seedAdminKey(t: T): Promise<string> {
  const key = 'tfadmin_' + 'A'.repeat(43);
  const hash = await sha256Hex(key);
  await t.run(async (ctx) => {
    await ctx.db.insert('config', {
      admin_key_sha256: hash,
      broker_url: 'https://test-broker.convex.cloud',
    });
  });
  return key;
}

export const GIT_SHA = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
export const TEST_REPO = 'github.com/careswift/web';

/** A well-formed send envelope for one kind, with sensible per-kind defaults. */
export function envFor(
  kind: string,
  opts: {
    thread_id?: string | null;
    parent_id?: string | null;
    to: string;
    in_reply_to?: string | null;
    repo?: string | null;
    body?: string;
    artifacts?: unknown[];
  },
): Record<string, unknown> {
  const env: Record<string, unknown> = {
    protocol: PROTO,
    client_id: ulid(),
    thread_id: opts.thread_id ?? null,
    parent_id: opts.parent_id ?? null,
    in_reply_to: opts.in_reply_to ?? null,
    to: opts.to,
    kind,
    repo: opts.repo ?? null,
    body: opts.body ?? kind,
    artifacts: opts.artifacts ?? [],
  };
  if (kind === 'task') {
    env.thread_id = null;
    env.parent_id = null;
    env.repo = opts.repo ?? TEST_REPO;
    env.body = opts.body ?? 'do the work';
  } else if (kind === 'result') {
    env.artifacts = opts.artifacts ?? [
      { type: 'git_commit', repo: TEST_REPO, ref: 'main', sha: GIT_SHA },
    ];
    env.body = opts.body ?? 'finished';
  } else if (kind === 'accepted' || kind === 'cancel' || kind === 'done') {
    env.body = opts.body ?? '';
  }
  return env;
}

/** Directly seed a thread + its root message (and optionally an open in-thread question). */
export async function seedThread(
  t: T,
  o: {
    rootKind: 'task' | 'question';
    status: string;
    initiator: string;
    recipient: string;
    round?: number;
    maxRounds?: number;
    lastSub?: string | null;
    consentGrantSeq?: number | null;
    consentToken?: string | null;
    reconsentTriggerSeq?: number | null;
    repo?: string | null;
    referencedRepoShas?: string[];
    resumeState?: string | null;
    frozenReason?: string | null;
    frozenBy?: string | null;
    closedReason?: string | null;
    openQuestionFrom?: string | null;
  },
): Promise<{ threadId: string; headId: string; rootId: string; inReplyTo?: string }> {
  const now = Date.now();
  const threadId = ulid();
  const rootId = ulid();
  const isTask = o.rootKind === 'task';
  const round = o.round ?? 1;
  const maxRounds = o.maxRounds ?? 10;
  const lastSub = o.lastSub === undefined ? o.initiator : o.lastSub;
  const repo = o.repo !== undefined ? o.repo : isTask ? TEST_REPO : null;
  let headId = rootId;
  let inReplyTo: string | undefined;

  await t.run(async (ctx) => {
    await ctx.db.insert('threads', {
      thread_id: threadId,
      root_kind: o.rootKind,
      initiator: o.initiator,
      recipient: o.recipient,
      status: o.status,
      resume_state: o.resumeState ?? null,
      frozen_reason: o.frozenReason ?? null,
      frozen_by: o.frozenBy ?? null,
      closed_reason: o.closedReason ?? null,
      round,
      max_rounds: maxRounds,
      head_id: rootId,
      head_seq: 1,
      root_id: rootId,
      repo,
      pending_repo: null,
      last_substantive_sender: lastSub,
      consent_granted_at: o.consentGrantSeq != null ? now : null,
      consent_granted_via: o.consentGrantSeq != null ? 'cli_accept' : null,
      consent_grant_seq: o.consentGrantSeq ?? null,
      consent_token: o.consentToken ?? null,
      reconsent_trigger_seq: o.reconsentTriggerSeq ?? null,
      referenced_repo_shas: o.referencedRepoShas ?? [],
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert('messages', {
      id: rootId,
      client_id: ulid(),
      thread_id: threadId,
      parent_id: null,
      in_reply_to: null,
      from: o.initiator,
      to: o.recipient,
      kind: o.rootKind,
      repo,
      body: 'root',
      artifacts: [],
      seq: 1,
      ts: now,
      round: 1,
      status: o.status,
      consent_token: o.consentToken ?? null,
      unfroze: false,
      recipient: o.recipient,
      delivery_state: 'acked',
      claim: null,
      prior_attempts: 0,
      inbox_seq: 1,
      acked_attempt_id: null,
      answered: false,
    });
  });

  if (o.openQuestionFrom) {
    const qId = ulid();
    const qFrom = o.openQuestionFrom;
    const qTo = qFrom === o.initiator ? o.recipient : o.initiator;
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', {
        id: qId,
        client_id: ulid(),
        thread_id: threadId,
        parent_id: rootId,
        in_reply_to: null,
        from: qFrom,
        to: qTo,
        kind: 'question',
        repo: null,
        body: 'q?',
        artifacts: [],
        seq: 2,
        ts: now,
        round: 1,
        status: o.status,
        consent_token: null,
        unfroze: false,
        recipient: qTo,
        delivery_state: 'acked',
        claim: null,
        prior_attempts: 0,
        inbox_seq: 2,
        acked_attempt_id: null,
        answered: false,
      });
      const th = await ctx.db
        .query('threads')
        .withIndex('by_thread_id', (q: any) => q.eq('thread_id', threadId))
        .unique();
      await ctx.db.patch(th._id, { head_id: qId, head_seq: 2 });
    });
    headId = qId;
    inReplyTo = qId;
  }

  return { threadId, headId, rootId, inReplyTo };
}

/** Build a `send` request wrapper. Adds the consent block when kind === 'accepted'. */
export function sendReq(
  token: string,
  envelope: Record<string, unknown>,
  extra: { consent?: { token: string; granted_via: string }; unfreeze?: boolean } = {},
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    protocol: PROTO,
    auth: { token },
    envelope,
  };
  if (extra.consent) req.consent = extra.consent;
  if (extra.unfreeze !== undefined) req.unfreeze = extra.unfreeze;
  return req;
}
