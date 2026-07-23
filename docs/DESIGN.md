# tenfour — a durable, human-gated task relay between two Claude Code sessions

**Status: DRAFT v0.95 — post-Codex-review rewrite. Pending UX-panel integration + Codex round 2.**
**Working name "tenfour" (founder names the project). Protocol name: `tenfour/1` (own namespace; not "A2A" — that collides with Google's protocol branding).**

One Claude Code session talks to one Claude Code session across two machines (macOS ↔
Windows ↔ Linux), with durable queuing, authenticated identity, model-visible protocol
errors, and hard human gates. Built for a two-founder design→dev handoff; open-sourced
because the pattern generalizes.

**What this is:** a durable, human-gated relay with a protocol tuned for how coding
agents actually behave.
**What this is not:** a secure autonomous-agent substrate, an E2E-encrypted transport,
or a general multi-agent framework. (Honest positioning is the security feature Reddit
can't roast.)

## 1. Goals and non-goals

**Goals (v1):**
1:1 agent messaging (`brian/design` ↔ `jonathan/web`), human-chosen session
participation, durable inbox across closed sessions, cross-platform (macOS/Windows
native + WSL/Linux, CI-proven), loop containment enforced in the broker, peer-authority
containment enforced via layered controls with honestly stated limits, stable Claude
Code features only, OSS production quality.

**Non-goals (v1):** >2 agents, rooms/broadcast, presence UX, dashboards, E2E encryption
(broker operator can read bodies — stated in SECURITY.md), realtime chat, Channels push
(v2), iMessage (v2, macOS-only optional), always-on SDK workers.

## 2. Verified facts this design stands on (tested in code, July 2026)

| Fact | How verified |
|---|---|
| Blocking MCP tool (`tenfour_wait`) delivers into a live headless `claude -p` session | Test server blocked 6s then returned a message; nested session received + quoted it |
| Research-preview Channels push does NOT register headless | Same harness with dev flag: MCP tools visible, channel event never injected |
| Channel notification wire format (v2 upgrade path) | Prototype emitted spec-exact JSON-RPC, verified against docs |
| Background-task completion re-invokes interactive sessions | Standard mechanism, exercised in production daily |
| SessionStart / Stop / UserPromptSubmit hooks exist on stable Claude Code | Official hooks docs; session-start delivery path relies on SessionStart |

## 3. Architecture

```
Machine A (macOS)                                    Machine B (Windows/WSL)
┌──────────────────────────┐                         ┌──────────────────────────┐
│ Claude Code session       │                         │ Claude Code session       │
│  ├─ tenfour MCP server     │       Broker            │  ├─ tenfour MCP server     │
│  │  (subscribes while     │◄──── (Convex v1, ─────► │  │                        │
│  │   session is open)     │   behind a 4-method     │  │                        │
│  ├─ hooks: SessionStart / │   broker interface)     │  ├─ hooks (Node, cross-   │
│  │  Stop / UserPromptSubmit│                        │  │  platform, no shell)   │
│  └─ local delivery journal │                        │  └─ local delivery journal │
└──────────────────────────┘                         └──────────────────────────┘
```

- **Broker interface** (the OSS answer to lock-in): four methods — `send`, `inbox`,
  `ack`, `thread` — defined as a TypeScript interface with conformance fixtures.
  **Convex is the v1 implementation** (dedicated free-tier project, isolated from any
  product infra). Self-hosting docs ship when CI exercises them (targeted v1.1), not
  before — we do not claim what CI doesn't prove.
- **Adapter**: one TS package, three faces sharing one client lib:
  1. **MCP server** (`.mcp.json`): tools `tenfour_send`, `tenfour_ack`, `tenfour_thread`,
     `tenfour_wait`. While the session is open it holds the broker subscription (latency);
     correctness never depends on it (§6).
  2. **Hook scripts** (Node, cross-platform): **SessionStart** injects queued inbox as
     context when a session opens — this is the "morning catch-up" delivery path.
     **Stop** blocks-with-reason when new messages arrived while the model worked.
     **UserPromptSubmit** prepends pending messages. OS notification (cross-platform
     lib) fires *at hook moments* — tenfour does not claim realtime idle alerts without
     a daemon; SECURITY.md and README say exactly this.
  3. **CLI**: `tenfour init` (creates config, installs hooks + permission rules by
     MERGING into existing settings, never clobbering), `tenfour token` (rotate/revoke),
     `tenfour doctor` (verifies hooks fire, rules present, broker reachable, clock sane).
- **No daemon.** Closed session ⇒ messages queue in the broker. Windows notes: config
  under `%USERPROFILE%\.tenfour` with `icacls` tightening (documented best-effort), all
  scripts Node — no bash, no PowerShell execution-policy exposure.

## 4. Protocol `tenfour/1`

### 4.1 Envelope (client → send)

```jsonc
{
  "protocol": "tenfour/1",       // unknown version ⇒ typed rejection
  "client_id": "ULID",          // idempotency key, scoped to sender
  "thread_id": "ULID|null",     // null only for kind=task (broker mints)
  "parent_id": "id|null",       // MUST equal current thread head (see 4.4)
  "to": "jonathan/web",
  "kind": "task|question|answer|accepted|declined|result|change_request|cancel|done|needs_human",
  "body": "markdown ≤ 16 KB (NFC-normalized; caps on artifact count/lengths)",
  "artifacts": [ /* see 4.5 */ ]
}
```

Broker-stamped, never client-supplied: `id`, `from` (derived from auth token),
`seq` (per-thread monotonic — the ordering primitive; timestamps are display-only),
`ts`, `round`, `status`. The server response returns the canonical stamped envelope;
the error schema is typed (`code`, `human_action`, `retryable:false` on all protocol
errors — errors tell the model to stop and inform its human, never to retry).

### 4.2 Ten kinds

Reinstated `declined` and `cancel` after review — without them a recipient who can't
take a task must abuse `needs_human`, and an initiator can't retire an obsolete task.
`accepted` transfers ownership; `result` requires ≥1 sha-pinned artifact and moves the
thread to `review`; `answer` must parent a `question`; `done`/`declined`/`cancel` are
terminal; `needs_human` freezes (resumable only by a fresh human-approved message per
the unfreeze rule in PROTOCOL.md).

### 4.3 State machine (complete, published, tested)

`PROTOCOL.md` ships the full **kind × state × sender-role → next-state | typed-error**
table; the broker implements exactly that table; a table-driven test walks every cell.
Summary: `offered →(accepted)→ in_progress →(result)→ review →(change_request)→
in_progress | →(done)→ closed`; `offered →(declined)→ closed`; initiator-only
`cancel` from any non-terminal state; `question/answer` legal in `offered|in_progress|
review` between the two parties; any state →(needs_human | round-cap)→ `frozen`.
No state exists without an inbound transition (the v0.9 review found one; fixed).

### 4.4 Concurrency, ordering, dedup

- **Head rule**: `parent_id` must equal the thread's current head; a mismatched write is
  rejected with `stale_head` + the current head so the model refetches (`tenfour_thread`)
  and reconsiders. No branching, no interleaving corruption — this is optimistic
  concurrency, and the error text teaches the recovery.
- **Rounds**: a round = a sender alternation on substantive kinds (task, question,
  answer, result, change_request). Status kinds don't count. The algorithm is specified
  in PROTOCOL.md and the cap check is atomic within the send mutation.
- **Round-cap breach**: write rejected; broker (as system principal `tenfour/system`,
  a first-class identity in the schema — resolves the "who sends broker messages"
  hole) posts `needs_human` into the thread, visible to both agents' inboxes; thread
  freezes.
- **Dedup**: `client_id` idempotency holds only when (sender, content-hash) match the
  original; a reused `client_id` with different content is a `client_id_conflict`
  rejection. Scoped per sender.

### 4.5 Artifacts

Types: `git_commit`, `git_branch` (both require `repo` + `ref` + `sha`; sha field sized
for SHA-1 and SHA-256 repos), `pull_request` (`repo`, `number`, `url` — reference only).
`repo` must match the receiver's configured **repo allowlist**; tenfour NEVER fetches,
clones, or checks out anything automatically — artifacts are references a human-gated
workflow acts on. (Removes the SSRF/auto-fetch class entirely.)

### 4.6 Versioning

`protocol` field on every message; broker advertises supported versions; unknown kind or
version ⇒ typed rejection, never silent drop; additive fields tolerated by receivers
(spec'd unknown-field rule); protocol version ≠ package version; compat policy in
PROTOCOL.md; conformance fixtures published for independent implementations.

## 5. Security model — layered, honestly labeled

**Threat model (SECURITY.md leads with this):** the peer human is **trusted**; in
scope: compromised/prompt-injected peer *sessions*, accidental loops, token leakage,
open-relay abuse, secret spillage. Out of scope: a malicious co-founder (they have your
repo access anyway), broker-operator confidentiality (bodies are plaintext to Convex —
stated), and OS-level sandboxing of the agent (Claude Code permission rules are
**friction, not a sandbox** — stated in exactly those words).

| Layer | What it actually guarantees |
|---|---|
| Bearer token per agent (256-bit, sha256-hashed at rest, config file 0600 / icacls) | Broker writes require a valid token; `from` derives from it. Knowing the URL grants nothing. Tokens are never shared between agents — "exchange" means registering each other's *names*, not keys. Rotation: `tenfour token rotate`; revocation immediate. |
| Broker-enforced protocol (state machine, head rule, round caps, rate ceiling, terminal-reply rejection, size caps) | Loops and storms die at the database even if both models are confused. This layer is code, testable, and the strongest claim we make. |
| Provenance wrapping (per-message nonce delimiters + fixed framing text) | **Provenance marking, not an injection boundary.** It ensures the model always knows text came from the peer agent and survives compaction. It cannot stop a model from being persuaded by content. Labeled as such. |
| Shipped permission rules + gate list | Friction and audit points for: merge, deploy, push-to-protected, secret access, dependency install, destructive fs, spend, **plus** (added after review): network exfil tools, modifying CLAUDE.md/hooks/CI/agent config, persistence mechanisms, credential stores. Documented limits: shell indirection can evade pattern rules — the human gate is the real boundary. |
| Human gates | Work starts when the receiving human says go (auto-start OFF; standing rules are the human's own CLAUDE.md choice). Merges/deploys are human acts. `needs_human` freezes are resolved by humans. |
| Best-effort DLP | Secret regex on send is **best-effort**, labeled as such; applies to body AND artifact strings; log redaction specified; primary control is the git-refs-not-content norm. |

## 6. Delivery semantics (rewritten after review)

- **Durability claim, precisely**: messages are *stored durably* immediately; they are
  *injected* at the next delivery point — `SessionStart` hook (session opens),
  subscription push → Stop/UserPromptSubmit hooks (session active), or `tenfour_wait`
  return (headless worker). No claim of realtime delivery to idle humans.
- **Single-session rule (v1)**: one live session per agent name. Second connection with
  the same token ⇒ broker warns, last-connect-wins for the subscription; delivery
  correctness is unaffected because claims are atomic:
- **Atomic claim**: delivery marks `delivered(attempt_id, holder)`; hooks and tools go
  through the same local client so one message reaches the model once per attempt.
- **Local delivery journal** (not a bare seen-set — review finding): states
  `received → injected → ack_pending → acked`, fsync'd, with crash-recovery rules: a
  message `injected` but never `acked` is re-presented WITH an explicit
  *"possible redelivery — check whether you already handled this"* preamble; a lost
  `ack` retries the ack, never re-suppresses the message.
- **Ack means model-received** — renamed from "processed" (review: a tool call proves
  receipt, not completion). Business completion is what `result`/`done` messages are
  for. Acks are idempotent, recipient-only, and reference message + attempt.
- **Reconnect**: correctness comes from cursor-based `inbox` queries on every
  reconnect/SessionStart; the WebSocket subscription only reduces latency.

## 7. The worked example (systematized from the real A23 handoff)

1. Brian's Claude commits the spec → `tenfour_send {kind: task, artifacts:[design@sha]}`
   — outbound `task` prompts Brian in v1.
2. Jonathan's session opens → SessionStart hook injects the wrapped task → Jonathan
   says go → `{kind: accepted}` → implements on a branch.
3. `{kind: result, artifacts:[branch@sha, pull_request#42]}` — screenshots live in the
   PR description; the broker carries references.
4. Brian's Claude verifies 1:1 against the checklist in the task body →
   `{kind: done}` or `{kind: change_request}` (≤ 10 rounds → `tenfour/system` freezes +
   `needs_human` to both).
5. **A human merges. Always.**

## 8. Repository & OSS quality bar

Monorepo `packages/{broker,adapter,cli}` + `docs/{PROTOCOL,SECURITY,SETUP}.md` +
`examples/` + CI. TypeScript strict, ESM, Zod schemas shared broker/adapter.

**Tests** (the Reddit-proof part): table-driven state machine over every kind×state×role
cell; loop/round/dedup/head-rule rejection paths; secret-regex corpus (hits + false-
positive guards); crash-point tests on the delivery journal (kill between received/
injected/ack); duplicate-delivery and concurrent-session tests; conformance fixtures;
integration: two headless `claude -p` sessions completing task→accepted→result→done
(pattern already proven); **CI matrix: macos + windows + ubuntu**, plus a quickstart
job that executes SETUP.md against a scratch broker, plus upgrade-from-previous-schema
job once v1.0 ships.

**Policies shipped at v1.0**: compat policy, supported-versions table (Claude Code /
Node / OS), lockfiles + provenance (npm trusted publishing), SECURITY.md disclosure
contact, retention/deletion documented (broker data export path), CONTRIBUTING + CoC,
MIT, no telemetry.

## 9. Decisions locked vs open

**Locked by tests/review:** hooks+MCP transport; SessionStart as the session-open
delivery path; model-ack = received; reject-and-freeze; 10 kinds; head rule; per-thread
seq; system principal; repo allowlist + never-auto-fetch; honest security labeling;
cross-platform Node-only scripts; broker interface with Convex as v1 impl.

**Open for founders:** name; outbound-task friction dial (prompt forever vs allowlist
after trust period); symmetric tasks day one (recommended yes);
self-host timing (v1.1 with CI proof). (max_rounds default DECIDED: 10 — §12.)

## 10. v2 parking lot

Channels push (wire format verified), self-host CI + docs, read-only thread viewer,
iMessage needs_human fallback (macOS optional), structured checklists, >2 agents,
Agent SDK workers.

## 11. v0.96 rulings (post Codex round-2 — these supersede conflicting text above)

**R1 — Responsiveness tier (the dispatcher requirement, mechanisms verified against
official hooks docs):** every hook event supports `additionalContext` injection,
including **PostToolUse — mid-turn**. Delivery ladder, fastest first:
(a) *Active session, mid-turn*: the MCP server's live subscription writes arrivals to
the local journal; a PostToolUse hook stats that file (local, sub-ms, no network) and
injects the message between tool calls — the peer's Claude "takes a sec," replies, and
continues its work. (b) *Turn boundaries*: Stop / UserPromptSubmit as designed.
(c) *No session open on an always-on machine*: `tenfour standby` — a supervised
`claude -p` duty-officer loop built on the code-verified blocking `tenfour_wait`
pattern, answering `question` kinds under the human's standing rules and queuing
everything else. Status queries between two always-on machines are answered in
seconds-to-minutes with zero human relay.
**R2 — Ack means MODEL-RECEIVED, full stop** (JOURNEYS' "surfaced to my human" was a
second definition; rescinded). Human visibility is UX guidance, not a protocol state.
**R3 — Question micro-threads are protocol-legal**: `thread_id:null` permitted for
`question` as well as `task`; a question-rooted thread closes on `answer` (or
`cancel`). Full cell coverage lands in the normative state table.
**R4 — `in_reply_to` field added**, distinct from concurrency `parent_id` — resolves
the answer-must-parent-question vs head-rule collision.
**R5 — Push-verification without network**: replace `git ls-remote` (SSRF class
reintroduced — rejected) with a local ancestor check:
`git merge-base --is-ancestor <sha> <configured-remote-tracking-ref>`. No network, no
credential helpers; the error teaches "push first, then send."
**R6 — `hello` is NOT a message thread**: it becomes a dedicated authenticated broker
diagnostic method (`diag.ping`), excluded from threads, rounds, retention, and inbox.
Doctor uses the same method plus an isolated temp journal — never live protocol state.
**R7 — Duplicate sends return the canonical original envelope + its current
`delivery_state`** (`queued|claimed|injected|acked`), never a bare "already delivered"
claim.
**R8 — `accepted` requires a structured gesture**: `tenfour accept <thread>` (CLI) or
the MCP confirm tool echoing a consent token from the surfaced message. Natural-
language "go" detection is explicitly rejected as an authorization mechanism.
**R9 — Consent is a broker record**, `{thread_id, granted_via_gesture, scope:
whole_thread, revocable}`; a `change_request` that adds new artifacts or changes the
target repo triggers re-consent. Standing-rule consent is declared in config, not
inferred.
**R10 — `task` carries a first-class `repo` field** (wrong-repo routing needs wire
truth, not artifact inference).
**R11 — Outbound idempotency**: the adapter persists
`prepared(client_id, content_hash) → sending → confirmed`; retries reuse the original
client_id. Canonical-hash field set specified in the wire schemas.
**R12 — CLI manifest (synced)**: `init`, `invite`, `join`, `accept`, `token`,
`doctor`, `status`, `inbox`. Windows claim narrowed: Node hooks avoid PowerShell
policy; npm's global shims do not — SETUP leads with the pre-step.
**R13 — Honest phase gate**: §4.3's "complete, published, tested" describes the
DELIVERABLE, not this document. Implementation of broker/adapter wire behavior begins
only after the normative artifacts exist: full state table, executable Zod wire
schemas for all methods + errors, identity/authorization model (pair table, invite
binding, read auth), delivery-state table (leases, cursors, crash points), round/rate
algorithms with pseudocode, strings.ts catalog, adversarial test matrix. Scaffolding,
prototypes, and test harness may start now (Codex round-2 verdict, adopted).

## 12. Founder decisions (recorded July 23, 2026)

- **max_rounds default: 10** (was 6 in draft; broker clamp range widens to 1..12).
- **Jonathan's environment: native Windows** (PowerShell) — demo and SETUP.md lead
  native; WSL stays documented as the alternate column.
- **Launch post: NO iMessage origin story** — the post stands on the demo + spec.
- **Name: shortlist checked against npm July 23** — tenfour / redphone / crossband all
  AVAILABLE; final pick pending founder.
- Gate-rule scope: recommendation presented (per-project default + doctor warning);
  awaiting founder pick.
