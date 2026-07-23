# tenfour/1 — AUTH: Identity and Authorization

**Status: NORMATIVE spec, v1.0-draft. Governs the broker's identity, pairing, invite,
read-authorization, subscription, rotation, and audit behavior. Implements DESIGN.md
§5 and rulings R2/R8/R9 (referenced, not restated) and the founder decisions in
DESIGN.md §12.**

Companion specs: `PROTOCOL.md` (state machine, rounds, consent records),
`DELIVERY.md` (journal, leases, cursors), `WIRE.md` (Zod schemas, envelope fields).
Where this document names an error, the wire format is `TENFOUR/<CODE>` with
`retryable:false` and a `human_action` string; final strings live in `strings.ts`
and are build-time extracted — this spec defines the *conditions*, not the prose.

## 1. Conventions

- MUST / MUST NOT / SHOULD / MAY per RFC 2119 / RFC 8174.
- Every normative rule carries a stable ID (`ID-3`, `PAIR-2`, …). Conformance tests
  MUST reference rule IDs. A rule without a test is a release blocker (DESIGN R13).
- "Broker clock" is the only clock that matters (DESIGN: WSL clock-skew rule).
  Client-supplied timestamps are display-only everywhere in this document.
- Decisions this spec makes that DESIGN.md / JOURNEYS.md left open are marked
  **DECIDED HERE** and consolidated in §15.

## 2. Principals

### 2.1 Address grammar

| Rule | Requirement |
|---|---|
| ID-1 | An address is two lowercase slugs joined by `/`: `human/workspace`. Grammar (the ONE AgentName regex — `protocol.ts AGENT_NAME_REGEX` owns it): `^[a-z0-9][a-z0-9-]{0,31}/[a-z0-9][a-z0-9-]{0,31}$` (each segment 1–32 chars; total ≤ 65 chars). **DECIDED HERE (amended to match protocol.ts).** |
| ID-2 | The `tenfour/` first segment is RESERVED for system principals. `admin.issueInvite` MUST reject any invited address matching `^tenfour/`. **DECIDED HERE.** |
| ID-3 | Addresses are unique (primary key of the agents table) and compared byte-for-byte after the grammar check. No Unicode, no case folding — the grammar admits ASCII only. |

### 2.2 `agents` table

| Column | Type | Semantics |
|---|---|---|
| `address` | string, PK | ID-1 grammar. Immutable for the life of the row. |
| `role` | enum `agent` \| `system` | `system` rows are broker-internal principals (`tenfour/system`). |
| `token_sha256` | 64-char lowercase hex, nullable | SHA-256 of the full credential string (§3). NULL while `invited` and always NULL for `system` rows. |
| `token_sha256_prev` | 64-char lowercase hex, nullable | Previous hash during a rotation overlap window (§9). NULL otherwise. |
| `rotation_deadline` | int (broker epoch ms), nullable | End of the overlap window. NULL when no rotation is pending. |
| `status` | enum `invited` \| `active` \| `revoked` | See ID-6. |
| `created_ts`, `status_ts` | int | Broker clock. `status_ts` updates on every status transition. |

| Rule | Requirement |
|---|---|
| ID-4 | `role=system` rows MUST have `token_sha256 = NULL` and `status = active`, permanently. A system principal can never authenticate over the wire, be invited, be revoked, or be a pair member. It exists so `from: tenfour/system` messages (round-cap `needs_human`, freeze notices) have a first-class identity. |
| ID-5 | Exactly one `system` row exists in v1: `tenfour/system`, created at broker provisioning. |
| ID-6 | Status transitions are exactly: `(none) →invited` (admin.issueInvite, new address); `invited → active` (invite redemption, §6.3); `invited → revoked` (admin revokes the sole outstanding invite — **DECIDED HERE**); `active → revoked` (admin.revokeAgent); `revoked → invited` (admin.issueInvite re-invites the address — **DECIDED HERE**: address reuse is allowed; history lives in the audit log, §13). Any other transition is a broker bug and MUST be unrepresentable in code. |
| ID-7 | `from` on every stored message is derived from the authenticated credential, never from client input (DESIGN §4.1). There is no API by which a client supplies `from`. |

## 3. Credentials

### 3.1 Formats — **DECIDED HERE**

| Credential | Format | Length | Regex |
|---|---|---|---|
| Agent token | `tf1_` + base64url(32 random bytes from a CSPRNG) | 47 chars | `\btf1_[A-Za-z0-9_-]{43}\b` |
| Admin key | `tfadmin_` + base64url(32 random bytes from a CSPRNG) — WIRE D3 / `protocol.ts ADMIN_KEY_REGEX` | 51 chars | `\btfadmin_[A-Za-z0-9_-]{43}\b` |
| Invite secret | 32 random bytes (256-bit), carried base64url inside the invite code (WIRE §8.3 D29) | 43 chars encoded | n/a (never appears bare) |

