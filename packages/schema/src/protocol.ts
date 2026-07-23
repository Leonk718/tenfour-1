/// <reference lib="dom" />
/**
 * tenfour/1 — executable wire schemas.
 *
 * THE single source of truth for every shape in docs/spec/WIRE.md.
 * If WIRE.md prose and this file disagree, this file wins and WIRE.md has a bug.
 *
 * Zod v4. All caps/regexes/enums are exported so broker, adapter, CLI, and the
 * conformance fixture suite import from here and can never drift.
 */

import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────────
 * Protocol constants
 * ──────────────────────────────────────────────────────────────────────────── */

export const PROTOCOL_VERSION = 'tenfour/1' as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;

export const METHODS = [
  'send',
  'inbox',
  'ack',
  'thread',
  'diag.ping',
  'admin.issueInvite',
  'invite.redeem',
] as const;
export type Method = (typeof METHODS)[number];

/** WIRE.md §5.4 / §8 — every numeric cap in the protocol (DECIDED in WIRE.md). */
export const LIMITS = {
  BODY_MAX_BYTES: 16_384, // 16 KB UTF-8, post-NFC (D13)
  ENVELOPE_MAX_BYTES: 32_768, // 32 KB whole serialized envelope (D13)
  ARTIFACTS_MAX: 8, // (D13)
  ARTIFACTS_MAX_BYTES: 8_192, // serialized artifacts array, UTF-8, post-NFC (D13; ARTIFACTS ART-052)
  REPO_MAX_CHARS: 300, // three-segment host/owner/name (ARTIFACTS §2.1)
  REF_MAX_CHARS: 255,
  URL_MAX_CHARS: 512,
  PR_NUMBER_MAX: 999_999_999,
  INBOX_LIMIT_MIN: 1,
  INBOX_LIMIT_MAX: 100,
  INBOX_LIMIT_DEFAULT: 50,
  THREAD_LIMIT_MIN: 1,
  THREAD_LIMIT_MAX: 200,
  THREAD_LIMIT_DEFAULT: 200,
  NONCE_MAX_CHARS: 64,
  MARK_MAX_CHARS: 64,
  HOLDER_MAX_CHARS: 128,
  CURSOR_MAX_CHARS: 256,
  MAX_ROUNDS_DEFAULT: 10, // founder decision, July 2026
  MAX_ROUNDS_MIN: 1,
  MAX_ROUNDS_MAX: 12,
  INVITE_TTL_DEFAULT_S: 86_400,
  INVITE_TTL_MIN_S: 300,
  INVITE_TTL_MAX_S: 604_800,
  INVITE_CODE_MAX_CHARS: 1024,
  INVITE_REDEEM_MAX_FAILURES: 5, // then lockout (D30)
  BROKER_URL_MAX_CHARS: 300,
  NOTE_MAX_CHARS: 256,
  REPO_ALLOWLIST_MAX: 64,
  HOSTNAME_MAX_CHARS: 253,
  ADAPTER_VERSION_MAX_CHARS: 32,
  ERROR_MESSAGE_MAX_CHARS: 4_000,
  HUMAN_ACTION_MAX_CHARS: 1_000,
  CLAIM_LEASE_MS: 300_000, // 5 min inbox claim lease (D23; DELIVERY DEL-04)
  PRESENCE_TTL_MS: 86_400_000, // diag.ping mark beacon TTL (D26)
} as const;

/** WIRE.md §10 — rate ceilings, per token, rolling windows (D32). */
export const RATE_LIMITS = {
  send: [
    { limit: 12, window_s: 60 },
    { limit: 120, window_s: 3600 },
  ],
  ack: [{ limit: 120, window_s: 60 }],
  inbox: [{ limit: 60, window_s: 60 }],
  thread: [{ limit: 60, window_s: 60 }],
  'diag.ping': [{ limit: 30, window_s: 60 }],
  'admin.issueInvite': [{ limit: 10, window_s: 3600 }],
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Error registry — canonical, closed set of 20 (WIRE.md §9.3)
 * ──────────────────────────────────────────────────────────────────────────── */

export const ERROR_CODES = [
  'TENFOUR/STALE_HEAD',
  'TENFOUR/TERMINAL_THREAD',
  'TENFOUR/THREAD_FROZEN',
  'TENFOUR/ROUND_CAP',
  'TENFOUR/RATE_LIMITED',
  'TENFOUR/BODY_TOO_LARGE',
  'TENFOUR/SECRET_DETECTED',
  'TENFOUR/THREAD_NOT_FOUND',
  'TENFOUR/AUTH_FAILED',
  'TENFOUR/AUTH_REVOKED',
  'TENFOUR/CLIENT_ID_CONFLICT',
  'TENFOUR/PAIR_FORBIDDEN',
  'TENFOUR/REPO_NOT_ALLOWED',
  'TENFOUR/UNSUPPORTED_VERSION',
  'TENFOUR/UNKNOWN_KIND',
  'TENFOUR/CONSENT_REQUIRED',
  'TENFOUR/ARTIFACT_INVALID',
  'TENFOUR/NOT_THREAD_PARTY',
  'TENFOUR/INVITE_INVALID',
  'TENFOUR/INVITE_EXPIRED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Const-enum-style lookup (a literal `const enum` breaks under isolatedModules /
 * verbatimModuleSyntax, so the idiomatic as-const object is used instead).
 */
export const ErrorCode = {
  STALE_HEAD: 'TENFOUR/STALE_HEAD',
  TERMINAL_THREAD: 'TENFOUR/TERMINAL_THREAD',
  THREAD_FROZEN: 'TENFOUR/THREAD_FROZEN',
  ROUND_CAP: 'TENFOUR/ROUND_CAP',
  RATE_LIMITED: 'TENFOUR/RATE_LIMITED',
  BODY_TOO_LARGE: 'TENFOUR/BODY_TOO_LARGE',
  SECRET_DETECTED: 'TENFOUR/SECRET_DETECTED',
  THREAD_NOT_FOUND: 'TENFOUR/THREAD_NOT_FOUND',
  AUTH_FAILED: 'TENFOUR/AUTH_FAILED',
  AUTH_REVOKED: 'TENFOUR/AUTH_REVOKED',
  CLIENT_ID_CONFLICT: 'TENFOUR/CLIENT_ID_CONFLICT',
  PAIR_FORBIDDEN: 'TENFOUR/PAIR_FORBIDDEN',
  REPO_NOT_ALLOWED: 'TENFOUR/REPO_NOT_ALLOWED',
  UNSUPPORTED_VERSION: 'TENFOUR/UNSUPPORTED_VERSION',
  UNKNOWN_KIND: 'TENFOUR/UNKNOWN_KIND',
  CONSENT_REQUIRED: 'TENFOUR/CONSENT_REQUIRED',
  ARTIFACT_INVALID: 'TENFOUR/ARTIFACT_INVALID',
  NOT_THREAD_PARTY: 'TENFOUR/NOT_THREAD_PARTY',
  INVITE_INVALID: 'TENFOUR/INVITE_INVALID',
  INVITE_EXPIRED: 'TENFOUR/INVITE_EXPIRED',
} as const satisfies Record<string, ErrorCode>;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/**
 * data.reason vocabularies (WIRE.md §9.2/§9.3) — exported so strings can't drift.
 * Single merged UNKNOWN_KIND enum shared by WIRE §9.2 and STATE-MACHINE §2.
 * Role mismatches are NOT UNKNOWN_KIND — they map to NOT_THREAD_PARTY
 * (reason: role_forbidden).
 */
export const UNKNOWN_KIND_REASONS = [
  'unrecognized_kind',
  'malformed_for_kind',
  'malformed_request',
  'illegal_in_state',
  'cannot_root_thread',
  'invalid_in_reply_to',
] as const;
export const NOT_THREAD_PARTY_REASONS = ['not_party', 'role_forbidden'] as const;
export const CONSENT_REQUIRED_REASONS = ['consent_not_granted', 'bad_token'] as const;
// INVITE_INVALID carries NO data.reason: redemption failures are byte-identical
// across causes (AUTH INV-6 — no oracle on which field was wrong).

/* ────────────────────────────────────────────────────────────────────────────
 * Common scalar types (WIRE.md §3)
 * ──────────────────────────────────────────────────────────────────────────── */

export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9-]{0,31}$/;
/**
 * Canonical repo identifier: three-segment `host/owner/name`, entirely lowercase
 * (ARTIFACTS.md §2.1 grammar — the sole owner of repo-id truth). Host is a DNS
 * name (A-label/punycode only) with optional `:port`. ≤ 300 chars total.
 */
