# tenfour/1 — Thread State Machine, Rounds, and Rate Limits (NORMATIVE)

**Status:** Normative specification for protocol `tenfour/1`. Written under the R13
phase gate (DESIGN.md §11): this document, not DESIGN.md §4.3's summary, is the
authority on transitions. Where DESIGN.md prose and this table differ, this table wins.
**Conformance language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119 / RFC 8174.
**Error wire format:** every rejection in this document is `TENFOUR/<CODE>` drawn from
the canonical registry (§10). All rejections carry `retryable: false` (DESIGN §4.1:
protocol errors tell the model to stop and inform its human, never to retry).
**Companion specs:** wire schemas (envelope/Zod), identity & pairing, delivery states.
This document owns: thread states, the transition table, round counting, rate limits.

---

## 1. Definitions

### 1.1 Thread classes

| Class | Rooted by | Created when |
|---|---|---|
| **Task thread** | `kind: task`, `thread_id: null` | Broker mints `thread_id`, stamps `repo` from the envelope's first-class `repo` field (R10) |
| **Question micro-thread** | `kind: question`, `thread_id: null` (R3) | Broker mints `thread_id`; no `repo` field |

No other kind MAY root a thread (§4). Micro-threads are standalone: they MUST NOT
affect any task thread's state, head, or round counter. (An optional `parent_thread`
linkage field is reserved for v1.1 and has no semantics in `tenfour/1`.)

### 1.2 State enums

**DECIDED HERE:** the exact state enums are:

| Thread class | States |
|---|---|
| Task thread | `offered`, `in_progress`, `review`, `frozen`, `closed` |
| Question micro-thread | `open`, `frozen`, `closed` |