| Rule | Requirement |
|---|---|
| CRED-1 | Tokens and admin keys MUST be generated broker-side from a CSPRNG. Clients never choose credential material. |
| CRED-2 | The broker stores ONLY `sha256(full credential string)` — hashing includes the `tf1_`/`tfadmin_` prefix. Plaintext exists broker-side only in the mint response, exactly once. |
| CRED-3 | The client stores the plaintext credential in `$TENFOUR_HOME` config with mode `0600` (POSIX) or the icacls inheritance-strip + sole-user grant (Windows). `tenfour doctor` fails on wider permissions. |
| CRED-4 | The credential regexes above MUST be included in the broker's send-time secret scan: a message body or artifact string matching them is rejected `TENFOUR/SECRET_DETECTED`. tenfour refuses to relay its own keys. **DECIDED HERE.** |
| CRED-5 | The `tf1_`/`tfadmin_` prefixes version the credential format. A future format bump mints `tf2_…`; the broker advertises accepted prefixes. Unknown prefix ⇒ `TENFOUR/AUTH_FAILED` (not a distinct error — see ENUM-1). |

### 3.2 Verification algorithm

| Rule | Requirement |
|---|---|
| CRED-6 | Verification is hash-then-lookup: compute `sha256(presented)`, look up the digest in an index over `token_sha256` and `token_sha256_prev` (and the admin-key hash for control-plane methods). Wrong-token and wrong-agent are thereby the *same code path* — there is no per-agent branch to time. |
| CRED-7 | Any digest equality comparison outside the index (e.g., admin key check, invite-secret check) MUST use a constant-time comparison (`crypto.timingSafeEqual`) over fixed-length 32-byte digests. |
| CRED-8 | Error responses MUST NOT echo the presented credential, its hash, or its prefix classification. |

### 3.3 Plane separation — capability matrix

The `tenfour/1` wire method set is EXACTLY the seven of WIRE §1. Rows below the
divider are NOT wire methods: the reactive subscription is a **transport-layer
mechanism** (Convex reactive query — §8), and the identity-lifecycle operations
are **broker control-plane endpoints** (§9–§10), versioned with the broker, not
the protocol.

| Surface | Agent token (`active`) | Admin key | System principal |
|---|---|---|---|
| `send`, `inbox`, `ack`, `thread` | ✔ (subject to §5, §7) | ✘ `AUTH_FAILED` | internal only (broker posts as `tenfour/system`; no wire path) |
| `diag.ping` (R6) | ✔ | ✘ `AUTH_FAILED` (agent tokens only — `protocol.ts DiagPingRequestSchema`; READ-6) | ✘ |
| `admin.issueInvite` | ✘ `AUTH_FAILED` | ✔ | ✘ |
| `invite.redeem` | n/a — the code is the credential (§6) | n/a | ✘ |
| — transport layer: reactive inbox subscription (§8; NOT a wire method) | ✔ own inbox only, bound to the opening credential | ✘ | ✘ |
| — control plane: `token.rotate` (§9; NOT a wire method) | ✔ (self only) | ✘ (use `admin.rotateKey`) | ✘ |
| — control plane: `admin.revokeInvite`, `admin.revokeAgent`, `admin.rotateKey` (§9–§10; NOT wire methods) | ✘ `AUTH_FAILED` | ✔ | ✘ |
| Unfreeze a frozen thread / raise a frozen thread's round cap | ✘ | ✘ **DECIDED HERE — see ADM-2** | ✘ |

| Rule | Requirement |
|---|---|
| ADM-1 | The admin key is a **control-plane** credential: identity lifecycle only. It MUST NOT send, ack, read inboxes, read threads, or subscribe. Presenting it to a data-plane method returns `TENFOUR/AUTH_FAILED`, byte-identical to any bad credential (ENUM-1) — the broker does not confirm that a valid admin key was presented to the wrong plane. |
| ADM-2 | **DECIDED HERE: the admin key MUST NOT unfreeze a frozen thread or alter any existing thread's round cap.** Unfreezing is exclusively the human `tenfour approve` → send-borne `unfreeze: true` path (B2, STATE §6.2): unfreeze RIDES `send`, it is NOT a control-plane endpoint, and no credential (admin key included) has an unfreeze method. Rationale: an admin bypass would be a second, weaker unfreeze path and would turn the owner's machine into a loop-containment bypass — the freeze layer is "the strongest claim we make" (DESIGN §5) and admits no privileged exception. `max_rounds` is **fixed per pair at invite issuance** (`admin.issueInvite.max_rounds`, WIRE §8.2 D27; default 10, clamp 1..12 — founder-decided) and copied onto each thread at creation: the admin sets it only when issuing an invite, and never retroactively for existing threads or the existing pair. |
| ADM-3 | Broker data export / deletion (retention policy, DESIGN §8) is an *operator* action through the operator's own infrastructure access, not a tenfour/1 method. The admin key grants no read path to message bodies. **DECIDED HERE.** SECURITY.md already states the broker operator can read bodies; this spec simply declines to add an API for it. |
| ADM-4 | `admin.rotateKey` rotates the admin key with the same overlap semantics as agent rotation (§9), authenticated by the current admin key. |