export const REPO_SLUG_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?\/[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/;
export const SHA_REGEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
// eslint-disable-next-line no-control-regex
export const GIT_REF_REGEX =
  /^(?!-)(?!refs\/)(?!\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[^\s\u0000-\u001f\u007f~^:?*[\\]{1,255}$/;
export const BEARER_TOKEN_REGEX = /^tf1_[A-Za-z0-9_-]{43}$/; // 256-bit (D3)
export const ADMIN_KEY_REGEX = /^tfadmin_[A-Za-z0-9_-]{43}$/; // 256-bit (D3)
export const INVITE_CODE_REGEX = /^TENFOUR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6}$/; // (D29)
export const CONSENT_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/; // 128-bit base64url (D16)

/** Reserved agent-name namespace (D4). */
export const RESERVED_AGENT_PREFIX = 'tenfour/';
export const SYSTEM_AGENT = 'tenfour/system' as const;
/** `to` sentinel on system fan-out posts (D15). */
export const THREAD_SENTINEL = 'thread' as const;

export const UlidSchema = z.string().regex(ULID_REGEX, 'ULID: 26-char Crockford base32');
export const AgentNameSchema = z.string().regex(AGENT_NAME_REGEX, 'AgentName: user/agent');
export const RepoSlugSchema = z
  .string()
  .max(LIMITS.REPO_MAX_CHARS)
  .regex(REPO_SLUG_REGEX, 'RepoSlug: host/owner/name, lowercase (ARTIFACTS §2.1)')
  .superRefine((repo, ctx) => {
    const err = repoSemanticError(repo);
    if (err) ctx.addIssue({ code: 'custom', message: `RepoSlug ${err} (ARTIFACTS §2.1)` });
  });
export const ShaSchema = z.string().regex(SHA_REGEX, 'Sha: 40 or 64 lowercase hex');
export const GitRefSchema = z
  .string()
  .regex(GIT_REF_REGEX, 'GitRef: git check-ref-format grammar (ARTIFACTS ART-046)')
  .refine((s) => new TextEncoder().encode(s).byteLength <= LIMITS.REF_MAX_CHARS, {
    message: `GitRef exceeds ${LIMITS.REF_MAX_CHARS} UTF-8 bytes (ART-045)`,
  });
export const TimestampSchema = z.number().int().nonnegative(); // ms epoch, broker clock (D5)
export const CursorSchema = z.string().min(1).max(LIMITS.CURSOR_MAX_CHARS); // opaque
export const ConsentTokenSchema = z.string().regex(CONSENT_TOKEN_REGEX);

export type Ulid = z.infer<typeof UlidSchema>;
export type AgentName = z.infer<typeof AgentNameSchema>;
export type RepoSlug = z.infer<typeof RepoSlugSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────── */

export const KINDS = [
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
] as const;
export const KindSchema = z.enum(KINDS);
export type Kind = z.infer<typeof KindSchema>;

/** Kinds that count toward the round algorithm (WIRE.md §7.1). */
export const SUBSTANTIVE_KINDS = [
  'task',
  'question',
  'answer',
  'result',
  'change_request',
] as const satisfies readonly Kind[];

/** Kinds that may open a thread with thread_id:null (R3). */
export const THREAD_OPENING_KINDS = ['task', 'question'] as const satisfies readonly Kind[];

/** Kinds that may carry artifacts (WIRE.md §5.2). */
export const ARTIFACT_KINDS = ['task', 'result', 'change_request'] as const satisfies readonly Kind[];

/** Kinds whose body may be the empty string (D10). */
export const EMPTY_BODY_KINDS = ['accepted', 'cancel', 'done'] as const satisfies readonly Kind[];

export const THREAD_STATUSES = [
  'offered',
  'in_progress',
  'review',
  'closed',
  'frozen',
  'open', // question-rooted micro-threads only (D6)
] as const;
export const ThreadStatusSchema = z.enum(THREAD_STATUSES);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const DELIVERY_STATES = ['queued', 'claimed', 'injected', 'acked'] as const; // R7
export const DeliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

// R9. `not_required` = question micro-threads (no consent party, CONSENT §1).
// `revoked` is RESERVED for v1.1 — no v1 wire method or CLI command sets it (D20).
export const CONSENT_STATES = ['not_required', 'none', 'granted', 'stale', 'revoked'] as const;
export const ConsentStateSchema = z.enum(CONSENT_STATES);
export type ConsentState = z.infer<typeof ConsentStateSchema>;

// B1: consent-acceptance rides the CLI `tenfour accept` gesture and standing-rule
// config only. There is no MCP consent tool, so that grant path is removed.
export const GRANTED_VIA = ['cli_accept', 'standing_rule'] as const; // R8
export const GrantedViaSchema = z.enum(GRANTED_VIA);
export type GrantedVia = z.infer<typeof GrantedViaSchema>;

export const FROZEN_REASONS = ['round_cap', 'needs_human'] as const;
export const FrozenReasonSchema = z.enum(FROZEN_REASONS);
export type FrozenReason = z.infer<typeof FrozenReasonSchema>;

/** Terminal-close vocabulary (B7; STATE §1.2). status===closed ⇔ closed_reason set. */
export const CLOSED_REASONS = ['answered', 'declined', 'cancelled', 'done'] as const;
export const ClosedReasonSchema = z.enum(CLOSED_REASONS);
export type ClosedReason = z.infer<typeof ClosedReasonSchema>;

export const ROOT_KINDS = ['task', 'question'] as const;
export const RootKindSchema = z.enum(ROOT_KINDS);
export type RootKind = z.infer<typeof RootKindSchema>;

export const PLATFORMS = ['darwin', 'win32', 'linux', 'wsl'] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Artifacts (WIRE.md §5.3)
 * ──────────────────────────────────────────────────────────────────────────── */

export const GitCommitArtifactSchema = z.object({
  type: z.literal('git_commit'),
  repo: RepoSlugSchema,
  ref: GitRefSchema,
  sha: ShaSchema,
});

export const GitBranchArtifactSchema = z.object({
  type: z.literal('git_branch'),
  repo: RepoSlugSchema,
  ref: GitRefSchema,
  sha: ShaSchema,
});

export const PullRequestArtifactSchema = z.object({
  type: z.literal('pull_request'),
  repo: RepoSlugSchema,
  number: z.number().int().min(1).max(LIMITS.PR_NUMBER_MAX),
  url: z.string().max(LIMITS.URL_MAX_CHARS).regex(/^https:\/\//, 'pull_request.url must be https'),
});

export const ArtifactSchema = z.discriminatedUnion('type', [
  GitCommitArtifactSchema,
  GitBranchArtifactSchema,
  PullRequestArtifactSchema,
]);
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Sha-pinned artifact types satisfying the `result` requirement. */
export const SHA_PINNED_ARTIFACT_TYPES = ['git_commit', 'git_branch'] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Envelopes (WIRE.md §5)
 * ──────────────────────────────────────────────────────────────────────────── */

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

/** WIRE §5.4 / D14 / B4: the broker NORMALIZES body to NFC and never rejects it. */
export function normalizeBody(s: string): string {
  return s.normalize('NFC');
}

/**
 * Canonical JSON used for the SINGLE byte-cap measurement (B10): keys sorted at every
 * level, strings NFC-normalized, absent optionals (undefined) omitted, array (artifact)
 * order preserved as sent post-dedup. Zod has already stripped unknown fields by the
 * time this runs. No ad-hoc JSON.stringify sizing lives anywhere else.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? JSON.stringify(value.normalize('NFC')) : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const parts = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
  return `{${parts.join(',')}}`;
}

/** UTF-8 byte length of the canonical JSON of `value` (B10 — body, artifact, envelope caps). */
export function canonicalBytes(value: unknown): number {
  return utf8Bytes(canonicalJson(value));
}

/**
 * Extra repo-slug semantics beyond REPO_SLUG_REGEX (ARTIFACTS §2.1, B5): port range
 * 1..65535 (reject 00000, leading zeros, > 65535), host <= 253 chars, owner/name never
 * "." or "..", name never ending ".git". Assumes REPO_SLUG_REGEX already matched (so
 * exactly two "/" and lowercase ASCII). Returns a reason, or null when clean.
 */
function repoSemanticError(repo: string): string | null {
  const segs = repo.split('/');
  if (segs.length !== 3) return 'malformed';
  const [hostPort, owner, name] = segs;
  const colon = hostPort.indexOf(':');
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  if (host.length === 0 || host.length > LIMITS.HOSTNAME_MAX_CHARS) return 'host_length';
  if (colon !== -1) {
    const port = hostPort.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return 'port_invalid';
    const p = Number(port);
    if (p < 1 || p > 65535 || String(p) !== port) return 'port_invalid'; // rejects 00000, 080, > 65535
  }
  for (const seg of [owner, name]) {
    if (seg === '.' || seg === '..') return 'dot_segment';
  }
  if (name.endsWith('.git')) return 'dot_git_suffix';
  return null;
}

/** Host (incl. port) of a repo slug that already passed REPO_SLUG_REGEX. */
function repoHost(repo: string): string {
  return repo.split('/')[0];
}

/**
 * pull_request.url rules (ARTIFACTS §4.3, B5): absolute https, ASCII only, NO embedded
 * credentials, host (incl. port, case-insensitive) === the artifact's repo host.
 */
function urlError(url: string, repo: string): string | null {
  for (const ch of url) if (ch.charCodeAt(0) > 127) return 'url_not_ascii';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url_invalid';
  }
  if (parsed.protocol !== 'https:') return 'url_scheme';
  if (parsed.username !== '' || parsed.password !== '') return 'url_credentials';
  if (parsed.host.toLowerCase() !== repoHost(repo).toLowerCase()) return 'url_host_mismatch';
  return null;
}

/** The D15 system fan-out post (from tenfour/system, to "thread") — carve-out below. */
function isSystemFanout(env: { from?: string; to?: string }): boolean {
  return env.from === SYSTEM_AGENT && env.to === THREAD_SENTINEL;
}

interface RefinableEnvelope {
  kind: string;
  body: string;
  to: string;
  from?: string;
  in_reply_to?: string | null;
  repo?: string | null;
  artifacts?: readonly Artifact[];
}

/**
 * The ONE envelope refinement, run on BOTH ClientEnvelopeSchema and
 * StampedEnvelopeSchema (B6). StampedEnvelope is NOT "trusted, skip refinements": the
 * only relaxation is the D15 system-fanout carve-out (from tenfour/system, to "thread"),
 * which skips the party / round / artifact-kind rules a broker post legitimately does
 * not satisfy. Body is normalized (never rejected, B4); artifact string fields MUST be
 * NFC (rejected otherwise — ART-071 — because artifact bytes feed allowlist/dedup/hash
 * comparisons byte-for-byte).
 */
function sharedEnvelopeRefinement(env: RefinableEnvelope, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[] = []): void => {
    ctx.addIssue({ code: 'custom', message, path });
  };
  const artifacts = env.artifacts ?? [];
  const systemPost = isSystemFanout(env);

  // ── Size caps (B10 canonicalBytes — the sole measurement)
  if (utf8Bytes(normalizeBody(env.body)) > LIMITS.BODY_MAX_BYTES) {
    issue(`body exceeds ${LIMITS.BODY_MAX_BYTES} UTF-8 bytes (BODY_TOO_LARGE)`, ['body']);
  }
  if (canonicalBytes(env) > LIMITS.ENVELOPE_MAX_BYTES) {
    issue(`envelope exceeds ${LIMITS.ENVELOPE_MAX_BYTES} UTF-8 bytes (BODY_TOO_LARGE)`);
  }
  if (canonicalBytes(artifacts) > LIMITS.ARTIFACTS_MAX_BYTES) {
    issue(
      `serialized artifacts exceed ${LIMITS.ARTIFACTS_MAX_BYTES} UTF-8 bytes (ARTIFACT_INVALID, artifacts_too_large)`,
      ['artifacts'],
    );
  }

  // ── Per-artifact B5 rules: NFC enforcement, repo semantics, url, duplicates
  const seen = new Set<string>();
  artifacts.forEach((a, i) => {
    const strings: [string, string][] = [['repo', a.repo]];
    if (a.type === 'git_commit' || a.type === 'git_branch') strings.push(['ref', a.ref]);
    if (a.type === 'pull_request') strings.push(['url', a.url]);
    for (const [field, value] of strings) {
      if (value !== value.normalize('NFC')) {
        issue(`artifact[${i}].${field} is not NFC (ARTIFACT_INVALID, not_nfc)`, ['artifacts', i, field]);
      }
    }
    const rErr = repoSemanticError(a.repo);
    if (rErr) issue(`artifact[${i}].repo ${rErr} (ARTIFACT_INVALID)`, ['artifacts', i, 'repo']);
    if (a.type === 'pull_request') {
      const uErr = urlError(a.url, a.repo);
      if (uErr) issue(`artifact[${i}].url ${uErr} (ARTIFACT_INVALID)`, ['artifacts', i, 'url']);
    }
    const key =
      a.type === 'pull_request'
        ? `pr ${a.repo} ${a.number}`
        : `sha_ref ${a.repo} ${a.ref}`;
    if (seen.has(key)) {
      issue(`duplicate artifact at index ${i} (ARTIFACT_INVALID, duplicate_artifact)`, ['artifacts', i]);
    }
    seen.add(key);
  });

  // ── task.repo carries the same first-class repo semantics (B5)
  if (env.repo != null) {
    const rErr = repoSemanticError(env.repo);
    if (rErr) issue(`repo ${rErr} (ARTIFACT_INVALID)`, ['repo']);
  }

  // ── Kind-field presence (skipped for the D15 system fan-out post)
  if (!systemPost) {
    if (!(ARTIFACT_KINDS as readonly string[]).includes(env.kind) && artifacts.length > 0) {
      issue(`artifacts are only legal on kinds ${ARTIFACT_KINDS.join(', ')}`, ['artifacts']);
    }
    if (
      env.kind === 'result' &&
      !artifacts.some((a) => (SHA_PINNED_ARTIFACT_TYPES as readonly string[]).includes(a.type))
    ) {
      issue('result requires at least one sha-pinned artifact (git_commit or git_branch)', ['artifacts']);
    }
    if (env.kind === 'answer' && env.in_reply_to == null) {
      issue('answer requires in_reply_to = id of the question being answered', ['in_reply_to']);
    }
  }
}

/**
 * Client envelope: what the adapter submits inside `send`. The broker NORMALIZES `body`
 * to NFC (normalizeBody) in the validate pipeline before caps/hash/persist (B4) — non-NFC
 * body is corrected, never rejected. The shared refinement (B6) owns caps, artifact
 * rules, and kind-field presence; the client-only refinement owns thread-opening (R3),
 * repo (R10), and body-emptiness (D10) rules that apply to adapter input only.
 */
export const ClientEnvelopeSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    client_id: UlidSchema, // minted by the ADAPTER, never the model
    thread_id: UlidSchema.nullable().default(null),
    parent_id: UlidSchema.nullable().default(null), // head rule (§4.4)
    in_reply_to: UlidSchema.nullable().default(null), // R4 — distinct from parent_id
    to: AgentNameSchema,
    kind: KindSchema,
    repo: RepoSlugSchema.nullable().default(null), // R10
    body: z.string(),
    artifacts: z.array(ArtifactSchema).max(LIMITS.ARTIFACTS_MAX).default([]),
  })
  .superRefine((env, ctx) => sharedEnvelopeRefinement(env, ctx))
  .superRefine((env, ctx) => {
    const issue = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: 'custom', message, path });
    };

    // ── Thread-opening rules (R3)
    const opening = env.thread_id === null;
    if (opening && !(THREAD_OPENING_KINDS as readonly string[]).includes(env.kind)) {
      issue(`thread_id:null is legal only for kinds ${THREAD_OPENING_KINDS.join(', ')}`, ['thread_id']);
    }
    if (env.kind === 'task' && env.thread_id !== null) {
      issue('task always opens a thread: thread_id must be null', ['thread_id']);
    }
    if (opening && env.parent_id !== null) {
      issue('parent_id must be null when opening a thread', ['parent_id']);
    }
    if (!opening && env.parent_id === null) {
      issue('parent_id (current thread head) is required on all non-opening messages', ['parent_id']);
    }

    // ── in_reply_to forbidden outside answer (R4/D11; required-on-answer is shared)
    if (env.kind !== 'answer' && env.in_reply_to !== null) {
      issue('in_reply_to is only legal on kind=answer', ['in_reply_to']);
    }

    // ── repo rules (R10, D12)
    if (env.kind === 'task' && env.repo === null) {
      issue('task requires a first-class repo field', ['repo']);
    }
    if (env.kind !== 'task' && env.kind !== 'change_request' && env.repo !== null) {
      issue('repo is only legal on task (required) and change_request (optional)', ['repo']);
    }

    // ── body emptiness (D10)
    if (!(EMPTY_BODY_KINDS as readonly string[]).includes(env.kind) && env.body.length === 0) {
      issue(`body must be non-empty for kind=${env.kind}`, ['body']);
    }
  });

