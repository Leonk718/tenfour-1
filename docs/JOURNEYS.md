# tenfour — journeys, use cases, and the agent experience

**Status: DRAFT v0.95 companion to DESIGN.md — post-panel, critic fixes applied. Pending Codex round 2.**

## 1. Positioning (one sentence that survives Reddit)

**Certified mail between your Claudes — not a chat app.** Durable, human-gated,
async by design. Copy never apologizes for asynchrony; it explains the cadence.
The mailbox metaphor governs every string: tenfour is a mailbox, not a doorbell.

## 2. User journeys and use cases

| # | Journey | Personas | Kind sequence | v1 status |
|---|---|---|---|---|
| J0 | First contact: install → pair → hello | any pair, macOS↔Windows | (setup; `hello` carve-out thread) | core |
| J1 | Design→dev handoff (the canonical flow) | brian/design → jonathan/web | task → accepted → result → change_request* → done | **core, README golden path** |
| J2 | Reverse ask: dev needs a missing state/asset | jonathan/web → brian/design | (a) mid-task blocking `question` in-thread, then `tenfour_wait`; (b) fresh small `task` back | core |
| J3 | Quick question, no formal task | either | question → answer (micro-thread; `answer` closes it — ruled) | core |
| J4 | Morning catch-up: session opens onto queue | either | SessionStart digest → human triage → per-thread | core |
| J5 | Same human, two machines (desktop+laptop) | brian ↔ brian-laptop | same rails; `init --same-human` pre-writes standing rules, skips pairing ceremony | emergent, documented |
| J6 | OSS pairs: remote teammates / maintainer+contributor / agency+client | any | J1/J2/J3 by transitivity; trust asymmetry = receiver's standing rules | emergent |
| J7 | needs_human escalation: thread freezes | both humans | broker `needs_human` to both; humans decide; fresh human-approved message unfreezes | core |
| — | Realtime pair-programming chat | — | — | **explicitly unsupported; README says so** |

**Goals → how achieved:**
- *Durable handoff while the peer is closed* → broker queue + SessionStart injection (J4).
- *Human control on both ends* → outbound task prompts sender's human; inbound work
  starts on receiver's "go"; **consent scope RULED: "go" covers the whole thread**
  (subsequent change_request rounds run under it; re-prompt only after an unfreeze).
  The round budget is shown to humans in every digest ("round 3/6") so the cap is
  never a surprise (critic fix).
- *No loops* → broker round caps/rate ceilings (DESIGN §4.4), plus strings engineered
  so the model never wants to send thanks-noise (below).
- *Cross-machine trust* → pairing code ceremony (§3), token-derived identity.
- *Agent ergonomics* → §4: the strings are the API.

## 3. Setup journey (asymmetric — only one founder ever touches Convex)

- **Distribution**: `npm install -g <pkg>` (name TBD; "tenfour" is taken on npm — decide
  scoped `@scope/tenfour` vs distinct name BEFORE any docs are written). Broker source
  ships inside the package; `tenfour init --create-broker` runs the Convex CLI against a
  bundled staging dir. **Jonathan needs no Convex account, ever.**
- **Owner flow (Brian, macOS, ~6 min)**: `init --create-broker` → convex login/deploy →
  admin key minted + stored 0600 → agent `brian` issued → MCP registered at **user scope
  via `claude mcp add`** (never touches any project `.mcp.json`) → hooks merged into
  `~/.claude/settings.json` with sentinel-substring idempotency, timestamped backup,
  abort-on-invalid-JSON → gate rules offered (opt-in prompt; **scope caveat shown**:
  user-scope rules add ask-prompts in ALL repos — critic flagged; the prompt says so
  honestly and offers per-project alternative) → `tenfour doctor` auto-runs.