### 3.4 Check order on every authenticated call — **DECIDED HERE (amended)**

For `send`, the normative order is the SAME 13-step table, with the SAME step
numbers, as WIRE §7.1 D19 and STATE-MACHINE §3:

| # | Check | Error |
|---|---|---|
| 1 | protocol version (request + envelope, must match) | `UNSUPPORTED_VERSION` |
| 2 | token valid / not revoked (CRED-6; plane check ADM-1 folds in here — an admin key on the data plane is byte-identical `AUTH_FAILED`). The auth-failure throttle (ENUM-3) is evaluated before a failure response is released | `AUTH_FAILED` / `AUTH_REVOKED` |
| 3 | pair authorization (§4.3): `to` is the paired peer; not `tenfour/*` | `PAIR_FORBIDDEN` |
| 4 | `client_id` dedup (same hash → duplicate success, stop; different → reject) | (success) / `CLIENT_ID_CONFLICT` |
| 5 | rate ceiling (WIRE §10) | `RATE_LIMITED` |
| 6 | schema/caps: kind recognized, kind constraints, size caps, artifact shapes | `UNKNOWN_KIND` / `BODY_TOO_LARGE` / `ARTIFACT_INVALID` |
| 7 | secret scan (CRED-4 corpus included) | `SECRET_DETECTED` |
| 8 | object authorization (§7): thread exists; sender is a party | `THREAD_NOT_FOUND` / `NOT_THREAD_PARTY` |
| 9 | state machine: not terminal; not frozen (unless the send carries `unfreeze: true`, which evaluates the message against `resume_state`, B2); transition cell exists | `TERMINAL_THREAD` / `THREAD_FROZEN` / `UNKNOWN_KIND` / `NOT_THREAD_PARTY` (`role_forbidden`) |
| 10 | head rule | `STALE_HEAD` |
| 11 | consent (R8/R9) | `CONSENT_REQUIRED` |
| 12 | pair `repo_allowlist` (D27) | `REPO_NOT_ALLOWED` |
| 13 | round accounting (atomic with commit) | `ROUND_CAP` |

For non-`send` methods the applicable prefix applies in the same order (version →
auth → rate → schema → object authorization). A conformance test MUST exist that
triggers each adjacent pair out of order and asserts the earlier check wins.

## 4. The pair model

### 4.1 `pairs` table

| Column | Type | Semantics |
|---|---|---|
| `pair_id` | ULID, PK | Minted at pair creation. |
| `member_a`, `member_b` | address FK | Lexicographically ordered at write (`member_a < member_b`) so a pair has one canonical row. |
| `status` | enum `active` \| `dissolved` | |
| `created_ts`, `status_ts` | int | Broker clock. |

### 4.2 Invariants