export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type ClientEnvelopeInput = z.input<typeof ClientEnvelopeSchema>;

/**
 * Canonical server-stamped envelope (WIRE.md §5.5). Broker-authored, but NOT exempt:
 * the shared envelope refinement (B6) runs here too. The only relaxation is the D15
 * system fan-out carve-out (from tenfour/system, to "thread"), handled inside the
 * refinement — the "StampedEnvelope is trusted, skip refinements" stance is gone.
 */
export const StampedEnvelopeSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    id: UlidSchema,
    client_id: UlidSchema,
    thread_id: UlidSchema,
    parent_id: UlidSchema.nullable(),
    in_reply_to: UlidSchema.nullable(),
    from: AgentNameSchema, // derived from token; 'tenfour/system' for broker posts
    to: z.union([AgentNameSchema, z.literal(THREAD_SENTINEL)]), // D15
    kind: KindSchema,
    repo: RepoSlugSchema.nullable(),
    body: z.string(),
    artifacts: z.array(ArtifactSchema).max(LIMITS.ARTIFACTS_MAX).default([]),
    seq: z.number().int().min(1), // per-thread ordering primitive
    ts: TimestampSchema, // display-only
    round: z.number().int().min(0),
    status: ThreadStatusSchema, // thread status AFTER this message
    delivery_state: DeliveryStateSchema, // current at response time (R7)
    consent_token: ConsentTokenSchema.nullable(), // task + scope-expanding change_request only (D16)
    unfroze: z.boolean(), // true iff this message resumed a frozen thread (B2; STATE §6.2)
  })
  .superRefine((env, ctx) => sharedEnvelopeRefinement(env, ctx));
