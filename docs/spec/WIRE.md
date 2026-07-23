# tenfour/1 — Wire Protocol Specification (WIRE.md)

**Status: NORMATIVE v1.0-draft. Governs all broker traffic. Supersedes prose in DESIGN.md §4 where they differ; incorporates rulings R1–R13 and the July 2026 founder decisions.**

The single executable source of truth for every shape in this document is
`packages/schema/src/protocol.ts`. If this prose and that file ever disagree, the
schema file wins and this file has a bug.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, MAY are to be interpreted as
described in RFC 2119.

---

## 1. Scope and conformance

This document defines the complete client↔broker wire contract for protocol
`tenfour/1`:

| Surface | Methods |
|---|---|
| Messaging | `send`, `inbox`, `ack`, `thread` |
| Diagnostics | `diag.ping` (carries the `hello` handshake — R6) |
| Identity | `admin.issueInvite`, `invite.redeem` |

A conforming **broker** implements all seven methods exactly as specified. A
conforming **client** (adapter/CLI) sends only shapes defined here and tolerates
additive response fields (§4). There are no other methods in `tenfour/1`. Anything
not defined here is not on the wire. In particular:

- There is **no `subscribe` method**: live delivery is a transport-layer mechanism
  (a Convex reactive query in the v1 broker), never a `tenfour/1` wire method.
  Correctness always comes from cursor-based `inbox` on reconnect (DELIVERY DEL-01);
  the subscription only reduces latency. AUTH.md §8 governs its credential binding.
- There are **no `consent.grant` / `consent.revoke` methods**: consent rides `send`
  with `kind:accepted` plus the `consent` block (§7.1). Consent revocation is
  RESERVED for v1.1 (D20).
- Identity-lifecycle operations beyond `admin.issueInvite`/`invite.redeem`
  (token rotation, invite/agent revocation, admin-key rotation) are broker
  **control-plane endpoints** specified in AUTH.md §9–§10. They are versioned with
  the broker implementation, are NOT `tenfour/1` methods, and never appear in the
  `tenfour/1` conformance surface.

Out of scope for this file (owned by sibling normative artifacts): the full
kind × state × role state table (STATE.md / PROTOCOL.md), delivery-journal internals,
strings catalog, permission-rule sets. Where a state-machine outcome surfaces on the
wire, this file defines the error mapping (§9.2).

---

## 2. Transport binding and authentication

`tenfour/1` is a request/response method contract over JSON. It is
transport-agnostic; the v1 broker implements it as Convex functions.

**DECIDED HERE (D1):** The reference HTTP binding is `POST /tenfour/1/<method>`
(e.g. `POST /tenfour/1/diag.ping`) with a JSON request body and a JSON response.
The binding MUST return HTTP 200 for **both** protocol success and protocol error;
the discriminator is the top-level `ok` boolean. Non-200 responses and network
failures are *transport* failures: the adapter MAY retry them idempotently under
R11 (reusing `client_id`); the model MUST NOT be told to retry anything.

**Authentication (DECIDED HERE, D2):** credentials travel **in the request body**,
never in transport headers, so the contract is identical across Convex, HTTP, and
test harnesses:

| Method | Credential |
|---|---|
| `send`, `inbox`, `ack`, `thread`, `diag.ping` | `auth: { token: "<bearer>" }` — per-agent bearer token |
| `admin.issueInvite` | `admin_key: "<admin bearer>"` |
| `invite.redeem` | `code: "<invite code>"` — the invite code IS the credential |

Token formats (**DECIDED HERE, D3**):

| Credential | Format | At rest |
|---|---|---|
| Agent bearer token | `tf1_` + 43 base64url chars (256-bit) — regex `^tf1_[A-Za-z0-9_-]{43}$` | broker stores `sha256(token)` only |
| Admin key | `tfadmin_` + 43 base64url chars (256-bit) — regex `^tfadmin_[A-Za-z0-9_-]{43}$` | broker stores `sha256(key)` only |

`from` is always derived from the authenticated token. A `from` field supplied by a
client MUST be ignored (stripped per §4). An unknown token yields
`TENFOUR/AUTH_FAILED`; a revoked token yields `TENFOUR/AUTH_REVOKED`.

**Reserved namespace (DECIDED HERE, D4):** agent names beginning `tenfour/` are
reserved for the broker (`tenfour/system` is the only v1 occupant). A `send` whose
`to` begins `tenfour/` MUST be rejected with `TENFOUR/PAIR_FORBIDDEN`.

---

## 3. Common types

| Type | Definition |
|---|---|
| `ULID` | 26-char Crockford base32, regex `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`. Used for `id`, `thread_id`, `client_id`, `attempt_id`, `invite_id`, `token_id`. |
| `AgentName` | `^[a-z0-9][a-z0-9-]{0,31}/[a-z0-9][a-z0-9-]{0,31}$` (e.g. `brian/design`, `jonathan/web`, `tenfour/system`). |
| `RepoSlug` | Canonical three-segment `host/owner/name`, **entirely lowercase**, max 300 chars total (grammar owned by ARTIFACTS.md §2.1; `protocol.ts REPO_SLUG_REGEX` is the executable form). Host is a DNS name (punycode A-labels only) with optional `:port`; `owner`/`name` are 1–100 chars of `[a-z0-9._-]`. Example: `github.com/careswift/web`. |
| `GitRef` | 1–255 chars, no whitespace, no control chars (`^[^\s\x00-\x1f\x7f]{1,255}$`). |
| `Sha` | `^([0-9a-f]{40}|[0-9a-f]{64})$` — SHA-1 or SHA-256 object names, lowercase hex only. |
| `Timestamp` | Integer milliseconds since Unix epoch, UTC, **broker clock only** (client clocks never appear on the wire — WSL skew rule). Display-only; ordering comes from `seq`/`arrival`. **DECIDED HERE (D5).** |
| `Kind` | `task \| question \| answer \| accepted \| declined \| result \| change_request \| cancel \| done \| needs_human` |
| `ThreadStatus` | `offered \| in_progress \| review \| closed \| frozen \| open` — `open` is exclusive to question-rooted micro-threads. **DECIDED HERE (D6).** |
| `DeliveryState` | `queued \| claimed \| injected \| acked` (R7). |
| `Cursor` | Opaque base64url string, ≤ 256 chars. Clients MUST NOT parse it. |