| Rule | Requirement |
|---|---|
| PAIR-1 | **v1: at most ONE row with `status=active` exists.** The broker MUST enforce this transactionally, not by convention. |
| PAIR-2 | Both members MUST be `role=agent`. `tenfour/system` is never a pair member (ID-4). |
| PAIR-3 | An agent belongs to at most one active pair (trivially true under PAIR-1; stated so the invariant survives a future multi-pair v2). |
| PAIR-4 | The pair is created **atomically inside invite redemption** (§6.3): the transaction that flips the invited agent to `active` also inserts the active pair `(pair_with, invited)`. There is no window in which an `active` agent exists unpaired. **DECIDED HERE.** |
| PAIR-5 | `admin.revokeAgent` on a pair member sets the pair `dissolved` in the same transaction. **DECIDED HERE (amended):** threads are left UNTOUCHED — no system post, no freeze (STATE §5 [Y]: the round-cap breach is v1's only system emission, and DELIVERY DEL-41 relies on broker rows surviving revocation). The revoked side simply can no longer call; the surviving peer sees ordinary unacked staleness in `tenfour status`, and re-pairing under the same agent name resumes the same threads. |
| PAIR-6 | `admin.issueInvite` that would, upon redemption, create a second active pair MUST be rejected at issuance with `TENFOUR/PAIR_FORBIDDEN`. **DECIDED HERE** (the code generalizes to "operation violates the pair model," not only sends). |

### 4.3 Send authorization

| Rule | Requirement |
|---|---|
| PAIR-7 | `send` is authorized ONLY when the authenticated sender and the envelope `to` are the two members of the active pair. Anything else ⇒ `TENFOUR/PAIR_FORBIDDEN`. This includes: `to` an address that does not exist, `to` a revoked agent, `to` `tenfour/system`, and `to` = self (**DECIDED HERE**: self-send is `PAIR_FORBIDDEN`; the paired peer is by definition not yourself). One error condition, one code — no oracle distinguishing "no such agent" from "not your peer" (ENUM-2). |
| PAIR-8 | The pair check reads pair state inside the same transaction as the send write. A send racing a `revokeAgent` either fully precedes it (message lands, then PAIR-5 freeze applies) or fully follows it (`PAIR_FORBIDDEN` — sender revoked mid-flight would instead fail step 2 with `AUTH_REVOKED`). No torn state. |

## 5. Repo and gate scope note (non-normative pointer)

Gate permission rules are **per-project**: repos designated as tenfour workspaces
carry the shipped gate list; `tenfour doctor` WARNS when a `task`'s first-class
`repo` field (R10) names a repo not tagged as a tenfour workspace. Normative
details live in PROTOCOL.md (repo allowlist, `REPO_NOT_ALLOWED`) and SETUP.md;
listed here only because reviewers look for it in the auth spec.

## 6. Invite lifecycle

### 6.1 `invites` table

| Column | Type | Semantics |
|---|---|---|
| `invite_id` | ULID, PK | |
| `address` | address FK | The invited address. Fixed at issuance (INV-8). |
| `pair_with` | address FK | The existing active agent the redeemer will be paired with (broker-side only; not carried in the code payload). |
| `secret_sha256` | hex64 | SHA-256 of the 32-byte invite secret. Plaintext secret exists only inside the emitted code. |
| `expires_ts` | int (ms) | Broker clock, issuance + `ttl_s` — a caller parameter of `admin.issueInvite` (WIRE §8.2 D27: default 86400 s / 24 h, clamped 300–604800 s). |
| `max_rounds` | int | Fixed at issuance (WIRE D27, default 10, clamp 1..12); copied onto each of the pair's threads at creation. |
| `repo_allowlist` | string[] \| null | Optional, ≤ 64 canonical repo slugs, fixed at issuance (WIRE D27); enforced broker-side at send (`REPO_NOT_ALLOWED`). |
| `failed_attempts` | int | Redemption failures for this code; at 5 the code is permanently invalidated (WIRE D30). |
| `status` | enum `outstanding` \| `redeemed` \| `revoked` \| `superseded` | |
| `created_ts`, `status_ts` | int | |

### 6.2 Code format — owned by WIRE §8.3 D29 + `protocol.ts`

**WIRE §8.3 D29 and `protocol.ts` (`InviteCodePayloadSchema`, `INVITE_CODE_REGEX`)
are the SOLE owners of the invite wire format.** Recap (normative source is WIRE):

```
TENFOUR1.<payload_b64url>.<check_b64url>
```

- `payload` = base64url (unpadded) of the minimal JSON
  `{"agent":…,"broker_url":…,"exp":<ms epoch>,"invite_id":…,"secret":"<43-char b64url, 256-bit>","v":1}`
  (keys sorted, no whitespace). `pair_with` is NOT in the payload — it lives in the
  broker's invites row (§6.1).
- `check` = base64url (unpadded, 6 chars) of the FIRST 4 BYTES of
  `sha256(payload_b64url string as UTF-8)`.
- Regex: `^TENFOUR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6}$`; whole code ≤ 1024 chars.

| Rule | Requirement |
|---|---|
| INV-1 | Full-code grammar: exactly `protocol.ts INVITE_CODE_REGEX` (above). A parser seeing any other version tag rejects locally with the CLI equivalent of `INVITE_INVALID` before any network call. |
| INV-2 | The checksum is a **paste-mangling defense, not a security control** — security rests on the 256-bit invite secret verified broker-side (CRED-7) plus single-use redemption. The spec says this out loud so nobody audits a 4-byte SHA-256 truncation as crypto. |
| INV-3 | `tenfour join` MUST verify the checksum and parse the payload locally, then print the confirmation ("joining as `agent` to `broker_url` — correct? [Y/n]") **before any network call** (JOURNEYS §3). The `exp` field is display-only; expiry is enforced against the broker clock (INV-6). |
| INV-4 | The invite secret is 32 CSPRNG bytes (256-bit), encoded as 43 base64url chars (WIRE D29). **DECIDED HERE (amended to WIRE):** single-use + short lifetime + broker-side hash verification would make 128 bits ample, but one credential width across the system (D3 tokens are also 256-bit) removes a class of review questions. |

### 6.3 Redemption

| Rule | Requirement |
|---|---|
| INV-5 | Redemption request carries the **full code** (`invite.redeem { code, client_info }` — WIRE §8.4; the code IS the credential). The broker parses `invite_id` + `secret` from the payload and verifies, in one transaction: `sha256(secret)` equals `secret_sha256` (constant-time, CRED-7); `status = outstanding`; `expires_ts` not passed (broker clock); `failed_attempts < 5` (WIRE D30). On success, atomically: invite → `redeemed`; agent row `address` → `active`; agent token minted and its hash stored; active pair `(pair_with, address)` inserted (PAIR-4). The response returns the plaintext token exactly once. |
| INV-6 | Expired (`expires_ts < now`, otherwise valid) ⇒ `TENFOUR/INVITE_EXPIRED`. Every other failure — unknown `invite_id`, wrong secret, checksum fail, `redeemed`, `revoked`, `superseded`, malformed, locked out (D30) — ⇒ `TENFOUR/INVITE_INVALID`, **byte-identical body across those causes, with NO `data.reason`** (no oracle on which field was wrong). **DECIDED HERE** — and WIRE §8.4 now mirrors this exactly. |
| INV-7 | Single redemption is enforced by the atomic `outstanding → redeemed` compare-and-set. A concurrent second redemption MUST lose the transaction and receive `INVITE_INVALID`. |
| INV-8 | **Redemption binds the redeemer to the invited address.** The redeemer supplies no identity input; the minted token IS `address` from the invite row. There is no parameter by which a joiner picks a different name. |

### 6.4 Revocation, re-issue, expiry

| Rule | Requirement |
|---|---|
| INV-9 | `admin.revokeInvite(invite_id)` sets `revoked`. If the target agent row is `invited` and this was its only outstanding invite, the agent row becomes `revoked` in the same transaction (ID-6). |
| INV-10 | `admin.issueInvite` for an address with an outstanding invite marks the older invite `superseded` (unredeemable, treated as `INVITE_INVALID`) and issues a fresh one. At most one outstanding invite per address. **DECIDED HERE.** |
| INV-11 | Expiry is passive: no background job is required. The `outstanding` row simply fails INV-6 at redemption time. Brokers MAY garbage-collect expired rows after the audit event is written (§13). |
| INV-12 | `admin.issueInvite` requires: admin key (ADM-1); invited address passes ID-1/ID-2; `role` is implicitly `agent` (system rows are never invited, ID-4); PAIR-6 holds. |
| INV-13 | Lockout (WIRE D30): 5 failed redemption attempts permanently invalidate a code (`failed_attempts` column, §6.1). Subsequent attempts return the same uniform `INVITE_INVALID` body (INV-6). |

## 7. Read authorization

| Rule | Requirement |
|---|---|
| READ-1 | `inbox` returns only messages addressed to the authenticated agent. The method takes no "as agent" parameter — the API shape makes cross-inbox reads unrepresentable. |
| READ-2 | `thread(thread_id)` requires the caller to be a **thread party**: the `from` or `to` of the thread's root message. `tenfour/system` messages inside a thread do not add parties. Non-party callers with a real `thread_id` ⇒ `TENFOUR/NOT_THREAD_PARTY`; nonexistent `thread_id` ⇒ `TENFOUR/THREAD_NOT_FOUND`. |
| READ-3 | **DECIDED HERE:** READ-2 deliberately discloses thread *existence* to authenticated non-parties. Rationale, stated for hostile review: (a) in v1 exactly one pair exists, so every active agent is a party to every thread — the disclosure set is empty in practice; (b) thread IDs are ULIDs with 80 bits of randomness, not enumerable; (c) the identical-error requirement (ENUM-1) governs the *authentication* layer, where the caller is untrusted — an authenticated agent distinguishing "not found" from "not yours" gets actionable, non-sensitive feedback and avoids repair loops (JOURNEYS §4 doctrine). Revisit if v2 lifts PAIR-1. |
| READ-4 | `ack` is recipient-only (DESIGN §6): only the agent to whom the delivery attempt was addressed may ack it. Any other caller — including the message's *sender* — receives `TENFOUR/NOT_THREAD_PARTY`. **DECIDED HERE** (reuse over a new code; the condition is "you are not the authorized party for this object"). |
| READ-5 | Question micro-threads (R3, `thread_id:null` roots) follow READ-2 unchanged: parties are the root `question`'s `from`/`to`. |
| READ-6 | `diag.ping` (R6) touches no thread state and is callable by any `active` **agent token only** (`protocol.ts DiagPingRequestSchema` accepts `tf1_` bearers; the admin key gets `AUTH_FAILED` per ADM-1). Its response is limited to broker reachability, broker time, protocol versions, the caller's own address echo, **and the paired peer's presence object** (`peer: {agent, last_ping_ts, last_mark}` — WIRE §8.1 D26), disclosed to the paired peer ONLY. It MUST NOT leak any other agent's existence, inbox depth, or thread data. Mark-bearing pings emit the `diag.mark` audit event (§13). |

## 8. The reactive subscription (transport layer — NOT a wire method)

**The `tenfour/1` method set has no `subscribe` method** (WIRE §1;
`protocol.ts METHODS`). The live subscription is EXACTLY this: a **Convex reactive
query** (or the equivalent push channel of another broker implementation) over the
caller's own claimable inbox rows — a transport-layer latency mechanism, never
correctness (DELIVERY DEL-01: all correctness comes from cursor-based `inbox` on
reconnect). The SUB rules below govern the transport channel's credential binding;
none of them define wire shapes, and no conformance fixture may reference a
`subscribe` method.

| Rule | Requirement |
|---|---|
| SUB-1 | The reactive query authenticates with the same bearer verification as any call (§3.4 steps 1–2) and scopes to the caller's own inbox only. Latency optimization, never correctness (DESIGN §6). It is not rate-limited as a method (it isn't one); ENUM-3 governs its authentication failures. |
| SUB-2 | The channel is **bound to the credential presented at open**. It does not silently migrate to a rotated token. |
| SUB-3 | When the binding credential is revoked (`admin.revokeAgent`) or retired by rotation (§9), the broker MUST terminate the channel within **5 seconds** of the revocation/retirement commit (**DECIDED HERE**; Convex reactive queries make this natural — a broker-implementation promise, not a wire contract), delivering a terminal event carrying `TENFOUR/AUTH_REVOKED` and then closing. No message may be pushed on the channel after the commit. |
| SUB-4 | On an `AUTH_REVOKED` terminal event, the adapter MUST NOT auto-retry with the same credential. If a rotated successor token exists in local config, it re-opens with it (rotation case); otherwise it surfaces the failure-grammar string directing the human to `tenfour join` re-pair (JOURNEYS §5). |
| SUB-5 | Second channel with the same credential: warn + last-connect-wins (DESIGN §6 single-session rule). This is NOT an auth error and MUST NOT use `CLIENT_ID_CONFLICT` (that code belongs to send-dedup) — the demoted session learns via its next tool call or claim (DELIVERY §3). |