export type StampedEnvelope = z.infer<typeof StampedEnvelopeSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Content hash (WIRE.md §6, R11) — client_id ↔ content binding
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Exactly these nine fields, nothing else, ever (D17). Excluded by design:
 * client_id (the key itself), auth, consent, unfreeze (authorization
 * metadata, not content).
 */
export const CONTENT_HASH_FIELDS = [
  'artifacts',
  'body',
  'in_reply_to',
  'kind',
  'parent_id',
  'protocol',
  'repo',
  'thread_id',
  'to',
] as const;

export type ContentHashInput = {
  protocol: typeof PROTOCOL_VERSION;
  to: string;
  kind: Kind;
  body: string;
  thread_id?: string | null;
  parent_id?: string | null;
  in_reply_to?: string | null;
  repo?: string | null;
  artifacts?: readonly Artifact[] | null;
};

/** Serialize each artifact with exactly its type's defined fields (D18). */
function canonicalArtifact(a: Artifact): Record<string, string | number> {
  return a.type === 'pull_request'
    ? { number: a.number, repo: a.repo, type: a.type, url: a.url }
    : { ref: a.ref, repo: a.repo, sha: a.sha, type: a.type };
}

/** Minimal JSON, keys sorted (ASCII) at every level, arrays in sender order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * The canonical content string (WIRE.md §6 step 1–2): fixed nine-field object,
 * absent optionals → null, body NFC-normalized, RFC 8785-conformant
 * serialization for this field set (strings/ints/nulls/arrays/objects only).
 */
export function canonicalContentString(input: ContentHashInput): string {
  const canonical = {
    artifacts: (input.artifacts ?? []).map(canonicalArtifact),
    body: input.body.normalize('NFC'),
    in_reply_to: input.in_reply_to ?? null,
    kind: input.kind,
    parent_id: input.parent_id ?? null,
    protocol: input.protocol,
    repo: input.repo ?? null,
    thread_id: input.thread_id ?? null,
    to: input.to,
  };
  return stableStringify(canonical);
}