`thread_id` is its own ULID minted at thread creation; it is **not** the root
message's `id` (**DECIDED HERE, D7**).

---

## 4. Version negotiation and unknown fields

1. Every request object carries a top-level `protocol` field. On `send`, the
   envelope's `protocol` field MUST equal the request's; mismatch or any value
   other than a broker-supported version yields `TENFOUR/UNSUPPORTED_VERSION` with
   `data.supported` listing supported versions (**DECIDED HERE, D8**: the field
   appears in both places and must match).
2. The broker advertises `protocol_versions` in `diag.ping` and `invite.redeem`
   responses. v1 brokers advertise exactly `["tenfour/1"]`.
3. **Unknown-field rule (DECIDED HERE, D9):** unknown fields are *ignored
   everywhere*. The broker MUST strip unknown fields from requests and envelopes
   before validation, hashing, and persistence. Clients MUST ignore unknown fields
   in responses and MUST NOT rely on unknown fields round-tripping. Because the
   content hash is computed over a fixed field set (§6), stripped fields can never
   cause `CLIENT_ID_CONFLICT`.
4. Additive evolution: a broker MAY add new *optional* response fields without a
   version bump. New kinds, new methods, removed fields, or changed semantics
   REQUIRE a new protocol version string.
5. An unrecognized `kind` string is `TENFOUR/UNKNOWN_KIND` — never a silent drop.
6. Protocol version and npm package version are independent.

---

## 5. The envelope

### 5.1 Client envelope (input to `send`)

```jsonc
{
  "protocol": "tenfour/1",
  "client_id": "01J1PAVH5N40E3D8QT2W9YRKM3",   // ULID, minted by the ADAPTER, never the model
  "thread_id": null,                            // ULID | null; null only for task | question (R3)
  "parent_id": null,                            // ULID | null; MUST equal current thread head; null only when thread_id is null
  "in_reply_to": null,                          // ULID | null (R4); REQUIRED for answer, forbidden otherwise
  "to": "jonathan/web",
  "kind": "task",
  "repo": "github.com/careswift/web",           // REQUIRED on task (R10); OPTIONAL on change_request; forbidden otherwise
  "body": "markdown, NFC-normalized, ≤ 16384 bytes UTF-8",
  "artifacts": []                               // ≤ 8; allowed on task | result | change_request only
}
```

### 5.2 Kind constraint table (normative)

An envelope that violates its row fails with `TENFOUR/UNKNOWN_KIND`,
`data.reason:"malformed_for_kind"` (§9.2), except artifact-shape violations which
fail with `TENFOUR/ARTIFACT_INVALID`.

| kind | opens thread (`thread_id:null`)? | `in_reply_to` | `repo` | `artifacts` | `body` | sender role |
|---|---|---|---|---|---|---|
| `task` | REQUIRED (always opens) | forbidden | REQUIRED | 0–8 allowed | non-empty | initiator of new thread |
| `question` | allowed (micro-thread, R3) or into a task-rooted thread | forbidden | forbidden | forbidden | non-empty | either party |
| `answer` | never | REQUIRED — id of a `question` in the same thread | forbidden | forbidden | non-empty | the party the question was addressed to |
| `accepted` | never | forbidden | forbidden | forbidden | MAY be empty | recipient |
| `declined` | never | forbidden | forbidden | forbidden | non-empty | recipient |
| `result` | never | forbidden | forbidden | REQUIRED: ≥ 1 sha-pinned (`git_commit`/`git_branch`) | non-empty | recipient |
| `change_request` | never | forbidden | OPTIONAL (changing it triggers re-consent, R9) | 0–8 allowed | non-empty | initiator |
| `cancel` | never | forbidden | forbidden | forbidden | MAY be empty | initiator |
| `done` | never | forbidden | forbidden | forbidden | MAY be empty | initiator |
| `needs_human` | never | forbidden | forbidden | forbidden | non-empty | either party (and `tenfour/system`) |

**DECIDED HERE (D10):** `body` MAY be the empty string only for `accepted`,
`cancel`, `done`; all other kinds require ≥ 1 character.