- **Joiner flow (Jonathan, Windows, ~5 min)**: SETUP.md Windows column **leads with the
  ExecutionPolicy pre-step** (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` with
  a one-line explanation, `tenfour.cmd` as the no-policy-change alternative) because the
  npm `.ps1` shim otherwise kills the literal first command (critic catch). WSL
  divergence table: the environment test locates BOTH `claude` and `npm` (interop trap:
  Windows npm on WSL PATH installs to the wrong side), nvm recommended in WSL, drvfs
  warning names a concrete non-drvfs path (`export TENFOUR_HOME=$HOME/.tenfour` only when
  `$HOME` is ext4; otherwise `/home/<user>/.tenfour` explicitly).
- **Pairing**: `tenfour invite jonathan` emits a one-line `TENFOUR1.` base64url code with
  embedded checksum. **Primary recommended channel: shared password-manager item**
  (cross-platform, no retyping); iMessage documented as secondary with the Windows
  caveat spelled out (code lands on a phone, joiner is on a PC — critic catch).
  `tenfour join` prompts with masked paste → decodes → **prints "joining as X to Y —
  correct? [Y/n]" before any network call** (paste-mangling defense) → redeems
  (invited→active, single-use) → prints the covenant line: *"Received tasks will
  surface in your Claude sessions but will NEVER auto-run. You say go."* Docs: delete
  the code message after pairing; clipboard-history caveat (Win+V) noted.
- **Secrets on Windows**: `icacls` inheritance-strip + sole-user grant (Credential
  Manager/DPAPI rejected: no maintained Node bindings, breaks WSL + CI). Doctor parses
  the ACL and fails on Everyone/BUILTIN\Users.
- **`tenfour doctor`**: 12 named checks, **execute-not-inspect** (spawns the exact hook
  command strings and round-trips a self-message through the broker; a quoting bug on
  `C:\Users\Jonathan Smith` fails loudly here instead of becoming silent hook death).
  Toast check wording is honest: "test toast dispatched (if you didn't see it, check
  Focus Assist)". CI-friendly exit codes; `--fix` where safe.
- **First round-trip**: `tenfour hello` — meet-in-the-middle CLI (neither founder needs
  a Claude session open), riding a broker-side `purpose:"hello"` thread carve-out
  (round-cap exempt, auto-pruned 24h; **confirmed in v1 scope** — the celebration
  moment is an adoption feature). Output ends with exactly what to do next on each side.

## 4. The agent experience (the strings ARE the product)

Doctrine (all model-facing strings): (1) success-shaped non-errors — a duplicate send
returns `{"status":"duplicate", "note":"already delivered; no action needed"}`, never
an error (errors trigger repair loops); (2) every error states what happened, what is
true now, and the one action INSTEAD — never anything retryable-sounding; (3) state the
model needs is carried in tool responses, never assumed remembered (compaction-proof).

- **`client_id` is minted by the adapter**, never the model (models are bad entropy
  sources; a reused literal = silent message loss — critic catch). Tool responses echo it.
- **One error namespace**: `TENFOUR/<CODE>` across broker, adapter, PROTOCOL.md, and
  docs; all strings live in a shared `strings.ts`, snapshot-tested, **build-time
  extracted into the docs** so README/PROTOCOL can never drift from the wire (critic
  catch: three lenses had invented three vocabularies).
- **Ack contract**: ack = *received and surfaced to my human*. Deferral is a valid
  outcome; the response to an ack-without-reply is neutral ("noted"), not a nag that
  triggers repair behavior. Repeat-acks are success-shaped idempotent. The Stop hook
  text is **surface-first**: "New tenfour message arrived: <summary>. Tell your human
  what arrived. Only begin work on it if your human's standing rules explicitly cover
  it." (Critic: "handle it" listed first read as license to start real work at
  end-of-turn.)
- **`accepted` is sent by the adapter** when the human says go (hook-mediated), not by
  model discipline — the one kind with a strict timing window is now structurally
  correct (both critics favored this).
- **SessionStart digest**: surface-to-human FIRST, act second ("Tell your human: N
  tenfour messages await: <one-line each, capped at 5, 'run tenfour inbox for more'>. Do
  not begin work until your human directs you."), full wrapper only when exactly one
  message.
- **`tenfour_wait`**: legal when the human asked to wait OR after sending a blocking
  in-thread `question` on active work (J2-a — critic fix to the over-strict rule).
  Timeout copy teaches the cadence: "No reply within 300s — this is normal. Ending
  your turn now is the designed behavior; the reply will arrive via your inbox."
- **Wrapper echo rule narrowed**: forbid echoing the *framing sentences and nonce
  markers*; the body content is quotable (PRs must restate the task — critic caught
  the overbroad rule breaking legitimate work). The broker-side echo scan matches
  framing + nonce patterns only, and docs paraphrase rather than quote the framing
  (dogfooding false-positive fix).
- **Push-before-send**: the adapter runs `git ls-remote` verification on sha-pinned
  artifacts before `task`/`result` sends — an unpushed sha would burn a protocol round
  on a confusing peer-side error (critic catch).
- **Wrong-repo injection**: tasks carry a repo slug; injection in a non-matching cwd
  says "this task targets <repo> — tell your human to open a session there," and
  re-delivery is bounded by the journal, not infinite.
- **CLAUDE.md protocol block**: shipped in `examples/`, paste-ready, covering kinds,
  authority rule, error handling, and the two cadence rules (end-turn-is-happy-path,
  round budget awareness). Kept in sync from `strings.ts` at build time.

## 5. Failure journeys (unified grammar, v1 scope)

Every failure speaks `TENFOUR/<CODE>` + what-is-true-now + one next command. V1-handled:
wrong/revoked token (join re-prompt / AUTH_REVOKED with `tenfour join` re-pair), hooks
not firing (doctor execute-check; OneDrive/path-with-spaces surfaced there), broker
unreachable (send fails visibly with "message NOT queued" — no phantom outbox; session
start **fails open** with a warning line, never blocks Claude), peer silent (staleness
shown in digests: "sent 3d ago, unacked" — no presence system needed), stuck-queued
(same surface + `tenfour status` **ruled in as a CLI command**), dashboard hand-edits
(journal detects gaps, doctor names likely cause), same-machine collision (warn +
last-connect-wins + demoted session told on next tool call; Stop-hook lease check noted
as v1.1), crashed-before-ack (journal redelivery with explicit "possible redelivery —
verify you haven't already handled this" preamble), WSL clock skew (broker timestamps
only — design rule, docs note), ExecutionPolicy + OneDrive (SETUP pre-steps, doctor).
Deferred with names: snooze/remind-me-Friday (v1.1), demoted-session eager notice,
optional `parent_thread` linkage field (v1.1, reserved in schema now).

## 6. Docs & launch plan

README order: 30-second pitch → **real Mac↔Windows demo GIF recorded first** (any
fakery is fatal; 30-45s script: send task on mac → toast+SessionStart on Windows →
accepted+work → result → done; ~10MB budget checked before committing format) →
4-step quickstart teaser → security-in-60-seconds (honest labels, quotes paraphrased) →
FAQ inline with the five pre-written Reddit answers (why-not-Slack/GitHub-issues,
Convex lock-in → broker interface, "two AIs = loop machine" → broker-enforced caps
with the freeze demo, "does my code transit a third party" → refs-not-content + honest
broker-plaintext note, why-only-2-agents → scope honesty). PROTOCOL.md = the 13-section
spec with the full state table (generated from the same source as the tests).
SECURITY.md = threat model up front, disclosure via GitHub Private Vulnerability
Reporting (company-domain email = founder decision). Versioning: protocol `tenfour/1`
frozen at launch; package semver independent; compat policy stated.

## 7. Open decisions for the founders (consolidated, final list)

1. **Project + npm name** (blocking all docs; "tenfour" taken).
2. Jonathan's actual environment (native vs WSL) — docs cover both, demo leads with his real one.
3. Gate rules scope: user-scope (friction everywhere) vs per-project (weaker default) — default shipped: opt-in user-scope with honest prompt.
4. `max_rounds` default 6 — confirm.
5. Symmetric tasks day one — recommended yes (J2-b depends on it).
6. Launch post: include the iMessage duct-tape origin story/screenshots? (Great Reddit material; exposes internal workflow — founder call.)

## 8. v0.96 corrections (post Codex round-2)

Ack = model-received (§4's "surfaced to my human" rescinded — R2). Push-check is the
local ancestor test, not ls-remote (R5). `hello` celebration moment now rides the
diag.ping broker method — same UX, no protocol carve-out (R6). `accepted` via
`tenfour accept <thread>` or MCP confirm gesture — the adapter never infers "go" from
prose (R8). J3 micro-threads are now first-class wire citizens (R3/R4). Dispatcher
responsiveness: PostToolUse mid-turn injection + `tenfour standby` duty-officer mode
added to J3/J4 (R1) — an always-on PC answers status questions in seconds-to-minutes.