/** `"sha256:" + lowercase hex of SHA-256 over UTF-8 canonical string` (D18). */
export async function contentHash(input: ContentHashInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalContentString(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/**
 * Normative test vector (WIRE.md §6) — asserted by CI on every platform.
 * Repo is the canonical three-segment host/owner/name form (ARTIFACTS §2.1);
 * ref is a SHORT ref name, never refs/-prefixed (ARTIFACTS ART-046).
 */
export const CONTENT_HASH_TEST_VECTOR = {
  input: {
    protocol: PROTOCOL_VERSION,
    to: 'jonathan/web',
    kind: 'task',
    thread_id: null,
    parent_id: null,
    in_reply_to: null,
    repo: 'github.com/careswift/web',
    body: 'Implement the CareSwift route header per the spec.',
    artifacts: [
      {
        type: 'git_commit',
        repo: 'github.com/careswift/web',
        ref: 'main',
        sha: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
      },
    ],
  } satisfies ContentHashInput,
  canonical:
    '{"artifacts":[{"ref":"main","repo":"github.com/careswift/web","sha":"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3","type":"git_commit"}],"body":"Implement the CareSwift route header per the spec.","in_reply_to":null,"kind":"task","parent_id":null,"protocol":"tenfour/1","repo":"github.com/careswift/web","thread_id":null,"to":"jonathan/web"}',
  hash: 'sha256:dc9473842e268f7482bb462e08ff2a1cf31ae403fec270b263cf3db65958d718',
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Errors (WIRE.md §9.1)
 * ──────────────────────────────────────────────────────────────────────────── */

export const ErrorObjectSchema = z.object({
  code: ErrorCodeSchema, // always "TENFOUR/<CODE>"
  message: z.string().min(1).max(LIMITS.ERROR_MESSAGE_MAX_CHARS), // what happened + what is true now
  human_action: z.string().min(1).max(LIMITS.HUMAN_ACTION_MAX_CHARS), // the ONE action instead
  retryable: z.literal(false), // literal false on EVERY protocol error
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorObject = z.infer<typeof ErrorObjectSchema>;

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: ErrorObjectSchema,
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Shared request/response fragments
 * ──────────────────────────────────────────────────────────────────────────── */

export const AuthSchema = z.object({
  token: z.string().regex(BEARER_TOKEN_REGEX, 'agent bearer token (tf1_…)'),
});
export type Auth = z.infer<typeof AuthSchema>;

export const ConsentRecordSchema = z.object({
  state: ConsentStateSchema,
  granted_at: TimestampSchema.nullable(),
  granted_via: GrantedViaSchema.nullable(),
  scope: z.literal('whole_thread'), // R9
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/** Thread summary in send responses (WIRE.md §7.1). */
export const ThreadSummarySchema = z.object({
  thread_id: UlidSchema,
  root_kind: RootKindSchema,
  status: ThreadStatusSchema,
  round: z.number().int().min(0),
  max_rounds: z.number().int().min(LIMITS.MAX_ROUNDS_MIN).max(LIMITS.MAX_ROUNDS_MAX),
  head_id: UlidSchema,
  head_seq: z.number().int().min(1),
  repo: RepoSlugSchema.nullable(),
  consent_state: ConsentStateSchema,
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** Compact thread info attached to inbox items (WIRE.md §7.2). */
export const InboxThreadInfoSchema = z.object({
  thread_id: UlidSchema,
  root_kind: RootKindSchema,
  status: ThreadStatusSchema,
  round: z.number().int().min(0),
  max_rounds: z.number().int().min(LIMITS.MAX_ROUNDS_MIN).max(LIMITS.MAX_ROUNDS_MAX),
  repo: RepoSlugSchema.nullable(),
});
export type InboxThreadInfo = z.infer<typeof InboxThreadInfoSchema>;

/** Resume states a frozen thread may carry (B8; STATE §1.2). */
export const RESUME_STATES = ['offered', 'in_progress', 'review', 'open'] as const;

/** Full thread object (WIRE.md §7.4). */
export const ThreadSchema = z
  .object({
    thread_id: UlidSchema,
    root_kind: RootKindSchema,
    initiator: AgentNameSchema,
    recipient: AgentNameSchema,
    status: ThreadStatusSchema,
    resume_state: ThreadStatusSchema.nullable(), // set while frozen (B8)
    frozen_reason: FrozenReasonSchema.nullable(),
    frozen_by: AgentNameSchema.nullable(), // agent or tenfour/system; null unless frozen
    closed_reason: ClosedReasonSchema.nullable(), // set iff status===closed (B7)
    round: z.number().int().min(0),
    max_rounds: z.number().int().min(LIMITS.MAX_ROUNDS_MIN).max(LIMITS.MAX_ROUNDS_MAX),
    head_id: UlidSchema,
    head_seq: z.number().int().min(1),
    repo: RepoSlugSchema.nullable(),
    consent: ConsentRecordSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .superRefine((t, ctx) => {
    const issue = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: 'custom', message, path });
    };

    // B8 — resume_state vocabulary
    if (t.resume_state !== null && !(RESUME_STATES as readonly string[]).includes(t.resume_state)) {
      issue(`resume_state must be one of ${RESUME_STATES.join(', ')}`, ['resume_state']);
    }

    // B8 — status===frozen ⇔ resume_state & frozen_reason & frozen_by all present, else all null
    const frozenTriplePresent =
      t.resume_state !== null && t.frozen_reason !== null && t.frozen_by !== null;
    if (t.status === 'frozen') {
      if (!frozenTriplePresent) {
        issue('frozen threads MUST carry resume_state, frozen_reason, and frozen_by', ['status']);
      }
    } else if (t.resume_state !== null || t.frozen_reason !== null || t.frozen_by !== null) {
      issue('resume_state/frozen_reason/frozen_by MUST all be null unless status===frozen', ['status']);
    }

    // B7 — status===closed ⇔ closed_reason present
    if (t.status === 'closed') {
      if (t.closed_reason === null) issue('closed threads MUST carry closed_reason', ['closed_reason']);
    } else if (t.closed_reason !== null) {
      issue('closed_reason is set only on closed threads', ['closed_reason']);
    }

    // B8 — task threads never "open"; question micro-threads only open|frozen|closed
    if (t.root_kind === 'task' && t.status === 'open') {
      issue('task threads never use status "open"', ['status']);
    }
    if (
      t.root_kind === 'question' &&
      !(['open', 'frozen', 'closed'] as readonly string[]).includes(t.status)
    ) {
      issue('question micro-threads use only open, frozen, or closed', ['status']);
    }
  });
export type Thread = z.infer<typeof ThreadSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: send (WIRE.md §7.1)
 * ──────────────────────────────────────────────────────────────────────────── */

export const SendRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    auth: AuthSchema,
    envelope: ClientEnvelopeSchema,
    /** REQUIRED iff envelope.kind === 'accepted' (R8). */
    consent: z
      .object({
        token: ConsentTokenSchema,
        granted_via: GrantedViaSchema,
      })
      .optional(),
    /**
     * Send-borne unfreeze (B2; STATE §6.2; WIRE §7.1.3): on a frozen thread the ONLY
     * legal send has unfreeze:true. The broker atomically restores the thread to
     * resume_state, resets rounds_used to 0 and last_substantive_sender to null, applies
     * this message if it is legal in resume_state (else rejects WITHOUT consuming the
     * unfreeze), and stamps the result unfroze:true. `tenfour approve <thread>` sets it;
     * either party may. No consent record, no endpoint, no MCP tool — unfreeze rides send.
     * A normal send (unfreeze:false) into a frozen thread returns TENFOUR/THREAD_FROZEN.
     */
    unfreeze: z.boolean().optional().default(false),
  })
  .superRefine((req, ctx) => {
    if (req.envelope.kind === 'accepted' && req.consent === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'kind=accepted requires consent {token, granted_via} — the R8 structured gesture',
        path: ['consent'],
      });
    }
    if (req.envelope.kind !== 'accepted' && req.consent !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'consent is only legal on kind=accepted',
        path: ['consent'],
      });
    }
  });
export type SendRequest = z.infer<typeof SendRequestSchema>;
export type SendRequestInput = z.input<typeof SendRequestSchema>;

export const SendSuccessSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(), // true ⇒ R7 replay of the canonical original
  note: z.string().nullable(), // duplicates: strings.ts SEND_DUPLICATE_NOTE (sole source of bytes)
  message: StampedEnvelopeSchema,
  thread: ThreadSummarySchema,
});
export type SendSuccess = z.infer<typeof SendSuccessSchema>;