## 9. Token rotation

### 9.1 Procedure (agent token; admin key identical via `admin.rotateKey`)

| Step | Actor | Action | Crash-recovery obligation |
|---|---|---|---|
| 1 | client | Persist rotation intent in the local journal (R11 pattern: `prepared → sending → confirmed`). | Re-running after a crash resumes, not duplicates. |
| 2 | client → broker | `token.rotate` authenticated with the current token. | Idempotent under retry via journal. |
| 3 | broker | Transaction: mint new token; `token_sha256_prev ← token_sha256`; `token_sha256 ← sha256(new)`; `rotation_deadline ← now + overlap`. Return plaintext new token once. | |
| 4 | client | Write new token to config **atomically** (temp file + rename, fsync), then mark journal `confirmed`. | Crash before write: old token still valid in overlap; see ROT-3. |
| 5 | client → broker | Any successful call with the new token. | |
| 6 | broker | On first successful new-token call OR at `rotation_deadline`, whichever first: move the old hash to the revoked-hash list (§10) and clear `token_sha256_prev` / `rotation_deadline`. | |

### 9.2 Rules

| Rule | Requirement |
|---|---|
| ROT-1 | Overlap window: **10 minutes, or until the first successful call authenticated by the new token, whichever comes first.** **DECIDED HERE.** During overlap both hashes authenticate as the same agent (CRED-6 indexes both columns). |
| ROT-2 | At most one rotation is pending per agent. A second `token.rotate` during an open overlap window (authenticated by either valid token) **cancels the previous pending new token** (its hash goes straight to the revoked list) and mints a fresh one, resetting the deadline. **DECIDED HERE** — recovers the "crashed before writing config" case with the same command, no special mode. |
| ROT-3 | If the client crashes between steps 3 and 4, the old token remains valid until the deadline; the recovery action is simply `tenfour token rotate` again (ROT-2). The failure-grammar string for `AUTH_REVOKED` after a missed window says exactly this, then falls back to re-pair. |
| ROT-4 | `admin.revokeAgent` is immediate: both current and overlap hashes go to the revoked list in one transaction. No overlap applies to revocation. |
| ROT-5 | Rotation MUST NOT change `address`, pair membership, thread state, inbox contents, delivery cursors, or consent records (R9). Identity is the address; the token is only proof. |

