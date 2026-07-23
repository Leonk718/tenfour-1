# tenfour/1 — DELIVERY (normative)

**Status: NORMATIVE DRAFT for v1.0 — satisfies the R13 phase gate ("delivery-state
table: leases, cursors, crash points"). Supersedes DESIGN.md §6 and JOURNEYS.md §5
wherever they conflict.**

This document specifies delivery state end to end: broker-side inbox state, the
session lease (single-session rule), the local delivery journal, the file-lock
protocol, injection points, ack and cursor semantics, the crash matrix, outbound
operation records, system-message fan-out, PostToolUse mid-turn delivery, and the
standby-mode loop contract.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as
in RFC 2119. Every numbered rule **[DEL-nn]** is a conformance point; the adversarial
test matrix MUST reference these identifiers.

Errors named in this document use the canonical registry and wire format
`TENFOUR/<CODE>`. This document introduces **no new error codes**.

---

## 1. Terms and actors

| Term | Definition |
|---|---|
| **Agent** | A named identity (`brian/design`), derived from its bearer token. |
| **Session** | One live Claude Code process group attached to an agent: interactive, headless (`claude -p`), or standby. Identified by its `holder` string (a ULID minted per session — §3.1), which is exactly the `holder` field of WIRE §7.2 inbox claims: **the claim holder IS the session identity**. |
| **Adapter** | The tenfour TS package: MCP server (long-lived, per session) + hook processes (short-lived) + CLI, sharing one client library and one journal. |
| **Broker** | The durable store behind the 4-method interface (`send`, `inbox`, `ack`, `thread`) plus `diag.ping`. Convex in v1. |
| **Thread event** | One message row in a thread's transcript. Exactly one per accepted send, including system messages. |
| **Inbox row** | One per (recipient, thread event) that must be delivered. Carries all delivery state. Regular messages create exactly one; see §10 for the system fan-out exception. |
| **Attempt** | One claim of an inbox row by one session. `attempt_id` is a broker-minted ULID. |
| **Injection** | Handing message content to a Claude model: hook `additionalContext`, MCP tool result, or `tenfour_wait` return. |
| **Journal** | The local fsync'd delivery record (§5). The single source of truth for "what did this machine already show the model." |

**[DEL-01]** Delivery correctness MUST NOT depend on the WebSocket subscription,
OS notifications, or hook timing. Those affect latency only. Correctness derives
from: durable broker rows + leases (§2), the local journal (§5), and cursor-on-ack
(§7).

---

## 2. Broker-side delivery state (inbox rows)

### 2.1 States

Persisted broker states for an inbox row:

| State | Meaning | Set by |
|---|---|---|
| `queued` | Stored durably; no session holds it. | `send` mutation (atomic with thread-event insert). |
| `claimed(attempt_id, holder, lease_expires_at)` | Exactly one session holds a delivery lease. | `inbox` call with claim. |
| `injected` | Entered model context (non-final; still redeliverable). | `ack` mutation with `state: "injected"` (WIRE §7.3 D24). |
| `acked` | Model-received confirmed (R2). Terminal. | `ack` mutation with `state: "acked"`. |

**[DEL-02]** Claims are durable broker records (fields on the inbox row), never
in-memory state. A broker restart MUST NOT lose or alter any claim.

**[DEL-03]** The wire enum `delivery_state` (returned on duplicate sends per R7 and
in `tenfour status`) is `queued | claimed | injected | acked`. DECIDED HERE
(amended — WIRE D24 wins): the adapter reports injection with the **dedicated
two-phase ack RPC** — `ack {message_id, attempt_id, state: "injected"}` — issued
after the journal's write-ahead `injected` fsync. Transitions are monotonic
(`injected` after `acked` is a success-shaped duplicate). Until that call arrives,
the broker truthfully reports `claimed`. There is NO piggyback `progress[]` field
on any method.

### 2.2 Lease

**[DEL-04]** DECIDED HERE: the claim lease duration is **300 seconds (5 minutes)**.

**[DEL-05]** Any authenticated broker call attributable to the holder (an `inbox`
claim carrying its `holder` id, or an `ack` referencing one of its live attempts)
auto-renews all of that holder's live claims to `now + 300s`. DECIDED HERE: there
is **no maximum renewal count** — the expiry bound is "5 minutes after the holder
session's last broker contact." A dead session stops renewing; a long-working live
session never loses its claim mid-work.

**[DEL-06]** On lease expiry the broker reclaims: state returns to `queued`,
`prior_attempts` increments (the WIRE §7.2 field name). The next claim mints a
**new** `attempt_id`. Expiry is evaluated lazily (on any read/claim touching the
row) and by a periodic sweep; both paths MUST be equivalent.

**[DEL-07]** DECIDED HERE: after **5** expired attempts without an ack, the broker
flags the row `stalled: true`. The row remains claimable (messages are never
dropped); `stalled` surfaces in `tenfour status`, in digests ("delivery stalling —
run tenfour doctor"), and in a doctor check. There is no auto-freeze and no
system message for stalling.

### 2.3 Claim rules

**[DEL-08]** Claiming is **last-connect-wins and IS the session mechanism** (§3):
a claim from a NEW holder supersedes prior holders' unacked claims (each
superseded row returns to claimable, the next claim mints a new `attempt_id`,
`prior_attempts` increments — WIRE D23). There is no separate session-registration
RPC and no per-agent broker session row: the agent's active session is, by
definition, the holder of the most recent claim sweep. Standby sessions are
**deferential by adapter rule** (§12.4): they MUST NOT claim while another
holder's claims are live.

**[DEL-09]** Claiming is atomic per row within the `inbox` mutation: a row is
claimed by at most one attempt at a time. Two concurrent claim calls MUST NOT
both receive the same row.

**[DEL-10]** `ack` references `(message_id, attempt_id)`; `attempt_id` is REQUIRED
(claim-before-ack, WIRE §9.4). The broker accepts an ack from the referenced
attempt's holder even after lease expiry, PROVIDED the attempt has not been
superseded by a newer claim; the attempt is recorded for audit
(`acked_attempt_id`). An ack referencing a **superseded** attempt — a demoted
session's ack — is rejected `TENFOUR/AUTH_FAILED` (§3.2). Repeat acks from the
current holder are success-shaped idempotent: `{status: "already_acked"}`, never
an error (JOURNEYS §4 doctrine).

**[DEL-11]** `ack` from a non-recipient MUST be rejected `TENFOUR/NOT_THREAD_PARTY`.
DECIDED HERE: `ack` referencing an unknown `message_id` MUST be rejected
`TENFOUR/THREAD_NOT_FOUND` (the registry's closest code; the `human_action` string
disambiguates: "that message id does not exist on this broker — run tenfour doctor").

---

## 3. The session identity (single-session rule, v1) — derived from claims

Resolves Codex still-open item 14. The JOURNEYS §5 note "Stop-hook lease check
noted as v1.1" is **superseded**: the checks ship in v1 on every injection.
DECIDED HERE (amended): **the session identity is derived entirely from the claim
mechanism** (WIRE §7.2/D23). There is no session-registration RPC, no broker
session-lease row, no `deferential` wire flag, and **no session field on `send` or
its response**.

### 3.1 Identity

**[DEL-12]** Each session mints a holder id (ULID) once, stored in
`$TENFOUR_HOME/journal/session.json`, created under the journal lock (§5.4) by
whichever adapter process starts first (SessionStart hook or MCP server); all
other processes of the same session adopt it. Every `inbox mode:"claim"` call
passes it as `holder` (WIRE §7.2).

**[DEL-13]** The agent's **active session** is the holder of the most recent claim
sweep — last-connect-wins by construction (DEL-08): a claim from a new holder
supersedes prior holders' unacked claims and thereby *demotes* them. The claim
lease (5 min, DEL-04, auto-renewed per DEL-05) is the only broker-side lease.
Standby sessions are deferential by adapter rule and MUST NOT claim while another
holder's claims are live (§12.4).

### 3.2 The two mandatory checks

**[DEL-14]** **Sends are session-blind.** A send from a demoted session is
**accepted** like any other (DECIDED HERE: message durability outranks session
ceremony — the human's outbound message is never dropped because a second laptop
opened); `send` carries no session field and its response carries none. **Acks
are not**: an ack referencing a superseded attempt is rejected
`TENFOUR/AUTH_FAILED` (DEL-10; WIRE D23) — a demoted session can neither claim
rows away from the active session nor ack-to-suppress rows the active session now
holds. This closes the demoted-ack residual (ADVERSARIAL-MATRIX A2).

**[DEL-15]** **Every injection** is preceded by a demotion check:
- Injection paths that already talk to the broker (SessionStart, UserPromptSubmit,
  Stop, `tenfour_wait`, standby) detect demotion from that same round-trip — a
  claim sweep that finds its previous attempts superseded (`prior_attempts`
  advanced under a different holder), or an `AUTH_FAILED` on an own-attempt ack.
  No extra round-trip.
- The PostToolUse path (local journal only, §11) checks by `stat` of
  `demoted.flag`: the MCP server writes this flag the moment it learns of demotion
  (supersession observed on any RPC response, or the ack `AUTH_FAILED`). Flag
  present ⇒ no injection.

A demoted session MUST NOT inject and MUST NOT re-claim (re-claiming would
re-promote it; only a deliberate fresh sweep on the machine the human actually
returns to should do that). Rows it already claimed are left to lease-expire
(≤ 5 min) and are then claimed by the active session.

### 3.3 Demotion surfacing

**[DEL-16]** Demotion is a **warning surface, not a protocol error** (DECIDED
HERE — the canonical error registry is complete and contains no demotion code,
deliberately; the ack-path `AUTH_FAILED` of DEL-10 is the one wire-visible
symptom). The demoted session discovers demotion at its next tool call or next
hook fire — both check, per DEL-15. The notice bytes are owned by `strings.ts`
export `SESSION_DEMOTED`: what happened, what is true now, and the one action.
**[DEL-17]** The notice is emitted **once per demotion event** per session
(recorded in the journal), never repeated on every tool call.

---

## 4. Delivery ladder (injection points)

**[DEL-18]** All injection points MUST run the identical journal sequence of §5.3.
No injection path may bypass the journal.

| # | Point | Trigger | Row source | Lease check | Preamble rule (§6) | Cap |
|---|---|---|---|---|---|---|
| I1 | SessionStart | session opens | broker `inbox` fetch + claim | RPC response | per journal | digest caps at 5 lines, "run tenfour inbox for more" |
| I2 | UserPromptSubmit | human submits prompt | broker fetch + claim, plus journal backlog | RPC response | per journal | same as I1 |
| I3 | Stop | model ends turn, new arrivals exist | journal backlog, then broker fetch | RPC response | per journal | surface-first wording (JOURNEYS §4) |
| I4 | PostToolUse (mid-turn) | flag file newer than marker | journal backlog only (already claimed by MCP server) | `demoted.flag` stat | per journal | throttle §11.3 |
| I5 | `tenfour_wait` return | blocking tool receives a message | broker push → journal → tool result | RPC response | per journal | one batch per return |
| I6 | Standby | supervised `claude -p` (§12) | same as I5 | RPC response | per journal | one batch per run |

**[DEL-19]** Broker unreachable at I1/I2 fails **open**: one warning line
("tenfour: broker unreachable — inbox not checked; messages remain queued"), the
session proceeds. Hooks MUST NOT block Claude Code startup or prompts on network
failure.

---

## 5. The local delivery journal

### 5.1 Files

All under `$TENFOUR_HOME/journal/` (Windows: `%USERPROFILE%\.tenfour\journal\`,
`icacls`-tightened like the config):

| File | Purpose |
|---|---|
| `inbox.jsonl` | Append-only inbound delivery journal (this section). |
| `outbox.jsonl` | Append-only outbound op journal (§9). |
| `journal.lock` | The exclusive lock (§5.4). |
| `session.json` | holder id + demotion-notice bookkeeping (DEL-12/17). |
| `pending.flag` | Mid-turn signal file (§11). |
| `demoted.flag` | Demotion signal file (DEL-15). |
| `midturn.state` | PostToolUse throttle marker (§11.3). |

DECIDED HERE: journals are **append-only JSONL**, one record per state transition:
`{at, message_id, attempt_id, state, ...}`. Compaction: when a journal exceeds
**4 MB or 10,000 records**, rewrite live records to a temp file in the same
directory, fsync, atomically rename over the original (POSIX: plus directory
fsync; Windows: `rename` maps to `MoveFileEx(REPLACE_EXISTING)` — atomic on NTFS).
Terminal (`acked`) records are retained **14 days** as the dedup horizon, then
compacted away.

### 5.2 States

`received → injected → ack_pending → acked`, keyed by `message_id` (attempts are
recorded but dedup is by message — a reclaim with a new `attempt_id` MUST NOT
cause a second normal presentation).

| State | Meaning |
|---|---|
| `received` | Row fetched/pushed and claimed; content stored locally; model has NOT seen it. |
| `injected` | Write-ahead: content is about to be / has been handed to the model. |
| `ack_pending` | The model called `tenfour_ack` (or the path's auto-ack, §5.5); ack RPC not yet confirmed. |
| `acked` | Broker confirmed the ack. Terminal. |

### 5.3 The injection sequence and fsync points

**[DEL-20]** Normative sequence for every injection point:

1. Acquire journal lock.
2. For each new row: append `received`, **fsync**. (Skip rows already at
   `received`+ — this is the cross-process dedup.)
3. Release lock. THEN touch `pending.flag` if applicable (§11.2) — journal before
   flag, always (crash matrix C14).
4. To inject: acquire lock; for each row at `received` append `injected`,
   **fsync**; for each row at `injected` (crash leftovers) append a fresh
   `injected` record marked `redelivery: true`; release lock; **then** emit
   content to the model — write-ahead, never inject-then-record.
5. On `tenfour_ack`: acquire lock; append `ack_pending`, **fsync**; release lock;
   **then** send the ack RPC.
6. On broker confirmation: acquire lock; append `acked`, fsync; release lock.

**[DEL-21]** fsync summary (all MUST):

| Transition | fsync timing |
|---|---|
| `received` | Before releasing the lock, before any flag touch. |
| `injected` | **Before** content reaches the model (write-ahead). |
| `ack_pending` | **Before** the ack RPC is transmitted (write-ahead intent). |
| `acked` | After broker confirmation; loss is recoverable (crash matrix C8). |

**[DEL-22]** No broker RPC may be issued while holding the journal lock. Lock hold
time MUST be < 500 ms (append + fsync only).

### 5.4 File-lock protocol (hooks + MCP server, one journal)

DECIDED HERE: the mechanism is a **lockfile created with `O_EXCL` plus stale
detection** — the only primitive that is atomic, dependency-free, and identical on
macOS, Linux, and native Windows/NTFS (Node `fs.open(path, "wx")` →
`CREATE_NEW`). No `flock`, no byte-range locks, no named mutexes.

**[DEL-23]** Acquire algorithm (normative):

```
acquire(journal.lock, timeout = 2000 ms):
  loop:
    try open("wx") → write {pid, holder, acquired_at, host} → fsync → HELD
    on EEXIST:
      read lock JSON (unparseable/partial counts as stale if mtime > 30 s)
      stale := (lock mtime older than 30 s) OR (process.kill(pid, 0) throws ESRCH)
      if stale: unlink (ignore ENOENT / EBUSY) and retry immediately
      else: sleep 25 ms + random jitter 0–25 ms
    if elapsed > timeout: return FAILED
release: close fd, then unlink
```

DECIDED HERE: stale threshold **30 s** (holds are < 500 ms, so 30 s is ~60×
margin); acquire timeout **2 s**; poll 25 ms + jitter. PID liveness alone never
proves staleness on Windows (PID recycling) — that is why staleness is
`mtime > 30 s` **OR** dead PID: the dead-PID branch only *accelerates* takeover,
the mtime branch is the guarantee. On Windows, unlink of a file the live holder
still has open fails (EBUSY/EPERM) — that failure correctly means "held."

**[DEL-24]** A hook that fails to acquire within 2 s MUST NOT inject and MUST NOT
write the journal. It exits 0 silently (delivery defers to the next injection
point — safe by DEL-01) and appends one line to `$TENFOUR_HOME/journal/lock.log`
for doctor. It MUST NOT block Claude longer than the 2 s timeout.

### 5.5 Who writes `ack_pending`

**[DEL-25]** Ack = model-received (R2). On tool-result paths (`tenfour_wait`,
standby) the adapter auto-acks upon successful tool-result construction — the
tool result *is* proof of model receipt. On hook-injection paths the model calls
`tenfour_ack` (the shipped CLAUDE.md block and wrapper text instruct it to).
**[DEL-26]** A message injected but never acked is NOT lost: it re-presents with
the redelivery preamble at the next injection point (§6) and its broker lease
cycle keeps it alive indefinitely. Un-acked ≠ undelivered; it is "unconfirmed."

---

## 6. Redelivery preamble

**[DEL-27]** A row found at `injected` without `ack_pending`/`acked` at recovery
or at any later injection point re-presents **with** the fixed preamble whose
bytes are owned by the `strings.ts` export **`REDELIVERY_PREAMBLE`** (the sole
source; this spec quotes nothing).

**[DEL-28]** The preamble applies **at most once per attempt** and only to the
`injected → ack_pending` uncertainty window. Rows at `received` (never injected)
re-present **without** preamble. Rows at `ack_pending` NEVER re-present — the
adapter silently retries the ack RPC (DESIGN §6: "a lost ack retries the ack,
never re-suppresses the message"). This is the "at-most-one uncertain redelivery"
guarantee: for any crash, the model sees a given message at most twice, and the
second time is always labeled.

---

## 7. Cursor advancement

**[DEL-29]** Each inbox row carries a per-recipient monotonic `inbox_seq`
(broker-assigned, gapless per agent). The per-agent cursor is defined as **the
highest `inbox_seq` such that it and every lower seq are acked**.

| Rule | Statement |
|---|---|
| **[DEL-30]** | The cursor advances on **ack ONLY**. Never on claim, injection, injected-report, lease expiry, session change, or time. |
| **[DEL-31]** | Out-of-order acks are legal; the cursor advances to the highest *contiguous* acked seq. One unacked row pins the cursor beneath it. |
| **[DEL-32]** | The cursor never regresses. |
| **[DEL-33]** | `inbox` fetches MUST return every unacked row regardless of cursor position or age. The cursor bounds the scan, never the result set — a pinned cursor can never hide a newer unacked row. |
| **[DEL-34]** | The adapter journal independently tracks the highest contiguous acked `inbox_seq`. If the broker's fetch skips a seq the journal has never seen acked (e.g., a dashboard hand-delete), the adapter records a `gap` event; doctor names the likely cause. Gaps are surfaced, never silently healed. |

---

## 8. Crash matrix

Invariants proven by this table: **no message is ever lost**, and **at most one
uncertain redelivery occurs, always carrying the explicit preamble**. Each row is
a mandatory kill-point test (DESIGN §8 "crash-point tests").

| # | Crash point (exact moment) | Durable state at restart | Recovery action | User-visible outcome |
|---|---|---|---|---|
| C1 | Broker accepted send; recipient machine off/never fetched | broker: `queued`; journal: — | Normal fetch at next injection point | Delivered once, no preamble. |
| C2 | After broker claim, before journal `received` fsync | broker: `claimed` (lease ticking); journal: — | Same session restart: fetch returns own unacked claims → journal `received` → inject. New session: lease expires ≤ 5 min → reclaim | Delivered once, no preamble; worst-case extra delay 5 min. |
| C3 | After `received` fsync, before `injected` fsync | journal: `received` | Inject normally at next point | Delivered once, no preamble. |
| C4 | After `injected` fsync, before content actually emitted to the model | journal: `injected` | Re-present WITH preamble (DEL-27) | Model sees it once, labeled "possible redelivery" — the honest hedge; the model finds it never handled it. |
| C5 | Model saw content; crash before model called `tenfour_ack` | journal: `injected` | Re-present WITH preamble | Model sees it twice; second time labeled; model verifies and skips or handles. The at-most-one uncertain redelivery. |
| C6 | After `ack_pending` fsync, before ack RPC transmitted | journal: `ack_pending` | Silent ack retry (idempotent) | Invisible. No re-present (DEL-28). |
| C7 | Ack RPC in flight; broker never processed it | journal: `ack_pending`; broker: `claimed` | Silent ack retry; broker acks by message_id even if lease expired (DEL-10) | Invisible. |
| C8 | Broker processed ack; crash before journal `acked` fsync | journal: `ack_pending`; broker: `acked` | Ack retry → success-shaped `already_acked` → journal `acked` | Invisible. |
| C9 | Crash during journal compaction | temp file partial; original intact | Discard temp (stale-named); original authoritative | Invisible. |
| C10 | Outbound: after `prepared` fsync, before `sending` fsync | outbox: `prepared` | Op **abandoned** and surfaced (DEL-40) — never transmitted, never auto-sent | "1 outbound op was never transmitted (not queued): <summary>. Re-send if still wanted." No phantom send. |
| C11 | Outbound: after `sending` fsync; RPC outcome unknown | outbox: `sending` | Idempotent retry with the **same** `client_id`; fresh accept or R7 duplicate (canonical envelope + `delivery_state`) → `confirmed` | SessionStart recovery line: "1 outbound op resolved: confirmed as <id>." Exactly-once on the wire. |
| C12 | Broker process crash after durable accept | broker rows durable (Convex) | None client-side | Latency only. |
| C13 | Standby `claude -p` killed after `injected` | journal: `injected` | Supervisor respawns (§12.3); next run re-presents WITH preamble | Same as C5, no human involved. |
| C14 | Crash between journal `received` fsync and `pending.flag` touch | journal: `received`; flag stale | Row picked up at next hook fire or turn boundary regardless of flag (flag is latency-only, DEL-46) | Latency only. |

---

## 9. Outbound operation record (R11)

### 9.1 States and fsync

`prepared → sending → confirmed | failed | abandoned`, in `outbox.jsonl`, same
lock, same fsync discipline.

| State | Written when | fsync |
|---|---|---|
| `prepared(client_id, content_hash)` | Envelope validated locally (size caps, artifact caps, ancestor check per R5, adapter-side secret scan), `client_id` minted **by the adapter** (never the model), canonical `content_hash` computed over the field set defined in the wire schemas (`docs/spec/WIRE.md`) | Before any transmission step. |
| `sending` | Immediately before the RPC is first transmitted | **Before** the RPC (write-ahead: "outcome may now be unknown"). |
| `confirmed(message_id, seq)` | Broker returned the canonical stamped envelope | After response. |
| `failed(code)` | Broker returned a typed `TENFOUR/<CODE>` rejection (e.g. `STALE_HEAD`, `ROUND_CAP`, `SECRET_DETECTED`, `BODY_TOO_LARGE`, `REPO_NOT_ALLOWED`, `RATE_LIMITED`, `CONSENT_REQUIRED`) — surfaced to the model in the same tool result. Terminal. | After response. |
| `abandoned` | Recovery found `prepared` with no `sending` (C10) | At recovery. |

### 9.2 Retry policy

**[DEL-35]** Retries MUST reuse the original `client_id`. The broker dedups on
(sender, `client_id`) with matching `content_hash`; a reused `client_id` with a
different hash is `TENFOUR/CLIENT_ID_CONFLICT`.

**[DEL-36]** Duplicate sends return the canonical original envelope plus its
current `delivery_state` (R7), success-shaped — never an error, never a bare
"already delivered."

**[DEL-37]** DECIDED HERE: the `retryable: false` doctrine is **model-facing**.
The adapter MAY mechanically retry exactly two idempotent operations — ack RPCs
and `sending`-state resolution — with exponential backoff 1 s doubling to a 60 s
cap. The adapter MUST NOT auto-retry anything else, and MUST NOT retry in the
background while telling the model a send failed. (`RATE_LIMITED` is a typed
rejection, never mechanically retried; its `oldest_expires_in_s` is information
for the human.)

**[DEL-38]** A send that fails visibly (typed rejection or unreachable broker
surfaced in the tool result) is terminal: `failed` (or `prepared`→ the model was
told "message NOT queued"). **No phantom outbox** — the adapter never silently
transmits later something the model was told did not go out.

**[DEL-39]** Recovery (adapter start, first tool use, or SessionStart hook):
`sending` ops are resolved per DEL-35/36; results reported in one SessionStart
line.

**[DEL-40]** DECIDED HERE: `prepared` ops found at recovery are **abandoned, not
auto-sent** — "never transmitted" is a known-safe outcome and auto-sending a
stale intent contradicts DEL-38. Abandoned ops are surfaced in the SessionStart
recovery line and `tenfour status` until acknowledged (`tenfour status --clear-ops`).

**[DEL-41]** `TENFOUR/AUTH_REVOKED` on any call: the adapter halts all broker
traffic, preserves both journals intact, and surfaces the re-pair action
(`tenfour join`). After re-pairing under the same agent name, delivery resumes
from the same journals — no duplicates (journal dedup by `message_id`), no loss
(broker rows untouched by revocation).

---

## 10. System-message fan-out (freeze delivery to BOTH parties)

When the broker principal `tenfour/system` posts `needs_human` (round-cap breach —
v1's ONLY system emission, STATE §5 [Y]):

**[DEL-42]** **One thread event, two inbox rows.** Exactly one message row is
appended to the thread (one `id`, one `seq`, `from: "tenfour/system"`,
`kind: "needs_human"`), and exactly **two** inbox rows are created — one per
party — in the same atomic mutation that freezes the thread and (for round-cap)
rejects the breaching send with `TENFOUR/ROUND_CAP`.

| Property | Thread event | Inbox rows (×2) |
|---|---|---|
| Count | 1 | 2 (one per party; the breaching sender gets one too — it receives both the send rejection and the system message) |
| Identity | shared `id`, one `seq` in the thread | distinct row ids, each with its own recipient-scoped `inbox_seq` |
| Delivery state | none (transcript fact) | independent `queued → claimed → acked` per recipient, independent leases, attempts, cursors |
| Ack effect | none | each party acks only its own row; one party's ack never affects the other's delivery |
| Transcript view | `tenfour_thread` shows the event once | not shown as two messages anywhere |

**[DEL-43]** For ordinary (non-system) messages exactly one inbox row exists —
the `to` agent's. The sender never receives an inbox row for its own message; it
sees it via `tenfour_thread`.

---

## 11. PostToolUse mid-turn delivery (R1)

### 11.1 Pipeline

1. The MCP server's live subscription receives an arrival → runs journal steps
   1–3 of DEL-20 (claim via broker, `received` + fsync under lock).
2. It then rewrites `pending.flag` atomically (temp + rename) containing
   `{count, latest_message_id, written_at}`.
3. Every PostToolUse hook fire: `stat(pending.flag)` and `stat(demoted.flag)` —
   local, no lock, no network.
4. If `pending.flag` mtime > the `midturn.state` marker AND no `demoted.flag` AND
   the throttle (§11.3) permits: acquire lock, re-check under lock, inject
   `received` rows via `hookSpecificOutput.additionalContext` (journal step 4),
   update `midturn.state`, release.
5. Otherwise: exit 0 with no output.

### 11.2 Cost budget

**[DEL-44]** The no-op path (steps 3 + 5) MUST complete in **< 50 ms** total hook
overhead (the two stats are sub-millisecond; the budget covers Node process
startup, which dominates). This budget is a CI-measured conformance point on all
three OSes.

**[DEL-45]** Journal-before-flag ordering (DEL-20 step 3) is mandatory; the flag
is purely a latency signal. A missing or stale flag delays delivery to the next
turn boundary; it can never lose a message (crash matrix C14).

### 11.3 Throttle

**[DEL-46]** DECIDED HERE: PostToolUse stats on **every** fire (cheap), but
mid-turn **injection** is throttled to at most **one batch per 30 seconds** per
session, batch capped at **5 messages** (matching the digest cap) with a "run
tenfour inbox for more" tail line. Arrivals beyond the throttle window batch into
the next eligible fire or the next turn boundary (Stop/UserPromptSubmit), which
are not throttled.

---

## 12. Standby mode (`tenfour standby`, R1c)

An explicit, foreground, human-started supervisor — the "no daemon" rule stands:
nothing installs itself, nothing survives the terminal that runs it.

### 12.1 Loop contract

**[DEL-47]** The supervisor loop: verify config → deference check (§12.4) →
spawn one `claude -p` run with (a) the standby system prompt (`strings.ts` export
`STANDBY_SYSTEM_PROMPT`), (b) the human's standing-rules file
`$TENFOUR_HOME/standby.md`, (c) the tenfour
MCP server in **standby profile** (§12.2). The run calls `tenfour_wait`
(300 s timeout); on delivery it handles **at most one batch**, then exits; on
timeout it exits 0 (the success-shaped timeout copy teaches this is normal). The
supervisor respawns immediately after a clean exit — fresh context every run,
bounded memory by construction.

### 12.2 What standby may do (structural, not disciplinary)

**[DEL-48]** DECIDED HERE: in standby profile the adapter restricts `tenfour_send`
to kinds **`answer` and `needs_human`**. Any other kind is refused locally
(before the wire) with the shaped instruction owned by `strings.ts` export
`STANDBY_KIND_REFUSAL`. `accepted` additionally remains broker-blocked without a
consent gesture (`TENFOUR/CONSENT_REQUIRED`, R8/R9) — two independent layers.

**[DEL-49]** Standby MUST ack everything it receives (model-received is literally
true). Non-answerable messages are acked, queued (they remain visible in inbox
digests and `tenfour status` — ack advances the cursor but JOURNEYS' staleness
surfacing covers the "handled by nobody yet" view via thread state, not delivery
state), and MAY raise an OS notification.

**[DEL-50]** DECIDED HERE: default standing rules answer **nothing** — out of the
box standby only acks, queues, and notifies. Answering `question` kinds requires
`standing_rules.auto_answer_questions = true` in config
(`packages/schema/src/config.ts`) plus the `standby.md` instructions
file (R9: standing-rule consent is declared in config, never inferred). Standby
answers count as normal rounds and are subject to `TENFOUR/ROUND_CAP` and
`TENFOUR/RATE_LIMITED` like any sender; on `RATE_LIMITED` standby stops answering
and queues.

### 12.3 Restart policy

**[DEL-51]** DECIDED HERE: clean exit (0) → immediate respawn. Crash (non-zero /
signal) → exponential backoff 1 s doubling to 60 s cap. Circuit breaker: **5
crashes within 5 minutes** → standby exits non-zero with an OS notification and a
final journal record ("standby stopped after repeated crashes — run tenfour
doctor"). Hung-run guard: a run exceeding **15 minutes** wall clock is killed and
counted as a crash. All crash-time journal states recover per §8 (row C13).

### 12.4 Lease deference

**[DEL-52]** Standby is **deferential by adapter rule** (DEL-08/DEL-13): it
claims **only when no other holder's claims are live** (a peek sweep shows no row
claimed by a different holder with an unexpired lease) and NEVER displaces a live
session. When an interactive session starts claiming (last-connect-wins), standby
is demoted like any session: its in-flight `tenfour_wait` returns a shaped
`{status: "demoted"}` (not an error), the run exits cleanly, and the supervisor
enters dormant watch — peeking every **60 s** and resuming only when no other
holder's claims remain live (the interactive session's claims lease-expire ≤ 5 min
after it closes). Two standbys on one agent: the second observes another
deferential holder's live claims (or its fresh lock on the shared journal, same
machine) and MUST exit with "standby already running for <agent> on
<host-hint>."

---

## 13. Invariants (conformance summary)

| Inv | Statement | Enforced by |
|---|---|---|
| INV-1 | No accepted message is ever lost, under any single crash at any point. | §8 all rows; DEL-06/07 (broker never drops), DEL-26. |
| INV-2 | At most one uncertain redelivery per message, always carrying the explicit preamble. | DEL-20 write-ahead, DEL-27/28, C4/C5/C13. |
| INV-3 | Cursor advances on ack only, and an unacked row can never be hidden. | DEL-30–33. |
| INV-4 | At most one session injects for an agent at any time; a demoted session learns at its next tool call or hook fire. | DEL-08, DEL-13–17. |
| INV-5 | Exactly-once on the wire for outbound sends despite crashes. | DEL-35/36, C10/C11. |
| INV-6 | Nothing transmits after the model was told it did not transmit. | DEL-38/40. |
| INV-7 | One journal, one writer at a time, on all three OSes. | DEL-22–24. |
| INV-8 | System freezes reach both humans; neither party's ack masks the other's. | DEL-42. |
| INV-9 | Hook overhead in the no-delivery case is bounded and measured. | DEL-19, DEL-24, DEL-44. |
| INV-10 | Standby can never displace a human's live session and can never send beyond `answer`/`needs_human`. | DEL-48, DEL-52. |

Every DEL rule and crash-matrix row MUST appear in the adversarial test matrix
(R13) before broker/adapter wire implementation begins.