export const SendResponseSchema = z.discriminatedUnion('ok', [SendSuccessSchema, ErrorResponseSchema]);
export type SendResponse = z.infer<typeof SendResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Ordered send validation (B9) — raw parse is SEPARATE from ordered validation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Permissive raw parse of a `send` request. `kind` is a LOOSE string, so an unknown
 * kind does NOT fail here — it is caught as TENFOUR/UNKNOWN_KIND by validateSend, never
 * as a Zod enum error. Reads protocol/token/to/client_id/thread_id/parent_id/
 * in_reply_to/body/artifacts/unfreeze without enforcing their shapes.
 */
export const RawSendRequestSchema = z.object({
  protocol: z.unknown().optional(),
  auth: z.object({ token: z.unknown().optional() }).optional(),
  envelope: z.object({
    protocol: z.unknown().optional(),
    client_id: z.unknown().optional(),
    thread_id: z.unknown().optional(),
    parent_id: z.unknown().optional(),
    in_reply_to: z.unknown().optional(),
    to: z.unknown().optional(),
    kind: z.string(), // loose: any string; unknown kinds do NOT fail here (B9)
    repo: z.unknown().optional(),
    body: z.unknown().optional(),
    artifacts: z.unknown().optional(),
  }),
  consent: z.unknown().optional(),
  unfreeze: z.unknown().optional(),
});
export type RawSendRequest = z.infer<typeof RawSendRequestSchema>;

export type ValidateSendResult =
  | { ok: true; value: SendRequest }
  | { ok: false; code: ErrorCode; reason?: string; human_action: string };

const VALIDATE_SEND_HUMAN_ACTION: Partial<Record<ErrorCode, string>> = {
  'TENFOUR/UNSUPPORTED_VERSION': 'Tell your human to update the tenfour package on this machine.',
  'TENFOUR/AUTH_FAILED': "Tell your human to run 'tenfour doctor' — this is a setup problem.",
  'TENFOUR/PAIR_FORBIDDEN': 'Tell your human — pairing is a human act; you cannot add peers.',
  'TENFOUR/UNKNOWN_KIND': 'Choose the kind that matches your intent; if none fits, tell your human.',
  'TENFOUR/BODY_TOO_LARGE':
    'Put the detail in a pushed commit or PR and send a short body carrying the artifact reference.',
  'TENFOUR/ARTIFACT_INVALID': 'Fix the named artifact field. For an unpushed sha: push first, then send.',
};

/**
 * B9: `safeParse` is NOT the send validator. The wire contract is an ORDERED 13-step
 * precedence (WIRE §7.1 D19 / STATE §3 / AUTH §3.4) whose FIRST failing step wins with
 * exactly one typed error. validateSend runs the request-decidable prefix of that order
 * over a permissive RawSendRequestSchema parse:
 *
 *   1 version → 2 auth → 3 pair → [4 dedup, 5 rate: broker state] →
 *   6 schema/caps+normalization → [7 secret, 8 thread/party, 9 state machine, 10 head,
 *   11 consent, 12 repo allowlist, 13 round: broker state] → commit.
 *
 * An unrecognized kind is TENFOUR/UNKNOWN_KIND (unrecognized_kind) here. The bracketed
 * steps require broker state and run inside the broker mutation once this returns ok.
 */
export function validateSend(raw: unknown): ValidateSendResult {
  const fail = (code: ErrorCode, reason?: string): ValidateSendResult => ({
    ok: false,
    code,
    reason,
    human_action: VALIDATE_SEND_HUMAN_ACTION[code] ?? 'Tell your human.',
  });

  const parsed = RawSendRequestSchema.safeParse(raw);
  if (!parsed.success) return fail(ErrorCode.UNKNOWN_KIND, 'malformed_request');
  const r = parsed.data;

  // 1 — version (request + envelope must match a supported version)
  if (r.protocol !== PROTOCOL_VERSION || r.envelope.protocol !== PROTOCOL_VERSION) {
    return fail(ErrorCode.UNSUPPORTED_VERSION);
  }
  // 2 — auth token shape
  const token = r.auth?.token;
  if (typeof token !== 'string' || !BEARER_TOKEN_REGEX.test(token)) {
    return fail(ErrorCode.AUTH_FAILED);
  }
  // 3 — pair: `to` is an agent name and not the reserved tenfour/* namespace
  const to = r.envelope.to;
  if (typeof to !== 'string' || !AGENT_NAME_REGEX.test(to) || to.startsWith(RESERVED_AGENT_PREFIX)) {
    return fail(ErrorCode.PAIR_FORBIDDEN);
  }
  // 6a — kind recognized (UNKNOWN_KIND, never a Zod enum error)
  if (!(KINDS as readonly string[]).includes(r.envelope.kind)) {
    return fail(ErrorCode.UNKNOWN_KIND, 'unrecognized_kind');
  }
  // 6b — full request/envelope schema, caps, artifact rules; body normalized first (B4)
  const normalized = {
    ...r,
    envelope: {
      ...r.envelope,
      body: typeof r.envelope.body === 'string' ? normalizeBody(r.envelope.body) : r.envelope.body,
    },
  };
  const full = SendRequestSchema.safeParse(normalized);
  if (!full.success) {
    const msg = full.error.issues[0]?.message ?? '';
    if (/exceeds .* UTF-8 bytes|BODY_TOO_LARGE/.test(msg) && !/artifacts? /.test(msg)) {
      return fail(ErrorCode.BODY_TOO_LARGE);
    }
    if (/artifact|ARTIFACT|url|repo|RepoSlug|GitRef|Sha|not_nfc|duplicate/i.test(msg)) {
      return fail(ErrorCode.ARTIFACT_INVALID);
    }
    return fail(ErrorCode.UNKNOWN_KIND, 'malformed_for_kind');
  }
  return { ok: true, value: full.data };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Method: inbox (WIRE.md §7.2)
 * ──────────────────────────────────────────────────────────────────────────── */

export const InboxRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    auth: AuthSchema,
    // Any string accepted (D22/§5.4): an expired, malformed, or over-long cursor
    // is NOT an error — the broker treats it as null and restarts the sweep.
    cursor: z.string().nullable().default(null), // null ⇒ fresh sweep (D22)
    limit: z
      .number()
      .int()
      .min(LIMITS.INBOX_LIMIT_MIN)
      .max(LIMITS.INBOX_LIMIT_MAX)
      .default(LIMITS.INBOX_LIMIT_DEFAULT),
    mode: z.enum(['claim', 'peek']).default('claim'), // D23
    holder: z.string().min(1).max(LIMITS.HOLDER_MAX_CHARS).optional(),
  })
  .superRefine((req, ctx) => {
    if (req.mode === 'claim' && req.holder === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'mode=claim requires holder (the claiming client instance)',
        path: ['holder'],
      });
    }
  });
export type InboxRequest = z.infer<typeof InboxRequestSchema>;
export type InboxRequestInput = z.input<typeof InboxRequestSchema>;

export const InboxItemSchema = z.object({
  message: StampedEnvelopeSchema,
  attempt_id: UlidSchema.nullable(), // null in peek mode
  delivery_state: DeliveryStateSchema,
  prior_attempts: z.number().int().min(0), // >0 ⇒ journal shows redelivery preamble
  thread: InboxThreadInfoSchema,
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxSuccessSchema = z.object({
  ok: z.literal(true),
  items: z.array(InboxItemSchema),
  cursor: CursorSchema, // single-sweep pagination token, NOT a durable position (D22)
  has_more: z.boolean(),
  server_time: TimestampSchema,
});
export type InboxSuccess = z.infer<typeof InboxSuccessSchema>;

export const InboxResponseSchema = z.discriminatedUnion('ok', [InboxSuccessSchema, ErrorResponseSchema]);
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: ack (WIRE.md §7.3) — ack means MODEL-RECEIVED (R2)
 * ──────────────────────────────────────────────────────────────────────────── */

export const AckRequestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  auth: AuthSchema,
  message_id: UlidSchema,
  /** REQUIRED — claim-before-ack is the rule (D23/§9.4); there is no ack without a claim. */
  attempt_id: UlidSchema,
  /** Two-phase ack (D24): 'injected' = entered model context (non-final). */
  state: z.enum(['injected', 'acked']).default('acked'),
});
export type AckRequest = z.infer<typeof AckRequestSchema>;
export type AckRequestInput = z.input<typeof AckRequestSchema>;