## 10. Revocation semantics: `AUTH_REVOKED` vs `AUTH_FAILED`

| Rule | Requirement |
|---|---|
| REV-1 | The broker keeps a **revoked-hash list**: sha256 digests of credentials retired by revocation or rotation, each retained **30 days** from retirement. **DECIDED HERE.** |
| REV-2 | A presented credential whose digest is on the revoked-hash list ⇒ `TENFOUR/AUTH_REVOKED`. Any other authentication failure ⇒ `TENFOUR/AUTH_FAILED`. After the 30-day retention lapses, the same stale credential degrades to `AUTH_FAILED` by construction. |
| REV-3 | **DECIDED HERE — why this is not an enumeration leak:** `AUTH_REVOKED` confirms only that a *formerly valid, now dead* credential was presented — worthless for gaining access — while giving the legitimate holder with a stale config the exact recovery path (`tenfour token rotate` if in overlap, else re-pair). Agent-experience doctrine (errors teach the one next action) wins over hiding a zero-value bit. The identical-error rule (ENUM-1) fully applies to everything else. |
| REV-4 | Revocation takes effect at transaction commit: in-flight requests that began authentication before the commit MAY complete; every request authenticated after the commit fails per REV-2. Subscriptions: SUB-3. |

## 11. Enumeration defense