**DECIDED HERE (D11, amended — STATE-MACHINE's closed-question model is normative):**
`in_reply_to` MUST reference an **open** `question` message in the same thread,
authored by the counterparty. Answering a question **closes** it; a second `answer`
to the same question fails with `TENFOUR/UNKNOWN_KIND`
(`data.reason:"invalid_in_reply_to"`). In a question-rooted micro-thread the first
`answer` closes the whole thread, so a later `answer` fails with
`TENFOUR/TERMINAL_THREAD` (the state check precedes the reply check, STATE §3).

**DECIDED HERE (D12):** kinds legal inside a question-rooted micro-thread:
`answer` (responder), `cancel` (initiator), `needs_human` (either). A `question`
sent *into* an existing question-rooted thread is `UNKNOWN_KIND`
(`data.reason:"illegal_in_state"`); follow-ups open a new micro-thread.

### 5.3 Artifacts

```jsonc
{ "type": "git_commit",   "repo": "RepoSlug", "ref": "GitRef", "sha": "Sha" }
{ "type": "git_branch",   "repo": "RepoSlug", "ref": "GitRef", "sha": "Sha" }
{ "type": "pull_request", "repo": "RepoSlug", "number": 42, "url": "https://…" }
```

Rules: `pull_request.url` MUST be `https://`, ≤ 512 chars; `number` is an integer
1–999999999. `ref` is a SHORT ref name (`main`, `feature/tf-31-inbox`), never
`refs/`-prefixed (ARTIFACTS ART-046). Artifact `repo` values MUST pass the pair's
invite-time `repo_allowlist` when one exists (D27, `TENFOUR/REPO_NOT_ALLOWED`);
the receiver's local `allowed_repos` is enforced separately at surface time
(ARTIFACTS §10). The broker NEVER fetches anything. Violations:
`TENFOUR/ARTIFACT_INVALID`.

### 5.4 Size caps (DECIDED HERE, D13 — all normative, all enforced server-side)

| Cap | Value | Error on breach |
|---|---|---|
| `body` UTF-8 bytes (post-NFC) | ≤ 16384 | `BODY_TOO_LARGE` |
| Whole serialized envelope, UTF-8 bytes | ≤ 32768 | `BODY_TOO_LARGE` |
| `artifacts` count | ≤ 8 | `ARTIFACT_INVALID` |
| Serialized `artifacts` array, UTF-8 bytes (post-NFC) | ≤ 8192 | `ARTIFACT_INVALID` (reason `artifacts_too_large` — ART-052) |
| `repo` chars | ≤ 300 | `ARTIFACT_INVALID` (in artifact) / `UNKNOWN_KIND` malformed (envelope field) |
| `ref` chars | ≤ 255 | `ARTIFACT_INVALID` |
| `url` chars | ≤ 512, https only | `ARTIFACT_INVALID` |
| `inbox.limit` | 1–100, default 50 | schema (`UNKNOWN_KIND` malformed_request) |
| `thread.limit` | 1–200, default 200 | schema |
| `diag.ping` `nonce`/`mark` | ≤ 64 chars | schema |
| `holder` | 1–128 chars | schema |
| Cursor | ≤ 256 chars | treated as `null` (§7.2, never an error) |

**Normalization (DECIDED HERE, D14):** senders MUST NFC-normalize `body`. The
broker normalizes defensively (idempotent) before size check, hashing, and
persistence, so non-NFC `body` input is corrected, not rejected. No newline
rewriting. **Artifact string fields are the one exception**: they MUST arrive NFC
and the broker rejects non-NFC artifact strings (`ARTIFACT_INVALID`,
`reason:"not_nfc"` — ARTIFACTS ART-071); artifact bytes are never silently
rewritten because they feed allowlist and dedup comparisons byte-for-byte.

### 5.5 Canonical server-stamped envelope

Every success path that returns a message returns this shape — never a client echo:

```jsonc
{
  "protocol": "tenfour/1",
  "id": "ULID",                    // broker-minted message id
  "client_id": "ULID",             // echoed
  "thread_id": "ULID",             // resolved (minted if the message opened the thread)
  "parent_id": "ULID | null",
  "in_reply_to": "ULID | null",
  "from": "brian/design",          // derived from token; "tenfour/system" for broker posts
  "to": "jonathan/web",            // or the sentinel "thread" on system fan-out posts (D15)
  "kind": "task",
  "repo": "github.com/careswift/web | null",
  "body": "…",
  "artifacts": [ … ],
  "seq": 1,                        // per-thread, starts at 1, +1 per accepted message incl. system posts
  "ts": 1784767200000,             // broker clock, ms epoch, display-only
  "round": 1,                      // thread round AFTER applying this message
  "status": "offered",             // thread status AFTER applying this message
  "delivery_state": "queued",      // current, at response time (R7)
  "consent_token": "b64url | null",// present ONLY on task and scope-expanding change_request (D16)
  "unfroze": false                 // true iff this message resumed a frozen thread (D21; STATE §6.2)
}
```

**DECIDED HERE (D15):** broker (`tenfour/system`) fan-out posts (round-cap
`needs_human`) are ONE message with `to:"thread"` (sentinel) and per-party delivery
records — not two messages.

**DECIDED HERE (D16, amended):** the broker mints a 128-bit base64url
`consent_token` (22 chars, `protocol.ts CONSENT_TOKEN_REGEX`) and stamps it on
every `task` and on every **scope-expanding** `change_request`. The single
normative re-consent predicate is STATE-MACHINE §5 [S]: a `change_request` expands
scope iff (a) it carries ≥ 1 artifact whose (`repo`, `sha`) pair was never
previously referenced in this thread, or (b) it names a `repo` differing from the
thread's declared repo. A scope-expanding `change_request` transitions the thread
`review → offered` (structural re-offer), forcing a fresh gestured `accepted`.
The token is visible to both thread parties; it is only *usable* by the recipient
because `accepted` is role-checked.

---

## 6. Content hash and idempotency (R11 binding)

`client_id` idempotency is bound to a canonical content hash.

**Field set (exactly these nine, DECIDED HERE, D17):**
`artifacts, body, in_reply_to, kind, parent_id, protocol, repo, thread_id, to`.
Excluded by design: `client_id` (the key itself), `auth`, `consent`, `unfreeze`
(authorization metadata, not content).

**Algorithm (DECIDED HERE, D18):**

1. Build an object containing exactly the nine fields. Absent/undefined optional
   fields become `null`. `body` is NFC-normalized first.
2. Serialize to minimal JSON: keys sorted lexicographically (ASCII) at every
   nesting level, no whitespace, arrays in sender order (artifact order is
   significant), string escaping per `JSON.stringify` (RFC 8785-conformant for
   this field set — all values are strings, integers, nulls, arrays, objects; no
   floats exist in the field set). Each artifact object serializes exactly its
   type's defined fields.
3. UTF-8 encode; hash with SHA-256; emit `"sha256:" + lowercase-hex`.

**Test vector (normative — repo in canonical `host/owner/name` form, short ref
per ARTIFACTS ART-046; mirrored in `protocol.ts CONTENT_HASH_TEST_VECTOR`):**

Canonical string (337 UTF-8 bytes):

```
{"artifacts":[{"ref":"main","repo":"github.com/careswift/web","sha":"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3","type":"git_commit"}],"body":"Implement the CareSwift route header per the spec.","in_reply_to":null,"kind":"task","parent_id":null,"protocol":"tenfour/1","repo":"github.com/careswift/web","thread_id":null,"to":"jonathan/web"}
```

Hash: `sha256:dc9473842e268f7482bb462e08ff2a1cf31ae403fec270b263cf3db65958d718`

**Dedup rule:** `(from, client_id)` is unique. A replay whose content hash matches
the original returns the §7.1 duplicate success (R7). A replay whose hash differs
is `TENFOUR/CLIENT_ID_CONFLICT` with `data.{client_id, original_message_id}`. The
adapter persists `prepared(client_id, content_hash) → sending → confirmed` and
reuses the original `client_id` on every retry (R11).

---

## 7. Messaging methods

### 7.1 `send`

Request:

```jsonc
{
  "protocol": "tenfour/1",
  "auth": { "token": "tf1_…" },
  "envelope": { /* §5.1 */ },
  "consent": { "token": "…", "granted_via": "cli_accept" },  // REQUIRED iff kind=accepted (R8); granted_via ∈ cli_accept | standing_rule
  "unfreeze": false                                          // optional boolean; the send-borne unfreeze gesture (B2), §7.1.3
}
```

**Validation precedence (normative order — the FIRST failing check wins;
DECIDED HERE, D19). This 13-step order is IDENTICAL, with the same step numbers,
in STATE-MACHINE.md §3 and AUTH.md §3.4; all steps execute inside one ACID
mutation:**

| # | Check | Error |
|---|---|---|
| 1 | protocol version (request + envelope, must match) | `UNSUPPORTED_VERSION` |
| 2 | token valid / not revoked | `AUTH_FAILED` / `AUTH_REVOKED` |
| 3 | `to` is the sender's paired peer; not `tenfour/*` | `PAIR_FORBIDDEN` |
| 4 | `client_id` dedup: known `(from, client_id)` + same content hash → replay original outcome (duplicate success, stop here); different hash → reject | (success) / `CLIENT_ID_CONFLICT` |
| 5 | rate ceiling (§10) | `RATE_LIMITED` |
| 6 | request + envelope schema: kind recognized, root-legality, kind constraints (§5.2), size caps, artifact shapes/counts/dedup, result sha-pin rule | `UNKNOWN_KIND` / `BODY_TOO_LARGE` / `ARTIFACT_INVALID` |
| 7 | secret scan over `body` + all artifact strings (best-effort DLP) | `SECRET_DETECTED` |
| 8 | thread exists (when `thread_id` set); sender is a thread party | `THREAD_NOT_FOUND` / `NOT_THREAD_PARTY` |
| 9 | state machine: thread not terminal; thread not frozen (unless the send carries `unfreeze:true`, which evaluates the message against `resume_state`, §7.1.3); transition cell exists for (kind × state × role) | `TERMINAL_THREAD` / `THREAD_FROZEN` / `UNKNOWN_KIND` (illegal_in_state, invalid_in_reply_to) / `NOT_THREAD_PARTY` (role_forbidden) — §9.2 |
| 10 | `parent_id` equals current head | `STALE_HEAD` |
| 11 | consent: `accepted` gesture token valid; `result` requires `consent.state="granted"` | `CONSENT_REQUIRED` |
| 12 | `repo` + artifact repos pass the pair's invite-time `repo_allowlist` (when configured, D27) | `REPO_NOT_ALLOWED` |
| 13 | round accounting (atomic with commit) | `ROUND_CAP` |

Ordering rationale (normative, testable): dedup (4) precedes rate (5) so R11
adapter retries can never be rate-limited or double-counted — duplicates consume
no quota. Version (1) precedes auth (2) so `UNSUPPORTED_VERSION` is diagnosable
with stale credentials. Terminal (in 9) precedes head rule (10) so a race loser
gets the more informative error. Duplicate replay (step 4) precedes all
thread-state checks so a crashed-adapter retry returns the original outcome even
if the thread has since moved on.

**Success:**

```jsonc
{
  "ok": true,
  "duplicate": false,
  "note": null,
  "message": { /* §5.5 canonical stamped envelope; delivery_state:"queued" */ },
  "thread": {
    "thread_id": "ULID", "root_kind": "task", "status": "offered",
    "round": 1, "max_rounds": 10, "head_id": "ULID", "head_seq": 1,
    "repo": "github.com/careswift/web", "consent_state": "none"
  }
}
```

**Duplicate success (R7):** identical shape with `duplicate:true`, `note` rendered
from `strings.ts` `SEND_DUPLICATE_NOTE` (the sole source of the bytes), `message` =
the canonical ORIGINAL envelope with its **current** `delivery_state`
(`queued|claimed|injected|acked`), and the thread's current summary. Never an
error, never a bare "already delivered" (R7 forbids it — the note always names the
message id and its current delivery_state).

**Round accounting (normative algorithm):** substantive kinds are
`task, question, answer, result, change_request`. On a substantive send:
`new_round = 1` if the thread has no prior substantive message; else
`round + 1` if sender ≠ last substantive sender; else `round` unchanged. Status
kinds never change the round. If `new_round > max_rounds`: the send is REJECTED
with `ROUND_CAP`, the thread freezes (`frozen_reason:"round_cap"`), and the broker
posts a `tenfour/system` `needs_human` (D15 fan-out) — all in one atomic broker
transaction. `max_rounds` defaults to **10**, clamped **1–12** (founder decision),
fixed per pair at invite issuance (`admin.issueInvite.max_rounds`, §8.2 D27) and
copied onto each thread at creation. A successful unfreeze resets `rounds_used`
to 0 (§7.1.3; STATE §6.2).

#### 7.1.2 Consent lifecycle on the wire (R8/R9)

`consent_state` ∈ `not_required | none | granted | stale | revoked`
(`protocol.ts CONSENT_STATES`). Question micro-threads are always `not_required`
(no consent party). `revoked` is RESERVED for v1.1 and unreachable in v1.

| Event | Effect on thread `consent_state` |
|---|---|
| `task` accepted by broker | `none` (+ token stamped) |
| `accepted` with valid `consent.token` + `granted_via` gesture (legal ONLY in `offered`) | `granted` (scope: whole_thread; broker record `{thread_id, granted_via, scope:"whole_thread", granted_at}`) |
| Scope-expanding `change_request` (STATE §5 [S] predicate, D16) | `stale`; thread transitions `review → offered` (structural re-offer); new token stamped on that message |
| `accepted` echoing a stale/wrong/absent token | `TENFOUR/CONSENT_REQUIRED`, `data.reason:"bad_token"` |
| `result` while `consent_state ≠ granted` | `TENFOUR/CONSENT_REQUIRED`, `data.reason:"consent_not_granted"` |

**DECIDED HERE (D20, amended):** `accepted` is legal ONLY in state `offered`
(grants consent, moves to `in_progress`) — this covers both the initial offer and
every structural re-offer produced by a scope-expanding `change_request`. There is
NO re-grant path inside `in_progress`; re-consent is structural re-offer only
(STATE §5 [S]). Consent revocation (`revoked`) is RESERVED for v1.1: no v1 wire
method or CLI command sets it. Freezing/unfreezing does not touch `consent_state`;
the post-unfreeze re-prompt is receiving-adapter UX doctrine (STATE §6.2), not a
broker consent transition.

#### 7.1.3 Unfreeze (J7 resume) — rides `send` (B2)

**DECIDED HERE (B2 — STATE-MACHINE §6.2 owns this design):** a frozen thread resumes
only via a human-gestured send. On a frozen thread the ONLY legal send carries the
optional boolean `unfreeze: true`. `tenfour approve <thread>` (CLI) sets it; **either**
human party MAY. There is no unfreeze consent record, no control-plane endpoint, and no
MCP tool — unfreeze rides the ordinary `send` plane. On an `unfreeze: true` send the
broker atomically: (a) restores the thread status to the stored `resume_state` (the
pre-freeze status), (b) resets the round counter (`rounds_used := 0`,
`last_substantive_sender := null`), (c) applies this message iff it is legal in
`resume_state`, and (d) stamps the persisted message `unfroze: true`. If the message is
**illegal in `resume_state`** it is rejected by that state's transition cell and the
unfreeze is NOT consumed — the thread stays frozen (a typo must not burn the gesture).
There is no separate unfreeze message kind and no system post on unfreeze — the
gestured message itself is the record. A normal send (`unfreeze` absent or `false`) into
a frozen thread ⇒ `THREAD_FROZEN`. `unfreeze: true` on a non-frozen thread is ignored
(success-shaped).

### 7.2 `inbox`

Request:

```jsonc
{
  "protocol": "tenfour/1",
  "auth": { "token": "tf1_…" },
  "cursor": null,          // string | null — null starts a fresh sweep; any string accepted (D22)
  "limit": 50,             // 1–100
  "mode": "claim",         // "claim" (default) | "peek" (read-only, CLI `tenfour inbox`)
  "holder": "01J1PAVH5N40E3D8QT2W9YRKM3"  // REQUIRED when mode="claim"; 1–128 chars — the session identity (DELIVERY §3)
}
```

Response:

```jsonc
{
  "ok": true,
  "items": [
    {
      "message": { /* §5.5, incl. consent_token on tasks */ },
      "attempt_id": "ULID",          // null in peek mode
      "delivery_state": "claimed",   // "queued" in peek mode
      "prior_attempts": 0,           // >0 ⇒ journal shows the possible-redelivery preamble
      "thread": { "thread_id": "…", "root_kind": "task", "status": "offered",
                  "round": 1, "max_rounds": 10, "repo": "github.com/careswift/web" }
    }
  ],
  "cursor": "opaque-b64url",
  "has_more": false,
  "server_time": 1784767200000
}
```

**Cursor semantics (normative, DECIDED HERE, D22):**

1. The inbox is the set of messages addressed to the caller (including
   `tenfour/system` fan-outs) **not yet acked**, ordered by a per-recipient
   monotonic `arrival` ordinal.
2. `cursor:null` starts from the oldest unacked item. The returned `cursor` is a
   **single-sweep pagination token**, not a durable subscription position: on every
   reconnect / SessionStart the client MUST start again with `cursor:null`. Acked
   messages drop out, so restarts are cheap and nothing can be skipped.
3. `has_more:true` ⇒ call again immediately with the returned cursor.
4. Cursors MAY expire after 1 hour. An expired, malformed, or over-long cursor is
   **not an error**: the broker treats it as `null` and restarts the sweep
   (success-shaped; at-least-once; the local journal dedups re-presentations).
5. Delivery is at-least-once. Exactly-once *presentation* is the journal's job,
   keyed on `(id, attempt_id)`.

**Claim semantics (DECIDED HERE, D23, amended):** `mode:"claim"` atomically stamps
`{attempt_id, holder, claimed_at}` on each returned item whose lease is free.
Lease duration: **5 minutes** (`protocol.ts CLAIM_LEASE_MS`; DELIVERY DEL-04), with
holder auto-renewal per DELIVERY DEL-05. The claim holder IS the session identity
(DELIVERY §3): there is no separate session registration and no session field on
`send`. A claim by a different holder after lease expiry — or by a NEWER holder
under the single-session last-connect-wins rule — mints a new `attempt_id` and
supersedes the old one; `prior_attempts` increments. `ack` referencing an attempt
is accepted from that attempt's holder even after lease expiry, PROVIDED the
attempt has not been superseded; an ack referencing a superseded attempt (a
demoted session's ack) is rejected `TENFOUR/AUTH_FAILED` — this closes the
demoted-session ack-to-suppress channel (DELIVERY §3.2). `peek` never claims,
never mints attempts, never mutates state.

### 7.3 `ack`

Ack = **model-received** (R2). Nothing more. Recipient-only. Idempotent.

Request:

```jsonc
{
  "protocol": "tenfour/1",
  "auth": { "token": "tf1_…" },
  "message_id": "ULID",
  "attempt_id": "ULID",
  "state": "acked"          // "injected" | "acked"; default "acked" (D24)
}
```

**Two-phase ack (DECIDED HERE, D24):** the journal states
`received → injected → ack_pending → acked` project onto the broker as
`claimed → injected → acked`. `state:"injected"` records that the message entered
model context (non-final; still redeliverable); `state:"acked"` is final.
Transitions are monotonic: `injected` after `acked` is a success-shaped duplicate;
`acked` never downgrades.

Response:

```jsonc
{ "ok": true, "message_id": "ULID", "delivery_state": "acked",
  "duplicate": false, "note": "…" }   // note bytes: strings.ts ACK_OK_NOTE
```

Repeat ack: `duplicate:true`, `note` from `strings.ts` `ACK_DUPLICATE_NOTE` —
never an error (success-shaped idempotency, JOURNEYS §4). `attempt_id` is
REQUIRED: claim-before-ack is the rule (D23); there is no ack of a never-claimed
row. Errors: unknown `message_id` ⇒ `THREAD_NOT_FOUND` with
`data.reason:"message_not_found"` (**DECIDED HERE, D25** — the registry is closed;
no separate message-not-found code); caller not the message's recipient ⇒
`NOT_THREAD_PARTY`; unknown `attempt_id` for that message ⇒ `UNKNOWN_KIND`
`data.reason:"malformed_request"`; superseded `attempt_id` from a demoted holder ⇒
`AUTH_FAILED` (D23; DELIVERY §3.2).

### 7.4 `thread`

Request:

```jsonc
{ "protocol": "tenfour/1", "auth": { "token": "tf1_…" },
  "thread_id": "ULID", "after_seq": 0, "limit": 200 }
```

Response:

```jsonc
{
  "ok": true,
  "thread": {
    "thread_id": "ULID", "root_kind": "task",
    "initiator": "brian/design", "recipient": "jonathan/web",
    "status": "in_progress", "resume_state": null,      // set while frozen
    "frozen_reason": null,                               // "round_cap" | "needs_human" | null
    "frozen_by": null,                                   // agent name | "tenfour/system" | null
    "round": 3, "max_rounds": 10,
    "head_id": "ULID", "head_seq": 7,
    "repo": "github.com/careswift/web",
    "consent": { "state": "granted", "granted_at": 1784767300000,
                 "granted_via": "cli_accept", "scope": "whole_thread" },
    "created_at": 1784767200000, "updated_at": 1784767300000
  },
  "messages": [ /* §5.5 envelopes, seq ascending, seq > after_seq, ≤ limit */ ],
  "has_more": false
}
```

Party-only read: any caller who is neither `initiator` nor `recipient` gets
`NOT_THREAD_PARTY`. Each returned message carries its current `delivery_state`, so
a sender sees "sent 3d ago, unacked" without a presence system. `diag.ping`
traffic never appears here (R6).

---

## 8. Diagnostic and identity methods

### 8.1 `diag.ping`

Authenticated broker diagnostic. NOT a thread; excluded from threads, rounds,
inbox, and retention (R6) — but NOT rate-exempt (§10: hard 30/60 s ceiling).
Used by `tenfour doctor` and by `tenfour join`'s final celebration step (there is
no `hello` command in the R12 manifest). Accepts agent bearer tokens only
(`protocol.ts DiagPingRequestSchema`; AUTH READ-6).

Request:

```jsonc
{ "protocol": "tenfour/1", "auth": { "token": "tf1_…" },
  "nonce": "d0ctor-7",     // optional, ≤ 64 chars, echoed verbatim
  "mark": "hello" }        // optional, ≤ 64 chars — presence beacon (D26)
```

Response:

```jsonc
{
  "ok": true, "pong": true, "nonce": "d0ctor-7",
  "agent": "brian/design",
  "server_time": 1784767200000,
  "protocol_versions": ["tenfour/1"],
  "broker_version": "0.1.0",
  "peer": { "agent": "jonathan/web", "last_ping_ts": 1784767100000,
            "last_mark": "hello" }   // null if the peer has never pinged in the TTL window
}
```

**DECIDED HERE (D26, amended):** `mark` writes an ephemeral presence record
`{agent, ts, mark}` with a **24-hour TTL**, readable only by the paired peer via
the `peer` field (AUTH READ-6 permits exactly this disclosure, for the paired
peer ONLY). Mark-bearing pings are audited (AUTH §13); the record itself rides
retention-exempt — an accepted risk documented in ADVERSARIAL-MATRIX A11. The
celebration moment: `tenfour join`'s final step pings with `mark:"hello"`; the
owner side sees `peer.last_mark == "hello"` via `tenfour doctor` / `tenfour
status` (each of which may poll ≤ 1/min). No thread, no carve-out, no inbox
traffic — same celebration UX as the old `purpose:"hello"` design, with no
dedicated command.

### 8.2 `admin.issueInvite`

Broker-owner only (Brian's flow). Mints a single-use invite binding an agent name.

Request (**DECIDED HERE, D27** — pair policy is fixed at issuance):

```jsonc
{
  "protocol": "tenfour/1",
  "admin_key": "tfadmin_…",
  "agent": "jonathan/web",
  "ttl_s": 86400,                  // default 86400; clamp 300–604800
  "max_rounds": 10,                // default 10; clamp 1–12 (founder decision)
  "repo_allowlist": ["github.com/careswift/web"],  // optional, ≤ 64 slugs; ABSENT ⇒ any repo allowed (doctor warns)
  "note": "jonathan's PC"          // optional, ≤ 256, admin bookkeeping only
}
```

Response:

```jsonc
{ "ok": true,
  "invite": { "invite_id": "ULID",
              "code": "TENFOUR1.<payload>.<check>",
              "agent": "jonathan/web",
              "expires_at": 1784853600000,
              "max_rounds": 10,
              "repo_allowlist": ["github.com/careswift/web"] } }
```

Errors: bad admin key ⇒ `AUTH_FAILED`; agent name already active ⇒
`INVITE_INVALID` (**DECIDED HERE, D28**) — this ISSUANCE-path error carries no
`data.reason` (like all INVITE_INVALID bodies, §8.4) but its `human_action`
(strings.ts) tells the authenticated admin to rotate the existing agent's token
instead; the redemption-path anti-oracle rule does not apply to the admin-key
holder. Re-issuing while a live unredeemed invite exists for the same agent
supersedes the older invite (newest wins — D28; AUTH INV-10).

### 8.3 Invite code format (DECIDED HERE, D29)

```
TENFOUR1.<payload_b64url>.<check_b64url>
```

- `payload` = base64url (unpadded) of the minimal JSON
  `{"agent":"jonathan/web","broker_url":"https://…","exp":1784853600000,"invite_id":"ULID","secret":"<43-char b64url, 256-bit>","v":1}`
  (keys sorted, no whitespace; `broker_url` ≤ 300 chars).
- `check` = base64url (unpadded, 6 chars) of the FIRST 4 BYTES of
  `sha256(payload_b64url_string_as_utf8)`.
- Whole code ≤ 1024 chars, regex `^TENFOUR1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6}$`.
- Clients MUST verify `check` locally BEFORE any network call (paste-mangling
  defense; powers the "joining as X to Y — correct?" prompt).
- Broker stores only `sha256(secret)`. The code is the credential; single-use.

### 8.4 `invite.redeem`

No bearer auth — the code authenticates. Transitions the invite
`invited → active`, mints the agent's bearer token, and completes the 1:1 pair.

Request:

```jsonc
{ "protocol": "tenfour/1",
  "code": "TENFOUR1.…",
  "client_info": { "platform": "win32",         // "darwin" | "win32" | "linux" | "wsl"
                   "hostname": "JONATHAN-PC",   // optional, ≤ 253
                   "adapter_version": "0.1.0" } }
```

Response:

```jsonc
{
  "ok": true,
  "agent": "jonathan/web",
  "token": "tf1_…",                 // shown once; store 0600 / icacls
  "token_id": "ULID",
  "pair": { "peer": "brian/design", "max_rounds": 10 },
  "broker": { "protocol_versions": ["tenfour/1"], "server_time": 1784767200000 },
  "covenant": "…"                   // bytes owned by strings.ts COVENANT_LINE
}
```

Errors: unknown code / checksum fail / already redeemed / revoked / superseded /
malformed / locked out ⇒ `INVITE_INVALID` with a **byte-identical body across all
causes** — NO `data.reason`, no oracle on which field was wrong (AUTH INV-6 is
normative here). Only expiry is distinguishable: past `exp` (otherwise valid) ⇒
`INVITE_EXPIRED`. **DECIDED HERE (D30):** 5 failed redemption attempts permanently
invalidate a code; subsequent attempts return the same uniform `INVITE_INVALID`.

---

## 9. Errors

### 9.1 Error shape (uniform, all methods)

```jsonc
{
  "ok": false,
  "error": {
    "code": "TENFOUR/STALE_HEAD",       // always "TENFOUR/<CODE>"
    "message": "what happened AND what is true now (≤ 4000 chars)",
    "human_action": "the ONE action to take instead (≤ 1000 chars)",
    "retryable": false,                  // literal false on EVERY protocol error
    "data": { }                          // code-specific, per §9.3; optional
  }
}
```

`retryable` is the literal `false` on all 20 codes — protocol errors tell the
model to stop and inform its human, never to retry. (Transport failures, which MAY
be retried by the adapter, are not protocol errors and never use this shape.)
All `message`/`human_action` bytes live in `packages/adapter/src/strings.ts`
(`ERRORS.<CODE>.what/.now/.instead`, rendered by `toWireError`) — the SINGLE
source of truth, snapshot-tested. This file cites keys, never bytes.

### 9.2 State-machine error mapping (DECIDED HERE, D31)

The registry is closed at 20 codes, so every illegal kind × state × role cell in
the state table maps by this rule, checked in order:

| Condition | Code | `data.reason` |
|---|---|---|
| Thread status is terminal (`closed`) | `TERMINAL_THREAD` | — |
| Thread status is `frozen` (and the send did not carry `unfreeze:true`) | `THREAD_FROZEN` | — |
| Kind needs consent that isn't granted (§7.1.2) | `CONSENT_REQUIRED` | `consent_not_granted` \| `bad_token` |
| Kind is legal in this state for the OTHER party only | `NOT_THREAD_PARTY` | `role_forbidden` |
| Kind is recognized but legal for NOBODY in this state | `UNKNOWN_KIND` | `illegal_in_state` (+ `data.legal_kinds`) |

`UNKNOWN_KIND` is defined broadly and precisely as: **"the request or envelope
does not validate as any known tenfour/1 form in the current context."**
`data.reason` disambiguates (single merged enum, `protocol.ts
UNKNOWN_KIND_REASONS`, shared verbatim with STATE-MACHINE §2): `unrecognized_kind`
(kind string unknown), `malformed_for_kind` (violates §5.2), `malformed_request`
(method request fails schema), `illegal_in_state` (valid form, no role may send it
in this state), `cannot_root_thread` (`thread_id:null` with a kind other than
`task`/`question`), `invalid_in_reply_to` (`answer` whose `in_reply_to` is
missing, wrong-thread, not a question, already answered, or self-authored).
Role mismatches are NEVER `UNKNOWN_KIND`: a kind legal in this state for the
other party only maps to `NOT_THREAD_PARTY` (`role_forbidden`), per the table
above.

### 9.3 Canonical error registry (complete — exactly these 20)

The `human_action` column names the `strings.ts` key that owns the bytes
(`ERRORS.<CODE>.instead`); this table never quotes them.

| Code (`TENFOUR/…`) | Trigger | Required `data` fields | `human_action` source |
|---|---|---|---|
| `STALE_HEAD` | `parent_id` ≠ current thread head | `thread_id`, `head_id`, `head_seq` | `ERRORS.STALE_HEAD.instead` |
| `TERMINAL_THREAD` | send into a `closed` thread | `thread_id`, `closed_reason` | `ERRORS.TERMINAL_THREAD.instead` |
| `THREAD_FROZEN` | send into a `frozen` thread without `unfreeze:true` (§7.1.3) | `thread_id`, `frozen_reason` | `ERRORS.THREAD_FROZEN.instead` |
| `ROUND_CAP` | substantive send would exceed `max_rounds`; thread freezes atomically | `thread_id`, `round`, `max_rounds` | `ERRORS.ROUND_CAP.instead` |
| `RATE_LIMITED` | per-token ceiling breached (§10) | `method`, `limit`, `window_s`, `oldest_expires_in_s` (informational, for the human) | `ERRORS.RATE_LIMITED.instead` |
| `BODY_TOO_LARGE` | body > 16384 B or envelope > 32768 B | `limit_bytes`, `actual_bytes`, `field` | `ERRORS.BODY_TOO_LARGE.instead` |
| `SECRET_DETECTED` | DLP regex hit in body or artifact strings | `detector_id`, `field` (never the match) | `ERRORS.SECRET_DETECTED.instead` |
| `THREAD_NOT_FOUND` | unknown `thread_id` (or unknown `message_id` on ack) | `thread_id` or `message_id`, `reason` | `ERRORS.THREAD_NOT_FOUND.instead` |
| `AUTH_FAILED` | unknown token / bad admin key / demoted-holder ack (D23) | — | `ERRORS.AUTH_FAILED.instead` |
| `AUTH_REVOKED` | token exists but was revoked | — | `ERRORS.AUTH_REVOKED.instead` |
| `CLIENT_ID_CONFLICT` | reused `client_id`, different content hash | `client_id`, `original_message_id` | `ERRORS.CLIENT_ID_CONFLICT.instead` |
| `PAIR_FORBIDDEN` | `to` is not the caller's paired peer, or is `tenfour/*` | `to` | `ERRORS.PAIR_FORBIDDEN.instead` |
| `REPO_NOT_ALLOWED` | `repo`/artifact repo not in the pair's invite-time `repo_allowlist` (D27) | `repo`, `allowlist` | `ERRORS.REPO_NOT_ALLOWED.instead` |
| `UNSUPPORTED_VERSION` | unknown `protocol`, or request/envelope mismatch | `supported` | `ERRORS.UNSUPPORTED_VERSION.instead` |
| `UNKNOWN_KIND` | §9.2 broad definition | `reason` (+ `state`, `kind`, `legal_kinds` when `illegal_in_state`) | `ERRORS.UNKNOWN_KIND.instead` |
| `CONSENT_REQUIRED` | §7.1.2 (`accepted`/`result` consent gate) | `thread_id`, `reason` | `ERRORS.CONSENT_REQUIRED.instead` |
| `ARTIFACT_INVALID` | artifact schema/count/pin violations | `index`, `reason` | `ERRORS.ARTIFACT_INVALID.instead` |
| `NOT_THREAD_PARTY` | caller not a party; or party using a kind reserved to the other role | `thread_id`, `reason` (`not_party` \| `role_forbidden`) | `ERRORS.NOT_THREAD_PARTY.instead` |
| `INVITE_INVALID` | unknown/checksum/redeemed/revoked/superseded/malformed/lockout — byte-identical body, NO `data.reason` (§8.4) | — | `ERRORS.INVITE_INVALID.instead` |
| `INVITE_EXPIRED` | invite past `exp` | `expired_at` | `ERRORS.INVITE_EXPIRED.instead` |

### 9.4 Delivery-state machine (per message × recipient)

| From | Event | To |
|---|---|---|
| — | send committed | `queued` |
| `queued` | `inbox` mode=claim | `claimed` |
| `claimed` | lease expiry (5 min, D23) / holder supersession | `queued`, then re-claimable (next claim mints a new `attempt_id`, `prior_attempts`+1) |
| `claimed` | `ack state:"injected"` | `injected` |
| `claimed`/`injected` | `ack state:"acked"` | `acked` (final) |
| `acked` | anything | `acked` (duplicates success-shaped) |

Claim-before-ack is the rule: `attempt_id` is REQUIRED on every `ack`, so a
never-claimed (`queued`) row cannot be acked — every injection path claims first
(the SessionStart digest path included; peek never yields an ackable attempt).

---

## 10. Rate ceilings (DECIDED HERE, D32)

Per token, rolling windows, enforced broker-side; breach ⇒ `RATE_LIMITED`
(retryable:false — the model stops; the human decides):

| Method | Limit |
|---|---|
| `send` | 12 / 60 s AND 120 / 3600 s |
| `ack` | 120 / 60 s |
| `inbox` | 60 / 60 s |
| `thread` | 60 / 60 s |
| `diag.ping` | 30 / 60 s |
| `admin.issueInvite` | 10 / 3600 s per admin key |
| `invite.redeem` | 5 failed attempts per code, then lockout (D30) |

These ceilings are loop-containment backstops above the round cap, not capacity
planning. Brokers MAY lower them per deployment; they MUST NOT raise the `send`
ceiling above 2× these values while calling themselves conforming. This section
and `protocol.ts RATE_LIMITS` are the SOLE owners of rate truth; STATE-MACHINE §9
specifies the sliding-log algorithm with exactly these numbers. Status kinds
count toward the `send` ceiling; `diag.ping` is NOT rate-exempt (its 30/60 s
ceiling above is normative).

---

## 11. Conformance checklist (what the fixture suite asserts)

1. Every request/response round-trips through the Zod schemas in
   `packages/schema/src/protocol.ts` (`ok:true` and `ok:false` variants).
2. The §6 test vector hashes to the published value on every platform in CI
   (macOS/Windows/Ubuntu — Node `TextEncoder` + SHA-256).
3. Validation precedence (§7.1) is observable: a request violating steps 6 and 10
   simultaneously returns the step-6 error.
4. Duplicate `send` and duplicate `ack` return `ok:true` with `duplicate:true` —
   asserted to NEVER be `ok:false`.
5. All 20 error codes are producible by fixtures; no other code string ever
   appears on the wire; every error has `retryable:false`.
6. `diag.ping` traffic never appears in `inbox` or `thread` output.
7. A `ROUND_CAP` rejection and its system `needs_human` fan-out commit atomically
   (crash between them is unobservable).