export const AckSuccessSchema = z.object({
  ok: z.literal(true),
  message_id: UlidSchema,
  delivery_state: DeliveryStateSchema,
  duplicate: z.boolean(),
  note: z.string(), // strings.ts ACK_OK_NOTE | ACK_DUPLICATE_NOTE — never a nag
});
export type AckSuccess = z.infer<typeof AckSuccessSchema>;

export const AckResponseSchema = z.discriminatedUnion('ok', [AckSuccessSchema, ErrorResponseSchema]);
export type AckResponse = z.infer<typeof AckResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: thread (WIRE.md §7.4)
 * ──────────────────────────────────────────────────────────────────────────── */

export const ThreadRequestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  auth: AuthSchema,
  thread_id: UlidSchema,
  after_seq: z.number().int().min(0).default(0),
  limit: z
    .number()
    .int()
    .min(LIMITS.THREAD_LIMIT_MIN)
    .max(LIMITS.THREAD_LIMIT_MAX)
    .default(LIMITS.THREAD_LIMIT_DEFAULT),
});
export type ThreadRequest = z.infer<typeof ThreadRequestSchema>;
export type ThreadRequestInput = z.input<typeof ThreadRequestSchema>;

export const ThreadSuccessSchema = z.object({
  ok: z.literal(true),
  thread: ThreadSchema,
  messages: z.array(StampedEnvelopeSchema), // seq ascending, seq > after_seq
  has_more: z.boolean(),
});
export type ThreadSuccess = z.infer<typeof ThreadSuccessSchema>;

export const ThreadResponseSchema = z.discriminatedUnion('ok', [ThreadSuccessSchema, ErrorResponseSchema]);
export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: diag.ping (WIRE.md §8.1, R6) — NOT a thread; carries `hello`
 * ──────────────────────────────────────────────────────────────────────────── */

export const DiagPingRequestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  auth: AuthSchema,
  nonce: z.string().max(LIMITS.NONCE_MAX_CHARS).optional(), // echoed verbatim
  mark: z.string().max(LIMITS.MARK_MAX_CHARS).optional(), // presence beacon, 24h TTL (D26)
});
export type DiagPingRequest = z.infer<typeof DiagPingRequestSchema>;

export const DiagPingSuccessSchema = z.object({
  ok: z.literal(true),
  pong: z.literal(true),
  nonce: z.string().max(LIMITS.NONCE_MAX_CHARS).nullable(),
  agent: AgentNameSchema,
  server_time: TimestampSchema,
  protocol_versions: z.array(z.literal(PROTOCOL_VERSION)).min(1), // constrained to SUPPORTED_PROTOCOL_VERSIONS
  broker_version: z.string().max(32),
  peer: z
    .object({
      agent: AgentNameSchema,
      last_ping_ts: TimestampSchema,
      last_mark: z.string().max(LIMITS.MARK_MAX_CHARS).nullable(),
    })
    .nullable(),
});
export type DiagPingSuccess = z.infer<typeof DiagPingSuccessSchema>;

export const DiagPingResponseSchema = z.discriminatedUnion('ok', [
  DiagPingSuccessSchema,
  ErrorResponseSchema,
]);
export type DiagPingResponse = z.infer<typeof DiagPingResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: admin.issueInvite (WIRE.md §8.2)
 * ──────────────────────────────────────────────────────────────────────────── */

export const AdminIssueInviteRequestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  admin_key: z.string().regex(ADMIN_KEY_REGEX, 'admin key (tfadmin_…)'),
  agent: AgentNameSchema,
  ttl_s: z
    .number()
    .int()
    .min(LIMITS.INVITE_TTL_MIN_S)
    .max(LIMITS.INVITE_TTL_MAX_S)
    .default(LIMITS.INVITE_TTL_DEFAULT_S),
  max_rounds: z
    .number()
    .int()
    .min(LIMITS.MAX_ROUNDS_MIN)
    .max(LIMITS.MAX_ROUNDS_MAX)
    .default(LIMITS.MAX_ROUNDS_DEFAULT), // founder decision: default 10, clamp 1..12
  repo_allowlist: z.array(RepoSlugSchema).max(LIMITS.REPO_ALLOWLIST_MAX).optional(), // absent ⇒ any repo (doctor warns)
  note: z.string().max(LIMITS.NOTE_MAX_CHARS).optional(),
});
export type AdminIssueInviteRequest = z.infer<typeof AdminIssueInviteRequestSchema>;
export type AdminIssueInviteRequestInput = z.input<typeof AdminIssueInviteRequestSchema>;

export const AdminIssueInviteSuccessSchema = z.object({
  ok: z.literal(true),
  invite: z.object({
    invite_id: UlidSchema,
    code: z.string().max(LIMITS.INVITE_CODE_MAX_CHARS).regex(INVITE_CODE_REGEX),
    agent: AgentNameSchema,
    expires_at: TimestampSchema,
    max_rounds: z.number().int().min(LIMITS.MAX_ROUNDS_MIN).max(LIMITS.MAX_ROUNDS_MAX),
    repo_allowlist: z.array(RepoSlugSchema).nullable(),
  }),
});
export type AdminIssueInviteSuccess = z.infer<typeof AdminIssueInviteSuccessSchema>;

export const AdminIssueInviteResponseSchema = z.discriminatedUnion('ok', [
  AdminIssueInviteSuccessSchema,
  ErrorResponseSchema,
]);
export type AdminIssueInviteResponse = z.infer<typeof AdminIssueInviteResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method: invite.redeem (WIRE.md §8.4) — the code IS the credential
 * ──────────────────────────────────────────────────────────────────────────── */

export const InviteRedeemRequestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  code: z.string().max(LIMITS.INVITE_CODE_MAX_CHARS).regex(INVITE_CODE_REGEX),
  client_info: z.object({
    platform: PlatformSchema,
    hostname: z.string().max(LIMITS.HOSTNAME_MAX_CHARS).optional(),
    adapter_version: z.string().max(LIMITS.ADAPTER_VERSION_MAX_CHARS),
  }),
});
export type InviteRedeemRequest = z.infer<typeof InviteRedeemRequestSchema>;

export const InviteRedeemSuccessSchema = z.object({
  ok: z.literal(true),
  agent: AgentNameSchema,
  token: z.string().regex(BEARER_TOKEN_REGEX), // shown once; stored 0600/icacls
  token_id: UlidSchema,
  pair: z.object({
    peer: AgentNameSchema,
    max_rounds: z.number().int().min(LIMITS.MAX_ROUNDS_MIN).max(LIMITS.MAX_ROUNDS_MAX),
  }),
  broker: z.object({
    protocol_versions: z.array(z.literal(PROTOCOL_VERSION)).min(1), // constrained to SUPPORTED_PROTOCOL_VERSIONS
    server_time: TimestampSchema,
  }),
  covenant: z.string(), // the "you say go" line, from strings.ts
});
export type InviteRedeemSuccess = z.infer<typeof InviteRedeemSuccessSchema>;