| Rule | Requirement |
|---|---|
| ENUM-1 | Wrong token, unknown agent, malformed token, valid-plane-mismatched credential (ADM-1), and unknown credential prefix all return **byte-identical** `TENFOUR/AUTH_FAILED` envelopes: same code, same strings, same field set. A conformance test MUST diff the serialized bodies across all five causes. |
| ENUM-2 | `PAIR_FORBIDDEN` is likewise cause-uniform (PAIR-7): a sender cannot use `to` probing to learn which addresses exist. |
| ENUM-3 | Auth-failure throttle: more than **10 failed authentications per minute per transport source** (connection identity, or client IP where the transport exposes one) ⇒ `TENFOUR/RATE_LIMITED` for subsequent attempts from that source until the window drains. **DECIDED HERE.** Like all tenfour errors it is `retryable:false` — the model stops and informs its human. |
| ENUM-4 | Timing: CRED-6/CRED-7 make the failure path computationally identical regardless of whether the agent exists. Tests SHOULD include a coarse timing assertion (same code path, no early-exit string compare); the spec does not pretend to defeat network-level statistical timing, and SECURITY.md says so. |

## 12. Same-human mode (J5) — ruling restated normatively

| Rule | Requirement |
|---|---|
| SH-1 | `init --same-human` (desktop ↔ laptop) is a **CLI convenience only. The broker cannot distinguish same-human mode and MUST NOT be told about it** — there is no wire flag. |
| SH-2 | **Identical token separation**: two distinct agent rows, two distinct tokens, minted through the full invite → redeem lifecycle (§6). Sharing one token across machines is unsupported and unrepresentable in the pairing flow. |
| SH-3 | **Identical ceilings**: round caps (default 10, clamp 1..12), rate ceilings, body/artifact size caps, freeze behavior, consent records (R9), and every rule in this spec apply unmodified. There is no "trusted mode" relaxation, and none may be added to v1. |
| SH-4 | Only the pairing **UX** differs: the CLI runs `admin.issueInvite` and `join` in one process, MAY auto-confirm the "joining as X to Y" prompt (both identities are operated by the same human, so paste-mangling defense is moot — the code never traverses a lossy channel), pre-writes standing rules per JOURNEYS J5, and still prints the covenant line. **DECIDED HERE** (scope of what "skips pairing ceremony" may legally skip: prompts only, never broker-side lifecycle steps). |

## 13. Audit

### 13.1 Event catalog (append-only)

| Event | Emitted when | Subject |
|---|---|---|
| `invite.issued` | admin.issueInvite succeeds | invite_id, address, pair_with |
| `invite.redeemed` | INV-5 transaction commits | invite_id, address |
| `invite.revoked` | admin.revokeInvite | invite_id |
| `invite.superseded` | INV-10 | old invite_id, new invite_id |
| `invite.rejected` | redemption fails (which of INVITE_INVALID/INVITE_EXPIRED, plus internal cause) | invite_id if resolvable |
| `pair.created` / `pair.dissolved` | PAIR-4 / PAIR-5 | pair_id, members |
| `agent.revoked` | admin.revokeAgent | address |
| `token.rotation_started` / `token.rotation_completed` / `token.rotation_superseded` | §9 steps 3 / 6 / ROT-2 | address |
| `admin.key_rotated` | ADM-4 | — |
| `auth.failed` | ENUM-1 failures (MAY be sampled above 1/sec/source; sampling factor recorded) | digest prefix (AUD-3) |
| `auth.throttled` | ENUM-3 trips | source |
| `subscription.opened` / `subscription.closed` | SUB-1 / SUB-3 (close reason recorded: normal, superseded, revoked) | address |
| `diag.mark` | a `diag.ping` carrying a `mark` writes/refreshes the presence record (READ-6; WIRE D26) — the beacon leaves an audit trace even though the record itself is retention-exempt (accepted risk, ADVERSARIAL-MATRIX A11) | address, mark |

### 13.2 Field and retention rules

| Rule | Requirement |
|---|---|
| AUD-1 | Every event carries: `event_id` (ULID), `ts` (broker clock), `actor` (`admin`, an agent address, or `tenfour/system`), `event`, subject fields per the catalog, and transport metadata where the transport exposes it (source identifier, client version string). |
| AUD-2 | The audit log is append-only and retained **≥ 90 days**. **DECIDED HERE.** It is readable by the broker operator through operator infrastructure (ADM-3); tenfour/1 exposes no audit-read method in v1. |
| AUD-3 | `auth.failed` events MUST NOT store the presented credential nor its full hash — only the **first 8 hex chars of `sha256(presented)`** (correlation without recovery; a mistyped paste is often a live secret for some *other* system, and we refuse to warehouse it). **DECIDED HERE.** |
| AUD-4 | Audit writes occur in the same transaction as the state change they record; a state change without its audit row MUST be impossible. |

## 14. Error codes owned or used by this spec