(The micro-thread open state's wire literal is **`open`** — `protocol.ts
THREAD_STATUSES` / WIRE §3 D6 own the literal; `open` is exclusive to
question-rooted micro-threads.)

- `closed` is the **only terminal state**. The broker MUST record `closed_reason ∈
  {done, declined, cancelled, answered}` on entry.
- `frozen` is a real state, not a flag. On entry the broker MUST record
  `resume_state ∈ {offered, in_progress, review, open}` (the state at freeze time),
  `frozen_by` (agent name or `tenfour/system`; surfaced on the `thread` response,
  WIRE §7.4), and `frozen_reason ∈ {needs_human, round_cap}` (wire field name,
  `protocol.ts FROZEN_REASONS`). Frozen is NOT terminal; see §6.
- There are no hidden states. Every non-root state has at least one inbound transition
  (invariant I1, §11).

### 1.3 Sender roles

**DECIDED HERE:** roles are fixed at thread creation and never change:

| Role | Definition |
|---|---|
| `initiator` | The agent that sent the root message (`from` of the root envelope) |
| `owner` | The agent the root message was addressed to (`to` of the root envelope) |
| `system` | The broker principal `tenfour/system` (first-class identity, DESIGN §4.4) |

"Ownership transfer" on `accepted` (DESIGN §4.2) is a description of *work
responsibility*, not of the role column: the addressee is called `owner` in this table
from thread creation onward, including in `offered`, so every cell is static and
testable. Any authenticated agent that is neither `initiator` nor `owner` of a thread
is rejected with `TENFOUR/NOT_THREAD_PARTY` before the table is consulted (§3 step 8).
In micro-threads, `initiator` = the asker, `owner` = the party asked.

### 1.4 Kind classification

| Class | Kinds | Round effect (§8) | Rate effect (§9) |
|---|---|---|---|
| **Substantive** | `task`, `question`, `answer`, `result`, `change_request` | Count via sender alternation | Count |
| **Status** | `accepted`, `declined`, `cancel`, `done`, `needs_human` | Never count | Count |

### 1.5 Head, `parent_id`, `in_reply_to`

- **Head rule** (DESIGN §4.4): `parent_id` MUST equal the thread's current head;
  mismatch → `TENFOUR/STALE_HEAD` carrying the current head. The head advances if and
  only if a message is persisted (invariant I4).
- **`in_reply_to`** (R4) is a semantic pointer, distinct from `parent_id`. It is
  REQUIRED on `answer` and MUST name an *open* `question` message (a) in the same
  thread, (b) authored by the counterparty. It has no meaning on other kinds and the
  wire schema forbids it there.

### 1.6 Consent records

Per R8/R9, two distinct broker record kinds exist:

- **Accept consent** — the wire-visible record (`protocol.ts ConsentRecordSchema`):
  `{state, granted_at, granted_via, scope}` with `granted_via ∈ {cli_accept,
  mcp_confirm, standing_rule}` (`protocol.ts GRANTED_VIA`), `granted_at` an integer
  ms-epoch broker timestamp, and `scope: "whole_thread"`. Created ONLY by a
  gestured `kind:accepted` send carrying the `consent {token, granted_via}` block
  (WIRE §7.1; gestures: `tenfour accept <thread>`, the MCP `tenfour_confirm`
  tool, or a standing rule). Required for the `accepted` transition (§5,
  footnote C). The derived `consent_state` enum is `protocol.ts CONSENT_STATES`
  = `{not_required, none, granted, stale, revoked}` (`revoked` reserved v1.1).
- **Unfreeze consent** — a broker-internal, single-use record identified by a ULID
  (the `consent_ref` a subsequent `send` carries, WIRE §7.1.3): created by
  `tenfour approve <thread>` (or the MCP `tenfour_confirm` gesture), by **either**
  human party. **DECIDED HERE:** unfreeze consent is single-use and expires 24 h
  after grant. Required to move a `frozen` thread (§6).
- Consent revocation is **RESERVED for v1.1** (WIRE D20): no v1 wire method or CLI
  command sets `revoked`. A receiving human who wants work to stop uses the
  ordinary `needs_human → frozen` cell; no consent-record mutation occurs.

---

## 2. Non-transition rejections and where they fire

The state table (§4–§5) is only consulted after envelope-level checks pass. §3 defines
the exact order. Two rules that shape everything below:

1. **Duplicates are never errors** (R7, JOURNEYS §4): a `send` whose `client_id` was
   already accepted from this sender with the same content hash returns the canonical
   original envelope plus its current `delivery_state`
   (`queued|claimed|injected|acked`), HTTP-success-shaped. It does not touch thread
   state, the head, rounds, or the rate window. Same `client_id`, different content
   hash → `TENFOUR/CLIENT_ID_CONFLICT`.
2. **DECIDED HERE — `UNKNOWN_KIND` is the uniform "no such transition" code.** The
   canonical registry is frozen (20 codes, no additions), and it contains no generic
   ILLEGAL_TRANSITION code. This spec therefore defines `TENFOUR/UNKNOWN_KIND` as "the
   `tenfour/1` state machine defines no transition for this envelope", with a
   REQUIRED machine-readable `reason` field drawn from the single merged enum
   `protocol.ts UNKNOWN_KIND_REASONS` (shared verbatim with WIRE §9.2):

   | `reason` | Meaning |
   |---|---|
   | `unrecognized_kind` | `kind` is not one of the ten kinds |
   | `malformed_for_kind` | envelope violates its kind's constraint row (WIRE §5.2) |
   | `malformed_request` | the method request fails schema validation |
   | `cannot_root_thread` | `thread_id: null` with a kind other than `task`/`question` |
   | `illegal_in_state` | no role may send this kind in the current state |
   | `invalid_in_reply_to` | `answer` whose `in_reply_to` fails §1.5 (missing, wrong thread, not a question, already answered, self-authored) |

   **Role mismatches are NOT `UNKNOWN_KIND`.** When some role may send the kind in
   the current state but not the sender's role, the rejection is
   `TENFOUR/NOT_THREAD_PARTY` with `reason: "role_forbidden"` (WIRE §9.2 D31).
   Reason selection is deterministic: if no role has a transition for (kind, state) →
   `UNKNOWN_KIND (illegal_in_state)`; otherwise → `NOT_THREAD_PARTY
   (role_forbidden)`. The `illegal_in_state` payload MUST carry `state`, `kind`, and
   `legal_kinds[]` (the kinds the *sender's role* may send in the current state), so
   the model can recover without guessing.

---

## 3. Send-path validation order (normative)

A conforming broker MUST evaluate an inbound `send` in exactly this order and MUST
reject at the first failing step. All steps execute inside one ACID mutation (§8.4).
**This 13-step order is IDENTICAL, with the same step numbers, in WIRE §7.1 D19 and
AUTH §3.4.**

| # | Check | Rejection |
|---|---|---|
| 1 | `protocol` is a supported version (request + envelope, must match) | `TENFOUR/UNSUPPORTED_VERSION` |
| 2 | Bearer token valid / not revoked | `TENFOUR/AUTH_FAILED` / `TENFOUR/AUTH_REVOKED` |
| 3 | `to` is the sender's paired peer; not `tenfour/*` | `TENFOUR/PAIR_FORBIDDEN` |
| 4 | `client_id` dedup: seen + same hash → **return canonical envelope + `delivery_state` (success, stop here)**; seen + different hash → reject | `TENFOUR/CLIENT_ID_CONFLICT` |
| 5 | Rate window (§9, WIRE §10 numbers) | `TENFOUR/RATE_LIMITED` |
| 6 | Schema/caps: `kind` in vocabulary; root-legality if `thread_id: null`; kind constraint row (WIRE §5.2); body ≤ 16 KB NFC; envelope ≤ 32 KB; artifact shapes/counts/dedup; result sha-pin rule | `TENFOUR/UNKNOWN_KIND` (`unrecognized_kind` / `cannot_root_thread` / `malformed_for_kind` / `malformed_request`) / `TENFOUR/BODY_TOO_LARGE` / `TENFOUR/ARTIFACT_INVALID` |
| 7 | Best-effort DLP scan (body + artifact strings) | `TENFOUR/SECRET_DETECTED` |
| 8 | Thread existence/party: `thread_id` unknown → `THREAD_NOT_FOUND`; sender not a party → `NOT_THREAD_PARTY` (`not_party`) | as listed, `TENFOUR/…` |
| 9 | State machine: thread not `closed` → else `TERMINAL_THREAD`; thread not `frozen` — unless a valid `consent_ref` is attached, in which case steps 9–13 evaluate against `resume_state` (§6); attached but invalid/expired/used ref → `CONSENT_REQUIRED`; transition cell exists for (kind × state × role) in §4/§5 | `TENFOUR/TERMINAL_THREAD` / `TENFOUR/THREAD_FROZEN` / `TENFOUR/UNKNOWN_KIND` (`illegal_in_state` / `invalid_in_reply_to`) / `TENFOUR/NOT_THREAD_PARTY` (`role_forbidden`) |
| 10 | `parent_id` equals current head (error carries current head) | `TENFOUR/STALE_HEAD` |
| 11 | Consent: `accepted` carries a valid `consent {token, granted_via}` gesture block → else `CONSENT_REQUIRED` (`bad_token`); `result` requires `consent_state: granted` → else `CONSENT_REQUIRED` (`consent_not_granted`) | `TENFOUR/CONSENT_REQUIRED` |
| 12 | Artifact/task `repo` in the pair's invite-time `repo_allowlist` (when configured, WIRE D27) | `TENFOUR/REPO_NOT_ALLOWED` |
| 13 | Round admission (§8): would this substantive send exceed `max_rounds`? On breach: reject, append system `needs_human`, freeze — atomically | `TENFOUR/ROUND_CAP` |

**DECIDED HERE (ordering rationale, testable):** dedup (4) precedes rate (5) so that
R11 adapter retries can never be rate-limited or double-counted; duplicates consume no
quota. Version (1) precedes auth (2) so `UNSUPPORTED_VERSION` is diagnosable with
stale credentials. Terminal (in 9) precedes stale-head (10) so a race loser gets the
more informative error (§7). `INVITE_INVALID` / `INVITE_EXPIRED` never occur on the
send path; they belong to the pairing flow (identity spec) and are listed here only so
the registry cross-reference in §10 is total.

---

## 4. Root-creation table (`thread_id: null`)

Sender is by definition the `initiator`. `system` MUST NOT root threads.

| kind | Outcome |
|---|---|
| `task` | Create task thread → `offered`. Envelope MUST carry first-class `repo` (R10; absence is a wire-schema rejection upstream of this table). `repo` not in the pair's invite-time `repo_allowlist` (WIRE D27) → `TENFOUR/REPO_NOT_ALLOWED`. Recipient not paired → `TENFOUR/PAIR_FORBIDDEN`. |
| `question` | Create question micro-thread → `open` (R3). Recipient not paired → `TENFOUR/PAIR_FORBIDDEN`. |
| `answer`, `accepted`, `declined`, `result`, `change_request`, `cancel`, `done`, `needs_human` | `TENFOUR/UNKNOWN_KIND` (`cannot_root_thread`) |

---

## 5. Transition tables

Cell notation: `→ state` = message persisted, head advances, thread enters *state*
(self-loops like `→ in_progress` from `in_progress` are persisted messages that leave
state unchanged). Everything else is a rejection: nothing persists, head does not move.
**Cell ID convention** for the table-driven conformance suite:
`<class>.<state>.<kind>.<role>`, e.g. `task.offered.accepted.owner`.

Roles: **I** = initiator, **O** = owner, **SYS** = `tenfour/system`.
`U(x)` = `TENFOUR/UNKNOWN_KIND` with `reason: x` (see §2).
`NTP(role_forbidden)` = `TENFOUR/NOT_THREAD_PARTY` with `reason: role_forbidden`
(the kind is legal here for the OTHER party only — WIRE §9.2 D31).
`✗SYS` = a conforming broker MUST NOT emit this (system emits `needs_human` only —
**DECIDED HERE**); a table-driven implementation MUST treat the cell as unreachable and
its test MUST assert the broker never produces it.

### 5.1 Task threads (10 kinds × 5 states × 3 roles — complete)

| kind | state | I | O | SYS |
|---|---|---|---|---|
| `task` | `offered` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `task` | `in_progress` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `task` | `review` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `task` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `task` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `question` | `offered` | → `offered` [Q] | → `offered` [Q] | ✗SYS |
| `question` | `in_progress` | → `in_progress` [Q] | → `in_progress` [Q] | ✗SYS |
| `question` | `review` | → `review` [Q] | → `review` [Q] | ✗SYS |
| `question` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `question` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `answer` | `offered` | → `offered` [A] | → `offered` [A] | ✗SYS |
| `answer` | `in_progress` | → `in_progress` [A] | → `in_progress` [A] | ✗SYS |
| `answer` | `review` | → `review` [A] | → `review` [A] | ✗SYS |
| `answer` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `answer` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `accepted` | `offered` | NTP(role_forbidden) | → `in_progress` [C] | ✗SYS |
| `accepted` | `in_progress` | U(illegal_in_state) | U(illegal_in_state) [D] | ✗SYS |
| `accepted` | `review` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `accepted` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `accepted` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `declined` | `offered` | NTP(role_forbidden) | → `closed(declined)` | ✗SYS |
| `declined` | `in_progress` | U(illegal_in_state) | U(illegal_in_state) [G] | ✗SYS |
| `declined` | `review` | U(illegal_in_state) | U(illegal_in_state) [G] | ✗SYS |
| `declined` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `declined` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `result` | `offered` | U(illegal_in_state) | U(illegal_in_state) [H] | ✗SYS |
| `result` | `in_progress` | NTP(role_forbidden) | → `review` [R] | ✗SYS |
| `result` | `review` | NTP(role_forbidden) | → `review` [R][E] | ✗SYS |
| `result` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `result` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `change_request` | `offered` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `change_request` | `in_progress` | U(illegal_in_state) [J] | U(illegal_in_state) | ✗SYS |
| `change_request` | `review` | → `in_progress`, or → `offered` on scope expansion [S] | NTP(role_forbidden) | ✗SYS |
| `change_request` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `change_request` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `cancel` | `offered` | → `closed(cancelled)` | NTP(role_forbidden) [K] | ✗SYS |
| `cancel` | `in_progress` | → `closed(cancelled)` | NTP(role_forbidden) [K] | ✗SYS |
| `cancel` | `review` | → `closed(cancelled)` | NTP(role_forbidden) [K] | ✗SYS |
| `cancel` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `cancel` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `done` | `offered` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `done` | `in_progress` | U(illegal_in_state) [L] | U(illegal_in_state) | ✗SYS |
| `done` | `review` | → `closed(done)` | NTP(role_forbidden) | ✗SYS |
| `done` | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| `done` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |
| `needs_human` | `offered` | → `frozen(resume=offered)` | → `frozen(resume=offered)` | → `frozen` [Y] |
| `needs_human` | `in_progress` | → `frozen(resume=in_progress)` | → `frozen(resume=in_progress)` | → `frozen` [Y] |
| `needs_human` | `review` | → `frozen(resume=review)` | → `frozen(resume=review)` | → `frozen` [Y] |
| `needs_human` | `frozen` | `THREAD_FROZEN` [M] | `THREAD_FROZEN` [M] | ✗SYS [M] |
| `needs_human` | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |

### 5.2 Question micro-threads (10 kinds × 3 states × 3 roles — complete)

| kind | state | I (asker) | O (asked) | SYS |
|---|---|---|---|---|
| `task` | `open` | U(illegal_in_state) [N] | U(illegal_in_state) [N] | ✗SYS |
| `question` | `open` | U(illegal_in_state) [P] | U(illegal_in_state) [P] | ✗SYS |
| `answer` | `open` | NTP(role_forbidden) | → `closed(answered)` [A2] | ✗SYS |
| `accepted` | `open` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `declined` | `open` | U(illegal_in_state) | U(illegal_in_state) [G2] | ✗SYS |
| `result` | `open` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `change_request` | `open` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `cancel` | `open` | → `closed(cancelled)` | NTP(role_forbidden) | ✗SYS |
| `done` | `open` | U(illegal_in_state) | U(illegal_in_state) | ✗SYS |
| `needs_human` | `open` | → `frozen(resume=open)` | → `frozen(resume=open)` | → `frozen` [Y] |
| *(every kind)* | `frozen` | `THREAD_FROZEN` [F] | `THREAD_FROZEN` [F] | ✗SYS |
| *(every kind)* | `closed` | `TERMINAL_THREAD` | `TERMINAL_THREAD` | ✗SYS |

The two collapsed rows expand to all ten kinds; the conformance suite MUST enumerate
them individually (`q.frozen.<kind>.<role>`, `q.closed.<kind>.<role>`).

### 5.3 Footnotes (normative conditions)

- **[Q]** Opens an in-thread question (recorded in the thread's open-question set).
  **DECIDED HERE:** in-thread questions never change task-thread state; they advance
  the head and count toward rounds (substantive). Multiple questions MAY be open
  concurrently, from either party; open questions never block any other transition.
  Questions still open when a thread reaches `closed` are recorded as `abandoned`.
- **[A]** Legal iff `in_reply_to` names an open question in this thread authored by
  the counterparty (§1.5); otherwise `TENFOUR/UNKNOWN_KIND` (`invalid_in_reply_to`).
  Closes that question; task-thread state unchanged; substantive.
- **[A2]** `in_reply_to` MUST equal the micro-thread's root question id; anything else
  → `UNKNOWN_KIND` (`invalid_in_reply_to`). Closing the root question closes the
  micro-thread (R3): `closed_reason: answered`.
- **[C]** Requires the `consent {token, granted_via}` gesture block on the send
  (§1.6, R8/R9; WIRE §7.1) — the structured gesture, never prose detection. A
  stale/wrong/absent token → `TENFOUR/CONSENT_REQUIRED` (`bad_token`, §3 step 11).
  On success the broker creates the accept-consent record atomically with the
  transition. The `accepted` message is emitted by the adapter on the gesture, per
  JOURNEYS §4; the broker never authors it.
- **[D]** A *new* second `accepted` (fresh `client_id`) is `UNKNOWN_KIND`; an adapter
  *retry* (same `client_id`, same hash) already returned the canonical envelope at §3
  step 4 and never reaches this cell. Same pattern for every duplicate-kind row in §7.
- **[E]** **DECIDED HERE — amended result:** `result` is legal in `review` by the
  owner as a self-loop. The newest `result` supersedes prior ones for review purposes
  (the initiator's `done`/`change_request` refers to the head). Rationale: without
  this, an owner who spots a defect seconds after posting must burn a full
  change_request round and both humans' attention. Same-sender, so no round increment
  (§8); rate-bounded.
- **[G]** After acceptance the owner MUST NOT decline; the error string teaches: send
  `needs_human`, or ask the initiator to `cancel`. **[G2]** An owner who won't answer
  a micro-thread sends an `answer` saying so, or `needs_human`; `declined` is reserved
  for task offers (R3 lists only answer/cancel as closers).
- **[H]** Error string teaches: the task must be `accepted` before `result`.
- **[J]** **DECIDED HERE:** no mid-flight scope change: `change_request` is illegal in
  `in_progress`. The error string teaches: use `question` (to negotiate) or `cancel`
  (to retire and re-offer). Keeps the review loop the single place scope changes.
- **[K]** Error string teaches the owner's legal moves: `declined` (in `offered`) or
  `needs_human` (after acceptance).
- **[L]** **DECIDED HERE:** `done` is legal only from `review` — approval is approval
  *of a result*. To retire a task without a result the initiator sends `cancel`
  (`closed_reason: cancelled`, distinguishable in the record from `done`).
- **[M]** **DECIDED HERE:** freezes do not stack. A second `needs_human` on a frozen
  thread → `THREAD_FROZEN` ("already frozen; humans must resolve — run
  `tenfour approve <thread>`"). The system MUST NOT re-freeze a frozen thread.
- **[N]** Error string teaches: micro-threads cannot become tasks; send a new `task`
  (thread_id: null).
- **[P]** **DECIDED HERE — one question per micro-thread.** This keeps R3 literal
  ("closes on answer"). Follow-ups and counter-clarifications are new micro-threads
  (cheap: `thread_id: null`) or, on active work, in-task-thread questions. Sequential
  questions are therefore sequential micro-threads.
- **[R]** `result` MUST carry ≥ 1 sha-pinned git artifact (`git_commit` or
  `git_branch`) → else `TENFOUR/ARTIFACT_INVALID` (§3 step 6); every artifact `repo`
  MUST pass the pair's invite-time `repo_allowlist` when one exists (WIRE D27) →
  else `TENFOUR/REPO_NOT_ALLOWED` (§3 step 12). The receiver's local `allowed_repos`
  is enforced separately at surface time (ARTIFACTS §10). (`pull_request` artifacts
  are references and do not satisfy the sha-pinned minimum.)
- **[S]** **DECIDED HERE — scope expansion is broker-computed, never sender-declared.**
  A `change_request` expands scope iff (a) it carries ≥ 1 artifact whose
  (`repo`, `sha`) pair was never previously referenced in this thread, or (b) it
  names a `repo` differing from the thread's `repo`. Scope-expanding `change_request`
  → `offered` (re-offer): the owner must produce a fresh gestured `accepted` before
  working — this implements R9's re-consent *structurally*, reusing the
  `offered → accepted` machinery, and restores the owner's right to `decline` the
  enlarged task. A non-expanding `change_request` → `in_progress` directly, running
  under the original whole-thread consent (JOURNEYS §2).
- **[F]** Frozen cells are reached only when §3 step 9 found no valid `consent_ref`.
  With a valid ref, the send is evaluated against `resume_state` (§6) and this row is
  never consulted.
- **[Y]** The system's `needs_human` is emitted only from inside the round-cap breach
  mutation (§8.4) — v1 has no other system emission. It is parented at the current
  head, stamped server-side within the same transaction, and therefore can never be
  stale: **the system uses the head rule; it does not bypass it** — it is merely
  immune to client-side head races by construction. System messages are exempt from
  round counting, rate limits, and body caps (fixed `strings.ts` content), and are
  delivered to both parties' inboxes.

---

## 6. Frozen: entry and unfreeze

### 6.1 Entry

| Trigger | Actor | Mechanism |
|---|---|---|
| `needs_human` sent | `initiator` or `owner` | Ordinary transition (§5); `frozen_reason: needs_human` |
| Round-cap breach | `tenfour/system` | Atomic reject-and-freeze (§8.4); `frozen_reason: round_cap`; breaching message NOT persisted |

Entering `frozen` records `resume_state` = the state at freeze time. Rate limiting
(§9) never freezes a thread — it is per-agent, threadless.

### 6.2 Unfreeze (who, how, consent)

- **Who:** either human party (JOURNEYS J7: "humans decide"). The system never
  unfreezes.
- **How:** the human runs the structured gesture `tenfour approve <thread>` (or the
  MCP `tenfour_confirm` tool), minting a single-use, 24 h-expiry `unfreeze` consent
  record (§1.6). The agent's next `send` into that thread carries `consent_ref`. The
  broker then evaluates §3 steps 9–13 **against `resume_state`**; if the transition is
  legal, the message persists, the thread state becomes that transition's target, the
  consent record is consumed, and the message is stamped `unfroze: true`. There is no
  separate "unfreeze message" kind and no system post on unfreeze — the consented
  message itself is the record (**DECIDED HERE**).
- **Rejection contract:** no `consent_ref` → `TENFOUR/THREAD_FROZEN` (human_action:
  run `tenfour approve <thread>`); invalid, expired, already-used, or wrong-thread ref
  → `TENFOUR/CONSENT_REQUIRED`. A consented send that is illegal in `resume_state`
  (e.g., `done` with `resume_state: in_progress`) is rejected by the `resume_state`
  cell and the consent record is NOT consumed (**DECIDED HERE** — a typo must not
  burn the human's gesture).
- **Round counter:** **DECIDED HERE:** successful unfreeze resets `rounds_used := 0`
  and `last_substantive_sender := null`. Loop containment is preserved because every
  reset costs a human gesture: an infinite loop now requires an infinite supply of
  human approvals, which is the human gate working as designed.
- **`cancel` from frozen:** legal for the initiator *via the same consent path*
  (`cancel` is legal in every `resume_state`). **DECIDED HERE:** no gestureless
  cancel-from-frozen: nothing moves a frozen thread without a human gesture, with no
  exceptions — one invariant, zero special cases.
- **Consent vs. resumed work:** the broker requires exactly one gesture to unfreeze.
  Receiving-side adapters MUST re-surface the resumed thread to their human before
  any work continues (JOURNEYS: re-prompt after unfreeze); that requirement is
  delivery-layer UX doctrine, restated here non-normatively (**DECIDED HERE:** broker
  state stays minimal; the re-prompt lives in the adapter spec).

---

## 7. Duplicate-kind attempts (fresh `client_id`; adapter retries resolve at §3 step 4)

| Attempt | Thread state when it arrives | Outcome |
|---|---|---|
| Second `accepted` | `in_progress` | `UNKNOWN_KIND` (`illegal_in_state`) |
| Second `result` | `review` | **Legal** — amended result, `→ review` self-loop [E] |
| Second `done` | `closed(done)` | `TERMINAL_THREAD` |
| Second `declined` | `closed(declined)` | `TERMINAL_THREAD` |
| Second `cancel` | `closed(cancelled)` | `TERMINAL_THREAD` |
| Second `needs_human` | `frozen` | `THREAD_FROZEN` [M] |
| Second `answer` to the same question | any (question now closed) | `UNKNOWN_KIND` (`invalid_in_reply_to`) |
| Second `answer` in a micro-thread | `closed(answered)` | `TERMINAL_THREAD` (state check precedes reply check, §3) |
| Second `change_request` before any new `result` | `in_progress` | `UNKNOWN_KIND` (`illegal_in_state`) [J] |
| Second root `task`/`question` (same intent, new `client_id`) | n/a | Legal — a new thread; deliberate; adapters SHOULD warn on near-duplicate bodies (non-normative) |

## 7.1 Races (serialized by the single-writer mutation + head rule)

Broker mutations serialize; exactly one of two concurrent sends commits first. The
loser's outcome follows §3's order deterministically:

| Race | First committed | Second send's fate |
|---|---|---|
| `cancel` (I) vs `result` (O) | `cancel` → `closed` | `result` → `TERMINAL_THREAD` (step 9) |
| `cancel` (I) vs `result` (O) | `result` → `review` | `cancel` parented old head → `STALE_HEAD` (step 10; `cancel` is legal in `review`, so step 9 passes); refetch; resend succeeds |
| `cancel` (I) vs `accepted` (O) | `cancel` | `accepted` → `TERMINAL_THREAD` |
| `cancel` (I) vs `accepted` (O) | `accepted` | `cancel` → `STALE_HEAD`; refetch; resend from `in_progress` succeeds |
| `needs_human` (either) vs any send | `needs_human` → `frozen` | other → `THREAD_FROZEN` (step 9) |
| Round-cap freeze (SYS) vs in-flight send | system `needs_human` (atomic with the rejecting mutation) | in-flight send → `THREAD_FROZEN` (the frozen check, step 9, precedes the head rule, step 10) |
| `answer` (O) vs `cancel` (I) in micro-thread | either | loser gets `TERMINAL_THREAD` (`closed_reason` reveals which won) |
| Same sender double-send (crash retry, same `client_id`) | first | second returns canonical envelope + `delivery_state` (step 4) — never `STALE_HEAD` |

---

## 8. Round counting (normative algorithm)

### 8.1 Definition

A **round** is a *substantive speaker-turn*: the thread's round counter increments
when a substantive kind (§1.4) is sent by a different agent than the sender of the
previous substantive message. Consecutive substantive messages from the same sender
share one round. Status kinds never touch the counter. The root substantive message
is round 1 (**DECIDED HERE**).

`max_rounds`: **fixed per pair at invite issuance** (`admin.issueInvite.max_rounds`,
WIRE §8.2 D27 — default 10, clamped to [1, 12]; founder decision, DESIGN §12) and
**copied onto each thread at creation**. **DECIDED HERE:** no per-thread override in
v1 — the envelope carries no `max_rounds` field. Both thread classes share the same
cap. Digests display `round {rounds_used}/{max_rounds}` (JOURNEYS §2).

### 8.2 Pseudocode

```text
SUBSTANTIVE = {task, question, answer, result, change_request}
STATUS      = {accepted, declined, cancel, done, needs_human}

# Executes inside the single ACID send mutation, as §3 step 13,
# after steps 1–12 have passed.
round_admit(thread, msg):
    if msg.kind in STATUS:
        return ADMIT                          # counter untouched, at any rounds_used

    if thread.last_substantive_sender == null:      # root, or first after unfreeze
        new_rounds = 1
    elif msg.from != thread.last_substantive_sender:
        new_rounds = thread.rounds_used + 1         # speaker alternated
    else:
        new_rounds = thread.rounds_used             # same speaker continues

    if new_rounds > thread.max_rounds:
        append_message(                             # same transaction
            from   = "tenfour/system",
            kind   = needs_human,
            parent = thread.head,                   # stamped in-txn: never stale
            body   = strings.ROUND_CAP_SYSTEM_BODY) # strings.ts export
        thread.state         = frozen
        thread.resume_state  = current_state
        thread.frozen_reason = round_cap
        DISCARD msg                                 # breaching message NOT persisted
        return REJECT TENFOUR/ROUND_CAP {
            state: "frozen", rounds_used: thread.rounds_used,
            max_rounds: thread.max_rounds, retryable: false,
            human_action: strings.ERRORS.ROUND_CAP.instead }  # strings.ts export

    thread.rounds_used             = new_rounds
    thread.last_substantive_sender = msg.from
    return ADMIT
```

### 8.3 Boundary examples (`max_rounds = 10`; I = initiator, O = owner)

| # | Before: (rounds, last_sub) | Incoming | Class | After | Outcome |
|---|---|---|---|---|---|
| 1 | new thread (—, null) | I `task` (root) | subst | (1, I) | admit — root counts as round 1 |
| 2 | (1, I) | I `question` | subst, same sender | (1, I) | admit — no alternation, no increment |
| 3 | (1, I) | O `answer` | subst, alternation | (2, O) | admit |
| 4 | (1, I) | O `accepted` | status | (1, I) | admit — status never counts, `last_sub` unchanged |
| 5 | (1, I) after row 4 | O `result` | subst, alternation | (2, O) | admit — alternation measured against I, not the `accepted` |
| 6 | (2, O) | I `done` | status | (2, O) | admit → `closed(done)` — a clean handoff costs 2 rounds |
| 7 | (2, O) | I `change_request` | subst, alternation | (3, I) | admit |
| 8 | (3, I) | O `question` then O `result` | subst ×2, same sender | (4, O) then (4, O) | both admit — one round for the owner's turn |
| 9 | (9, O) | I `change_request` | subst, alternation | (10, I) | admit — landing exactly on the cap is legal |
| 10 | (10, I) | O `result` | subst, alternation | would be 11 | **REJECT `TENFOUR/ROUND_CAP`** — message discarded, system `needs_human` appended, thread `frozen(resume=review-or-current)` |
| 11 | (10, I) | I `question` | subst, same sender | (10, I) | admit — same-speaker continuation at cap is legal (bounded by §9, not rounds) |
| 12 | (10, I) | O `needs_human` | status | (10, I) | admit → `frozen` — parties can always escalate at cap |
| 13 | (10, I) | I `cancel` | status | (10, I) | admit → `closed(cancelled)` — **the cap blocks substantive escalation, never graceful closure (DECIDED HERE)** |
| 14 | micro-thread (—, null) | I `question` root; then O `answer` | subst; subst | (1, I) → (2, O) | admit; admit → `closed(answered)` — micro-threads cost 2 rounds |
| 15 | post-unfreeze (0, null), resume `in_progress` | O `result` (with consent_ref) | subst | (1, O) | admit — unfreeze reset makes the next substantive sender round 1 regardless of party |

### 8.4 Atomicity requirement

The round check, counter update, message persist, head advance, state transition, and
— on breach — the system `needs_human` append plus freeze MUST all execute within one
ACID transaction (one Convex mutation in the v1 broker). A conforming broker MUST make
the following outcomes impossible, and the conformance suite MUST test each: (a) a
persisted message with an unincremented counter or vice versa; (b) a `ROUND_CAP`
rejection whose system `needs_human`/freeze is missing or arrives as a separate,
reorderable write; (c) two concurrent sends at `rounds_used = max_rounds - 1` both
committing an increment — the head rule (§3 step 10) forces the second to
`STALE_HEAD` before round logic runs.

---

## 9. Rate limiting

### 9.1 Rule

**WIRE §10 and `protocol.ts RATE_LIMITS` are the SOLE owners of the ceilings**; this
section specifies the algorithm with exactly those numbers. For `send`: **12 per
rolling 60 s AND 120 per rolling 3600 s, per sending agent** (token-derived
identity), summed across all threads, both thread classes, and all kinds. The other
methods carry their own WIRE §10 ceilings (`ack` 120/60 s, `inbox` 60/60 s, `thread`
60/60 s, `diag.ping` 30/60 s). Exact sliding-log semantics per window — not fixed
buckets, not token buckets, no approximation (**DECIDED HERE:** exact log is
REQUIRED; at ≤ 120 rows/agent/hour it is trivially cheap and it makes the limit
exactly testable).

What counts toward the `send` windows (**DECIDED HERE**, per the registry of
decisions below):

| Operation | Counts? |
|---|---|
| Persisted `send`, substantive kind | **Yes** |
| Persisted `send`, status kind | **Yes** — status kinds count toward rate even though they never count toward rounds; otherwise the status channel is a free abuse channel (ack-storms, `needs_human` spam) |
| Rejected `send` (any `TENFOUR/*` error) | No — nothing persisted; the error grammar already forbids retry loops; transport-level abuse is the platform's concern, not protocol state |
| Duplicate `send` (R7 canonical-envelope return) | No — no new persist; R11 retries MUST NOT be penalized |
| `ack`, `inbox`, `thread` reads | No — not sends; each has its own WIRE §10 ceiling |
| `diag.ping` (R6) | No — not a send; it is NOT rate-exempt: its own hard 30/60 s ceiling is normative (WIRE §10) |
| `tenfour/system` messages | No — the system principal is not an agent under limits; its emissions are bounded by design (≤ 1 per freeze) |

### 9.2 Algorithm

```text
SEND_WINDOWS = [ {limit: 12, window_s: 60}, {limit: 120, window_s: 3600} ]
# = protocol.ts RATE_LIMITS.send — WIRE §10 owns these numbers.
# §3 step 5 — inside the send mutation, before any thread lookup mutation-side effects.
rate_admit(agent, now):                        # now = broker clock (ts is broker-stamped;
    for {limit, window_s} in SEND_WINDOWS:     #        client clocks are irrelevant — WSL skew rule)
        cutoff = now - window_s
        sent   = messages WHERE from == agent AND ts > cutoff   # half-open window (cutoff, now]:
                                                                # a message exactly window_s old has left
        if count(sent) >= limit:
            oldest = min(sent.ts)
            return REJECT TENFOUR/RATE_LIMITED {
                retryable: false,
                method: "send", limit: limit, window_s: window_s,
                oldest_expires_in_s: ceil(oldest + window_s - now),
                human_action: strings.ERRORS.RATE_LIMITED.instead }   # strings.ts export
    return ADMIT                               # the message, once persisted, joins the log with its ts
```

### 9.3 Burst behavior

The per-minute sub-window (12/60 s) smooths bursts; the hourly window (120/3600 s)
bounds sustained volume. An agent can never send more than 12 messages in any
rolling minute, nor more than 120 in any rolling hour. Recovery is gradual — one
slot frees as each logged message ages past its window. There is no credit
accumulation and no penalty carry-over. The limit is per-agent and independent per
party: one agent being limited never affects its peer, and `RATE_LIMITED` MUST NOT
change any thread's state, freeze anything, or post anything.

| Timeline (agent A) | Window state at attempt | Outcome |
|---|---|---|
| 00:00:00–00:00:50 — 12 sends | minute window 0 → 11 | all admitted |
| 00:00:55 — send #13 | minute window at 12 | `RATE_LIMITED` (`limit: 12`, `window_s: 60`) |
| 00:01:01 — send | 11 in minute window (first send aged out) | admitted |
| 12/min steadily for 10 minutes — send #121 | hour window at 120 | `RATE_LIMITED` (`limit: 120`, `window_s: 3600`), `oldest_expires_in_s ≈ 3000` |
| any time — adapter retry, same `client_id` | n/a (step 4 precedes step 5) | canonical envelope returned; no quota consumed |
| steady 30 sends/hour, ≤ 12/min | under both windows | never limited |

### 9.4 `RATE_LIMITED` response contract

`data` fields (identical to WIRE §9.3): `method`, `limit`, `window_s`,
`oldest_expires_in_s`.

```jsonc
{
  "error": {
    "code": "TENFOUR/RATE_LIMITED",
    "retryable": false,              // uniform error doctrine: stop, tell your human
    "data": {
      "method": "send",
      "limit": 120,
      "window_s": 3600,
      "oldest_expires_in_s": 3412    // informational, for the HUMAN's decision —
                                     // it is not an invitation for the model to wait-and-retry
    },
    "human_action": "…"              // bytes owned by strings.ts ERRORS.RATE_LIMITED.instead
  }
}
```

The rejected message is NOT persisted, NOT queued, and NOT retried by the adapter
(R11 retry applies only to network-indeterminate outcomes, not to typed rejections).
All strings ship from `strings.ts` (JOURNEYS §4); this spec cites keys, never bytes.

---

## 10. Error-registry cross-reference (all 20 codes; wire format `TENFOUR/<CODE>`)

| Code | Fires at | Section |
|---|---|---|
| `UNSUPPORTED_VERSION` | §3 step 1 | wire spec |
| `AUTH_FAILED` | §3 step 2 | identity spec |
| `AUTH_REVOKED` | §3 step 2 | identity spec |
| `PAIR_FORBIDDEN` | §3 step 3 | §4 |
| `CLIENT_ID_CONFLICT` | §3 step 4 | §2 |
| `RATE_LIMITED` | §3 step 5 | §9 |
| `UNKNOWN_KIND` | §3 steps 6, 9 (uniform no-such-transition, §2) | §2, §5 |
| `BODY_TOO_LARGE` | §3 step 6 | wire spec |
| `ARTIFACT_INVALID` | §3 step 6 | §5 [R] |
| `SECRET_DETECTED` | §3 step 7 | security spec |
| `THREAD_NOT_FOUND` | §3 step 8 | §3 |
| `NOT_THREAD_PARTY` | §3 steps 8 (`not_party`), 9 (`role_forbidden`) | §1.3, §2 |
| `TERMINAL_THREAD` | §3 step 9 | §5, §7 |
| `THREAD_FROZEN` | §3 step 9 | §6 |
| `CONSENT_REQUIRED` | §3 steps 9 (bad `consent_ref`), 11 | §1.6, §6 |
| `STALE_HEAD` | §3 step 10 (carries current head) | §1.5 |
| `REPO_NOT_ALLOWED` | §3 step 12 | §4, §5 [R] |
| `ROUND_CAP` | §3 step 13 | §8 |
| `INVITE_INVALID` | pairing path only — never on send | identity spec |
| `INVITE_EXPIRED` | pairing path only — never on send | identity spec |

---

## 11. Invariants (each is a conformance test)

- **I1** Every state is reachable and every non-root state has ≥ 1 inbound transition.
- **I2** `closed` is the only terminal state; entry always records `closed_reason`.
- **I3** `frozen` always carries `resume_state`, `frozen_by`, `frozen_reason`; no
  transition out of `frozen` exists except the consent path of §6.
- **I4** The head advances iff a message persists; no rejection ever moves the head.
- **I5** `rounds_used` is monotonic non-decreasing between unfreezes and never exceeds
  `max_rounds`.
- **I6** No thread-state change occurs without a persisted message (system freeze
  included: the system `needs_human` IS the persisted message).
- **I7** `tenfour/system` messages are always `kind: needs_human`, always parented at
  the in-transaction head, and never counted in rounds or rate.
- **I8** A duplicate send (same sender, `client_id`, content hash) mutates nothing:
  not state, head, rounds, rate, or delivery records — it only reads.
- **I9** The §3 ordering is observable: for an envelope failing multiple checks, the
  returned code is always the lowest-numbered failing step.
- **I10** For every `✗SYS` cell in §5, the broker has no code path that emits it.

The table-driven suite (DESIGN §8) MUST enumerate every cell of §4/§5 by its Cell ID,
every row of §7/§7.1, every boundary row of §8.3, and every counting rule of §9.1.

---

## 12. Index of micro-decisions made in this document

Reviewers: every item below is marked `DECIDED HERE` at its definition site.

1. State enums (§1.2): task `offered/in_progress/review/frozen/closed`; micro-thread `open/frozen/closed` (wire literal `open`, per protocol.ts); single terminal `closed` + `closed_reason`; `frozen` stores `resume_state`/`frozen_by`/`frozen_reason`.
2. Roles fixed at creation: `initiator` = root sender, `owner` = root addressee, including pre-acceptance (§1.3).
3. `UNKNOWN_KIND` = uniform no-such-transition code with the merged protocol.ts `reason` enum + `legal_kinds[]`; role mismatches map to `NOT_THREAD_PARTY` (`role_forbidden`), never `UNKNOWN_KIND` (registry is frozen; no new codes) (§2).
4. Validation-order details: dedup before rate; terminal before stale-head; the 13-step order (identical in WIRE D19 and AUTH §3.4) normative (§3).
5. Unfreeze consent: single-use, 24 h expiry, grantable by either human (§1.6, §6.2).
6. Consent revocation is RESERVED for v1.1 (WIRE D20); a receiver who wants work stopped uses the ordinary `needs_human` cell — no consent-record mutation in v1 (§1.6).
7. Amended result: `result` legal in `review` (owner self-loop) (§5 [E]).
8. Scope expansion broker-computed (new (`repo`,`sha`) or different `repo`); expanding `change_request` → `offered` for structural re-consent; plain `change_request` → `in_progress` (§5 [S]).
9. `change_request` illegal in `in_progress` — no mid-flight scope change (§5 [J]).
10. `done` legal only from `review`; result-less retirement is `cancel` (§5 [L]).
11. `declined` legal only in task `offered`; never in micro-threads (§5 [G]/[G2]).
12. One question per micro-thread; second `question` rejected and teaches a new micro-thread; only owner answers (root-pinned `in_reply_to`); only initiator cancels (§5 [P]/[A2]).
13. Task threads: multiple concurrent open questions allowed; `in_reply_to` binds answers; open questions never block transitions; closure marks them `abandoned`; question/answer never change task-thread state (§5 [Q]/[A]).
14. Freezes do not stack: second `needs_human` on `frozen` → `THREAD_FROZEN` (§5 [M]).
15. System emits `needs_human` only; parented in-transaction at the head — uses the head rule, never subject to client races; exempt from rounds/rate/body caps (§5 [Y]).
16. No gestureless moves on frozen threads — `cancel` from `frozen` requires the unfreeze gesture too (§6.2).
17. A consented-but-illegal-in-`resume_state` send does not consume the consent record (§6.2).
18. Unfreeze resets `rounds_used := 0`, `last_substantive_sender := null`; containment preserved because each reset costs a human gesture (§6.2).
19. Adapter-side post-unfreeze human re-prompt is delivery-layer doctrine, not broker state (§6.2).
20. Root substantive message counts as round 1; same-sender substantive continuation at cap is legal (rate-bounded); status kinds remain legal at cap — graceful closure is never blocked (§8).
21. `max_rounds` is fixed per pair at invite issuance (`admin.issueInvite.max_rounds`, default 10, clamp 1..12) and copied onto each thread at creation; no per-thread override in v1 (§8.1).
22. Rate limit: WIRE §10 / protocol.ts RATE_LIMITS own the numbers (send 12/60 s AND 120/3600 s); exact sliding log per half-open window, persisted sends only; **status kinds count toward rate** (prevents status-channel abuse); rejected/duplicate sends, `ack`/`inbox`/`thread` reads, and system messages do not count; `diag.ping` is not a send but carries its own normative 30/60 s ceiling (§9.1–9.2).
23. `RATE_LIMITED` is `retryable: false` with informational `oldest_expires_in_s` addressed to the human, and never touches thread state (§9.4).
24. Missing required schema fields (e.g., `task` without `repo`) reject in the wire-schema layer upstream of this table; this document owns only the allowlist check (`REPO_NOT_ALLOWED`) (§4).