export const InviteRedeemResponseSchema = z.discriminatedUnion('ok', [
  InviteRedeemSuccessSchema,
  ErrorResponseSchema,
]);
export type InviteRedeemResponse = z.infer<typeof InviteRedeemResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Invite code payload (WIRE.md §8.3, D29) — inside TENFOUR1.<payload>.<check>
 * ──────────────────────────────────────────────────────────────────────────── */

export const InviteCodePayloadSchema = z.object({
  agent: AgentNameSchema,
  broker_url: z.string().max(LIMITS.BROKER_URL_MAX_CHARS).regex(/^https:\/\//),
  exp: TimestampSchema,
  invite_id: UlidSchema,
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // 256-bit; broker stores sha256(secret)
  v: z.literal(1),
});
export type InviteCodePayload = z.infer<typeof InviteCodePayloadSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Method registry — conformance harness entry point
 * ──────────────────────────────────────────────────────────────────────────── */

export const METHOD_SCHEMAS = {
  send: { request: SendRequestSchema, response: SendResponseSchema },
  inbox: { request: InboxRequestSchema, response: InboxResponseSchema },
  ack: { request: AckRequestSchema, response: AckResponseSchema },
  thread: { request: ThreadRequestSchema, response: ThreadResponseSchema },
  'diag.ping': { request: DiagPingRequestSchema, response: DiagPingResponseSchema },
  'admin.issueInvite': {
    request: AdminIssueInviteRequestSchema,
    response: AdminIssueInviteResponseSchema,
  },
  'invite.redeem': { request: InviteRedeemRequestSchema, response: InviteRedeemResponseSchema },
} as const satisfies Record<Method, { request: z.ZodType; response: z.ZodType }>;

/* ────────────────────────────────────────────────────────────────────────────
 * Conformance fixtures (B5) — >= 1 accept + >= 1 reject per artifact rule, tagged by
 * ART id. Each fixture is a complete `task` client-envelope; a fixture "accepts" iff
 * ClientEnvelopeSchema.safeParse succeeds. Rules covered by the field schemas
 * (RepoSlugSchema/GitRefSchema/ShaSchema/number) and by the shared refinement
 * (NFC, url host match, duplicates) are all exercised here.
 * ──────────────────────────────────────────────────────────────────────────── */

const _FIX_SHA = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const _FIX_SHA2 = 'b1c2d3e4f5061728394a5b6c7d8e9f0011223344';
const _NFD_REF = 'cafe' + String.fromCharCode(0x301); // decomposed (NFD) branch name

function _fixTask(over: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: PROTOCOL_VERSION,
    client_id: '01J1PAVH5N40E3D8QT2W9YRKM3',
    thread_id: null,
    parent_id: null,
    in_reply_to: null,
    to: 'jonathan/web',
    kind: 'task',
    repo: 'github.com/careswift/web',
    body: 'implement the route header',
    artifacts: [],
    ...over,
  };
}
const _commit = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: 'git_commit',
  repo: 'github.com/careswift/web',
  ref: 'main',
  sha: _FIX_SHA,
  ...over,
});
const _pr = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: 'pull_request',
  repo: 'github.com/careswift/web',
  number: 42,
  url: 'https://github.com/careswift/web/pull/42',
  ...over,
});

export interface ConformanceFixture {
  readonly art: string;
  readonly rule: string;
  readonly expect: 'accept' | 'reject';
  readonly envelope: unknown;
}

export const CONFORMANCE_FIXTURES: readonly ConformanceFixture[] = [
  // ART-021 — repo lowercase
  { art: 'ART-021', rule: 'repo lowercase', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({})] }) },
  { art: 'ART-021', rule: 'repo lowercase', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ repo: 'github.com/CareSwift/web' })] }) },
  // ART-023 — owner/name not "."/".." and name not ".git"
  { art: 'ART-023', rule: 'name not .git', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ repo: 'github.com/careswift/web' })] }) },
  { art: 'ART-023', rule: 'name not .git', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ repo: 'github.com/careswift/web.git' })] }) },
  // ART-024 — host <= 253 chars / port range
  { art: 'ART-024', rule: 'port range', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ repo: 'github.com:443/careswift/web' })] }) },
  { art: 'ART-024', rule: 'port range', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ repo: 'github.com:99999/careswift/web' })] }) },
  // ART-040 — sha 40 or 64 hex
  { art: 'ART-040', rule: 'sha length', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ sha: _FIX_SHA })] }) },
  { art: 'ART-040', rule: 'sha length', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ sha: `${_FIX_SHA}a` })] }) },
  // ART-045 — ref <= 255 UTF-8 bytes
  { art: 'ART-045', rule: 'ref byte length', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ ref: 'feature/tf-31-inbox' })] }) },
  { art: 'ART-045', rule: 'ref byte length', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ ref: 'a'.repeat(256) })] }) },
  // ART-046 — ref grammar (no refs/ prefix)
  { art: 'ART-046', rule: 'ref grammar', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ ref: 'main' })] }) },
  { art: 'ART-046', rule: 'ref grammar', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ ref: 'refs/heads/main' })] }) },
  // ART-048 — pull_request number in [1, 999999999]
  { art: 'ART-048', rule: 'pr number', expect: 'accept', envelope: _fixTask({ artifacts: [_pr({ number: 42 })] }) },
  { art: 'ART-048', rule: 'pr number', expect: 'reject', envelope: _fixTask({ artifacts: [_pr({ number: 0 })] }) },
  // ART-049a — url https/ascii, no credentials
  { art: 'ART-049a', rule: 'url no credentials', expect: 'accept', envelope: _fixTask({ artifacts: [_pr({ url: 'https://github.com/careswift/web/pull/42' })] }) },
  { art: 'ART-049a', rule: 'url no credentials', expect: 'reject', envelope: _fixTask({ artifacts: [_pr({ url: 'https://user:pass@github.com/careswift/web/pull/42' })] }) },
  // ART-049b — url host === repo host
  { art: 'ART-049b', rule: 'url host match', expect: 'accept', envelope: _fixTask({ artifacts: [_pr({ url: 'https://github.com/careswift/web/pull/42' })] }) },
  { art: 'ART-049b', rule: 'url host match', expect: 'reject', envelope: _fixTask({ artifacts: [_pr({ url: 'https://evil.example/careswift/web/pull/42' })] }) },
  // ART-051 — max 8 artifacts
  { art: 'ART-051', rule: 'max 8 artifacts', expect: 'accept', envelope: _fixTask({ artifacts: Array.from({ length: 8 }, (_v, i) => _commit({ ref: `br-${i}` })) }) },
  { art: 'ART-051', rule: 'max 8 artifacts', expect: 'reject', envelope: _fixTask({ artifacts: Array.from({ length: 9 }, (_v, i) => _commit({ ref: `br-${i}` })) }) },
  // ART-060 — no duplicate (type, repo, ref)
  { art: 'ART-060', rule: 'no duplicate artifact', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ ref: 'main', sha: _FIX_SHA }), _commit({ ref: 'dev', sha: _FIX_SHA2 })] }) },
  { art: 'ART-060', rule: 'no duplicate artifact', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ ref: 'main', sha: _FIX_SHA }), _commit({ ref: 'main', sha: _FIX_SHA2 })] }) },
  // ART-071 — artifact strings must be NFC (NFC ref accepts; the same ref in NFD rejects)
  { art: 'ART-071', rule: 'artifact NFC', expect: 'accept', envelope: _fixTask({ artifacts: [_commit({ ref: _NFD_REF.normalize('NFC') })] }) },
  { art: 'ART-071', rule: 'artifact NFC', expect: 'reject', envelope: _fixTask({ artifacts: [_commit({ ref: _NFD_REF })] }) },
] as const;