Registry-complete list is in WIRE.md; wire format `TENFOUR/<CODE>`, all
`retryable:false`. This spec is the normative source for the *conditions* of:

| Code | Condition (rule) |
|---|---|
| `AUTH_FAILED` | Any authentication failure not matching a retained revoked hash; plane mismatch (ENUM-1, ADM-1, CRED-5) |
| `AUTH_REVOKED` | Retained revoked/retired credential presented (REV-2); subscription terminal event (SUB-3) |
| `PAIR_FORBIDDEN` | Send outside the active pair incl. self-send (PAIR-7); invite that would create a second active pair (PAIR-6) |
| `NOT_THREAD_PARTY` | Thread read by authenticated non-party (READ-2); ack by non-recipient (READ-4) |
| `THREAD_NOT_FOUND` | Nonexistent thread_id on `thread` (READ-2) |
| `INVITE_INVALID` | Unknown/consumed/revoked/superseded invite, wrong secret, checksum fail, malformed code, lockout — byte-identical, no `data.reason` (INV-6, INV-13) |
| `INVITE_EXPIRED` | Otherwise-valid invite past its `ttl_s` broker-clock expiry (INV-6; WIRE §8.2 D27) |
| `RATE_LIMITED` | Auth-failure throttle (ENUM-3) — also used by PROTOCOL.md's per-agent rate ceiling |

`CLIENT_ID_CONFLICT`, `SECRET_DETECTED` (send-path, though CRED-4 feeds its
pattern set), `CONSENT_REQUIRED` (R9), `REPO_NOT_ALLOWED`, `STALE_HEAD`,
`TERMINAL_THREAD`, `THREAD_FROZEN`, `ROUND_CAP`, `BODY_TOO_LARGE`,
`UNSUPPORTED_VERSION`, `UNKNOWN_KIND` are owned by PROTOCOL.md / WIRE.md /
DELIVERY.md and listed here only for registry cross-reference.

## 15. Consolidated DECIDED-HERE register

| # | Decision | Rule |
|---|---|---|
| 1 | Address grammar = `protocol.ts AGENT_NAME_REGEX` (two 1–32 char lowercase slugs, ≤ 65 total); `tenfour/` namespace reserved | ID-1, ID-2 |
| 2 | Credential formats `tf1_`/`tfadmin_` + 43 base64url chars (WIRE D3); own-token regexes wired into SECRET_DETECTED scan | §3.1, CRED-4 |
| 3 | Revoking an `invited` agent's sole invite revokes the agent row; revoked addresses may be re-invited | ID-6, INV-9 |
| 4 | Admin key is control-plane only; **cannot** unfreeze or raise a frozen thread's cap; no data-plane read API; `max_rounds` set per pair at invite issuance only | ADM-1..3 |
| 5 | Check order on authenticated calls = the WIRE D19 / STATE §3 13-step order | §3.4 |
| 6 | Pair created atomically at redemption; second-pair invites rejected `PAIR_FORBIDDEN`; member revocation dissolves the pair, threads untouched (no system post, no freeze) | PAIR-4..6 |
| 7 | Self-send ⇒ `PAIR_FORBIDDEN` (cause-uniform) | PAIR-7 |
| 8 | Invite code format owned by WIRE §8.3 D29 + protocol.ts (6-char b64url SHA-256-truncation check; 256-bit secret; ms `exp`); checksum is anti-mangling, not crypto | §6.2, INV-2, INV-4 |
| 9 | Cause-uniform `INVITE_INVALID` (no `data.reason`) for all non-expiry redemption failures, lockout included | INV-6, INV-13 |
| 10 | One outstanding invite per address; re-issue supersedes | INV-10 |
| 11 | `NOT_THREAD_PARTY` may disclose thread existence to authenticated agents — accepted with stated rationale | READ-3 |
| 12 | Ack by wrong party ⇒ `NOT_THREAD_PARTY` (no new code); ack referencing a superseded attempt from a demoted holder ⇒ `AUTH_FAILED` (WIRE D23; DELIVERY §3.2) | READ-4 |
| 13 | Reactive subscription is transport-layer (NOT a wire method); bound to opening credential; terminated ≤ 5 s after revocation/retirement with `AUTH_REVOKED` terminal event | §8, SUB-2, SUB-3 |
| 14 | Rotation overlap = 10 min or first new-token call; single pending rotation, re-rotate supersedes | ROT-1, ROT-2 |
| 15 | Revoked-hash retention 30 days ⇒ `AUTH_REVOKED`, then degrades to `AUTH_FAILED`; rationale for the disclosed bit recorded | REV-1..3 |
| 16 | Auth-failure throttle: 10/min/source ⇒ `RATE_LIMITED` | ENUM-3 |
| 17 | Same-human mode may skip prompts only, never broker-side lifecycle; ceilings identical, no wire flag | SH-1..4 |
| 18 | Audit: ≥ 90-day retention; `auth.failed` stores only 8-hex digest prefix; audit row transactional with the state change | AUD-2..4 |
