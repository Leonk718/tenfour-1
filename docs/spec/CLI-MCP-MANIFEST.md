# tenfour spec — CLI + MCP MANIFEST

**Status: NORMATIVE, v1.0-draft. Part of the tenfour/1 normative artifact set required by DESIGN.md §11 R13. Command set is R12-synced (final: nine commands).**
**Scope: every CLI command, every MCP tool, doctor's 14 checks, the four installed hooks, and Windows-native specifics. Jonathan's column is NATIVE Windows PowerShell; WSL is the alternate column (founder decision, DESIGN §12).**

The key words MUST, MUST NOT, REQUIRED, SHOULD, MAY are per RFC 2119. Rule IDs:
`CLI-…`, `MCP-…`, `DOC-…`, `HK-…`, `WIN-…`.

---

## 0. Conventions

- `TENFOUR_HOME` defaults to `~/.tenfour` (POSIX) / `%USERPROFILE%\.tenfour` (Windows).
  Every command and hook honors the `TENFOUR_HOME` env override (WSL drvfs guidance,
  JOURNEYS §3).
- All broker rejections print to stderr as `TENFOUR/<CODE>: <what happened>. <what is
  true now>. <one next action>` — the canonical registry codes only.
- Global flags on every command: `--json` (machine output), `--quiet`, `--home <dir>`.
- **CLI-001** Global exit codes (uniform; doctor adds its own in §4):

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Broker rejected the operation; a `TENFOUR/<CODE>` line was printed |
| 2 | Local error (config missing/invalid, journal, git, filesystem) |
| 3 | User aborted at an interactive confirmation |
| 64 | Usage error (unknown flag/arg) — EX_USAGE |

- **CLI-002** No tenfour command ever executes PowerShell, bash, or any shell script.
  All executable surfaces are `node <file>.mjs`. (This is the Windows
  ExecutionPolicy containment — see §6.)
- **CLI-003** Files under `TENFOUR_HOME`:

| Path | Contents | Permissions |
|---|---|---|
| `config.json` | `broker_url`, `agent`, `peer`, `workspaces[]` (absolute paths), `allowed_repos[]`, `standing_rules` (R9) — canonical Zod schema: `packages/schema/src/config.ts` | 0600 / icacls-tightened (§6) — same doctrine as credentials |
| `credentials.json` | bearer token (plaintext locally; sha256-hashed at rest on broker) | 0600 / icacls-tightened (§6) |
| `admin.json` | broker admin key (owner machine only, `--create-broker`) | 0600 / icacls-tightened |
| `bin/tenfour-hook.mjs` | single self-contained (esbuild-bundled, dependency-free) hook entry | 0755 |
| `bin/tenfour-mcp.mjs` | self-contained MCP server entry | 0755 |
| `journal/` | delivery journal (fsync'd, states per delivery spec) + outbound ops table (R11) | 0700 dir |
| `broker-src/` | bundled Convex staging dir (owner machine only) | default |

  **DECIDED HERE:** `init` copies bundled, dependency-free hook/MCP entry scripts into
  `TENFOUR_HOME/bin/` rather than pointing hooks at the npm global tree — nvm/npm-prefix
  switches and global reinstalls can never silently break hooks.

---

## 1. CLI command manifest

**Nine commands (R12, FINAL):** `init`, `invite`, `join`, `accept`, `approve`,
`token`, `doctor`, `status`, `inbox`.

**DECIDED HERE (reserved names):** `standby` (R1c duty-officer mode) is specified in
the delivery spec and its command name is reserved but not part of the v1.0 manifest
table, matching R12's synced list. `hello` no longer exists as a command (R6): the
first-round-trip celebration moment is emitted automatically at the end of joiner-side
`tenfour join` (a `diag.ping` round trip with celebratory copy) and is visible
owner-side via `tenfour status` / `tenfour doctor`. There is NO `revoke` command:
consent revocation is RESERVED for v1.1 (WIRE D20; CONSENT §7).

### 1.1 `tenfour init`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour init [--create-broker] [--workspace] [--same-human <peer-agent>] [--yes]` |
| Purpose | Local machine install; with `--create-broker`, owner-side broker provisioning |
| Requires network | No (base). Yes (`--create-broker`: Convex deploy) |

Base behavior, in order (all idempotent; re-running repairs):

1. Create `TENFOUR_HOME` tree (§0 table); copy `bin/` entries from the npm package.
2. Merge the four hooks (§5) into `~/.claude/settings.json`:
   parse → **abort with exit 2 if existing JSON is invalid (file untouched)** →
   write timestamped backup `settings.json.tenfour-backup-<ISO8601 basic>` →
   insert/replace entries by sentinel substring (§5.3) → write.
   MUST merge, never clobber; MUST NOT duplicate (sentinel idempotency).
3. Register the MCP server at **user scope**:
   `claude mcp add tenfour --scope user -- node "<abs TENFOUR_HOME>/bin/tenfour-mcp.mjs"`.
   MUST NOT touch any project `.mcp.json` (JOURNEYS §3).
4. Initialize `journal/` (empty journal + outbound ops table).
5. Offer gate rules (opt-in prompt, honest scope caveat). Gate rules are
   **PER-PROJECT** (founder decision): the prompt directs the user to run
   `tenfour init --workspace` inside each repo that will receive tenfour work.

Flag behavior:

| Flag | Effect | Files touched |
|---|---|---|
| `--create-broker` | Runs Convex CLI (login + deploy) against bundled `broker-src/`; mints admin key → `admin.json` (0600/icacls); issues the owner agent (prompts for agent name, e.g. `brian/design`) → `credentials.json`; prompts for `allowed_hosts` (default `["github.com"]`, ARTIFACTS ART-030); auto-runs `tenfour doctor` at the end | `admin.json`, `credentials.json`, `config.json`, `broker-src/` |
| `--workspace` | MUST be run inside a git repo. Merges the per-project gate rules (§5.5) into `<repo>/.claude/settings.json` (same backup + sentinel discipline as step 2) and appends `{path, repo_id}` to `workspaces[]` in `config.json`. **DECIDED HERE:** this is the mechanism that "designates a repo as a tenfour workspace"; doctor check DOC-09 warns on target repos not so tagged | `<repo>/.claude/settings.json`, `config.json` |
| `--same-human <peer>` | J5: pre-writes standing rules for a same-human peer into `config.json`; skips the pairing ceremony copy in output | `config.json` |
| `--yes` | Non-interactive: accept defaults, skip opt-in prompts (gate-rule prompt answers "no" — consent is never defaulted to yes) | — |

Exit codes: global table. `--create-broker` Convex failure ⇒ exit 2 with the Convex
stderr excerpt and one next action.

### 1.2 `tenfour invite`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour invite <agent-name> [--ttl <hours>]` |
| Purpose | Owner mints a single-use pairing invite for a peer agent |
| Requires | `admin.json` (owner machine); network |
| Side effects | Broker: invite record `{name, ttl, single_use}`. Local: none — the code is printed once and **never persisted locally** |
| Output | One line: `TENFOUR1.<base64url payload with embedded checksum>` + channel guidance (password-manager primary; iMessage secondary with the Windows caveat) |
| Defaults | `--ttl 24` hours. **DECIDED HERE (amended — WIRE §8.2 D27 owns TTL):** default `ttl_s` 86400 (24 h), broker-clamped to 300 s–604800 s (7 d); `--ttl <hours>` converts to `ttl_s`. Expired redemption ⇒ `TENFOUR/INVITE_EXPIRED` at join |
| Re-issue rule | **DECIDED HERE:** issuing a new invite for the same agent name invalidates all prior unredeemed invites for that name (single outstanding invite per name; prevents stale-code confusion) |
| Errors | `TENFOUR/AUTH_FAILED` (bad/missing admin key ⇒ exit 1); `CLIENT_ID_CONFLICT` n/a; exit 2 if no `admin.json` |

### 1.3 `tenfour join`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour join [--code <code>]` |
| Purpose | Joiner redeems an invite and completes local install in one command |
| Requires | Network |

Behavior, in order:

1. If the machine is not initialized, perform `init` base steps 1–4 first.
   **DECIDED HERE:** `join` implies base `init` — the joiner (Jonathan, ~5 min) runs
   exactly one tenfour command after `npm install -g`.
2. Prompt for the code with **masked paste** (`--code` accepted but printed with a
   shell-history warning). Decode; verify embedded checksum; checksum failure ⇒
   `TENFOUR/INVITE_INVALID` locally, exit 1, **before any network call**.
3. Print `joining as <agent> to <broker-host> — correct? [Y/n]` and wait.
   Decline ⇒ exit 3, nothing sent (paste-mangling defense).
4. Redeem (invited → active, single-use). Errors: `TENFOUR/INVITE_INVALID`,
   `TENFOUR/INVITE_EXPIRED` (exit 1, copy names `tenfour join` with a fresh invite as
   the next action).
5. Write `credentials.json` (0600/icacls §6), `config.json`.
6. Emit the celebration round trip via `diag.ping` with `mark:"hello"` (R6 — no
   thread, no protocol state; the owner side sees it via `tenfour status`/`doctor`)
   and print the covenant line verbatim (bytes owned by `strings.ts`
   `COVENANT_LINE`), then per-side next steps.
7. Print the hygiene reminders: delete the code message; Windows clipboard-history
   (Win+V) caveat.

Files touched: everything in `init` base, plus `credentials.json`, `config.json`.

### 1.4 `tenfour accept`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour accept <thread-id>` |
| Purpose | R8 structured consent gesture — the human-side path to `accepted` |
| Requires | Network; `credentials.json` |

Behavior: fetch thread → verify state `offered` and caller is the recipient → send
`kind:accepted` with `consent: {token, granted_via: "cli_accept"}` (adapter-minted
`client_id`, `parent_id` = current head — WIRE §7.1) → broker records consent
`{granted_via, granted_at, scope: "whole_thread"}` (R9; `protocol.ts
ConsentRecordSchema`) → print confirmation including the round budget
(`round 1/10`).

| Errors → exit 1 | `TENFOUR/THREAD_NOT_FOUND`, `NOT_THREAD_PARTY`, `TERMINAL_THREAD`, `THREAD_FROZEN`, `CONSENT_REQUIRED` (stale token), `AUTH_REVOKED` |
| --- | --- |
| `STALE_HEAD` handling | **DECIDED HERE:** the CLI refetches the head and retries the send exactly once; a second `STALE_HEAD` is surfaced as-is (exit 1). Retry uses a fresh `client_id` since content (parent) changed — consistent with R11 hashing |

Side effects: broker message + consent record; local outbound ops entry (R11). No
local file edits.

### 1.5 `tenfour approve`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour approve <thread-id>` (ULID or ≥ 8-char unambiguous prefix, as `accept`) |
| Purpose | The unfreeze gesture (STATE §6.2; WIRE §7.1.3 D21): mints a single-use, 24 h-expiry unfreeze consent record for a `frozen` thread |
| Requires | Network; `credentials.json` |
| Operator | **Either** human party (J7: "humans decide") |
| Behavior | Fetch thread → verify state `frozen` → print the freeze reason, `resume_state`, and round budget **before** minting → mint the unfreeze consent record → print the `consent_ref` note: the agent's next send into the thread carries `consent_ref` and resumes it (stamped `unfroze: true`; round counter resets) |
| Errors → exit 1 | `TENFOUR/THREAD_NOT_FOUND`, `NOT_THREAD_PARTY`, `TERMINAL_THREAD`; approving a non-frozen thread is a success-shaped no-op ("thread is not frozen — nothing to approve", exit 0) |
| Side effects | Broker unfreeze consent record; no message is sent by this command |

### 1.6 `tenfour token`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour token rotate` \| `tenfour token revoke [--agent <name>]` |
| Purpose | Credential lifecycle (broker control-plane, AUTH §9–§10). Revocation is immediate; rotation has an overlap window (AUTH ROT-1) |

| Subcommand | Behavior | Files touched | Notes |
|---|---|---|---|
| `rotate` | Mints a new 256-bit token for **self**; broker stores sha256; the OLD token stays valid during the AUTH ROT-1 overlap window — **10 minutes, or until the first successful call with the new token, whichever comes first** — then is retired to the revoked-hash list; rewrites `credentials.json`; re-applies 0600/icacls | `credentials.json` | Prints: restart any open Claude sessions (the MCP server holds the old token in memory; the overlap window covers the restart) |
| `revoke` | Self by default: invalidates own token, truncates `credentials.json` to `{}`. With `--agent <name>`: requires `admin.json` (owner machine) — revokes the peer | `credentials.json` (self) / none (peer) | Recovery path printed: fresh `tenfour invite` + `tenfour join`. **DECIDED HERE:** `rotate` is self-only; peer revocation requires the admin key |

Errors: `TENFOUR/AUTH_FAILED`, `AUTH_REVOKED` (already revoked ⇒ success-shaped note
"already revoked; nothing to do", exit 0).

### 1.7 `tenfour doctor` — see §4 (14 named checks)

| Synopsis | `tenfour doctor [--fix] [--strict] [--json]` |
|---|---|

### 1.8 `tenfour status`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour status [--json] [--clear-ops]` |
| Purpose | Human dashboard: threads, states, staleness, stuck outbound |
| Sources | Broker `thread`/`inbox` queries + local journal + outbound ops table (R11) |
| Output columns | thread id (short), peer, state, `round n/m`, last kind, last activity age, delivery flag (`queued`/`claimed`/`injected`/`acked`), staleness line for unacked sends (`sent 3d ago, unacked` — JOURNEYS §5), outbound ops stuck in `prepared`/`sending` (the no-phantom-outbox surface), abandoned ops awaiting acknowledgment (DEL-40) |
| Side effects | Read-only EXCEPT `--clear-ops`, a documented **mutation flag**: it acknowledges surfaced abandoned/resolved outbound-op records in the local journal (DELIVERY DEL-40) so they stop appearing. No broker state is ever touched |
| Exit codes | 0 (stale items do NOT change the exit code); 1 broker rejection; 2 local error |

### 1.9 `tenfour inbox`

| Aspect | Specification |
|---|---|
| Synopsis | `tenfour inbox [--thread <id>] [--all] [--json]` |
| Purpose | List queued/undelivered/blocked messages; re-surface a specific thread |
| Behavior | Default: pending + blocked messages, one line each (sender, kind, age, repo, blocked_reason if any). `--thread <id>`: prints the full wrapped body to stdout AND marks a journal re-surface attempt — this is the documented recovery step after `REPO_NOT_ALLOWED` (ARTIFACTS ART-104/107). `--all`: include acked history |
| Side effects | `--thread` writes a journal surface-attempt record; otherwise read-only |
| Exit codes | Global table; unknown thread ⇒ `TENFOUR/THREAD_NOT_FOUND`, exit 1 |

### 1.10 Files-touched summary

| Command | `~/.claude/settings.json` | `TENFOUR_HOME` config/creds | `TENFOUR_HOME/bin,journal` | Project `.claude/settings.json` | Broker state |
|---|---|---|---|---|---|
| `init` | merge (backup) | config | yes | `--workspace` only | `--create-broker` only |
| `invite` | — | — | — | — | invite record |
| `join` | merge (via implied init) | config + creds | yes | — | redemption |
| `accept` | — | — | journal/ops | — | message + consent |
| `approve` | — | — | journal | — | unfreeze consent record |
| `token` | — | creds | — | — | token hash |
| `doctor` | read-only | read-only | temp journal only | read-only | `diag.ping` only |
| `status` | — | read-only | read-only (`--clear-ops`: journal ops acknowledgment) | — | read-only |
| `inbox` | — | read-only | surface record | — | read-only |

---

## 2. MCP tool manifest

Five tools served by `bin/tenfour-mcp.mjs`, registered at user scope. Tool input
schemas set `additionalProperties:false`; unknown properties fail locally with a
teaching message (never reach the broker). `client_id` is **never** a tool input —
the adapter mints it (JOURNEYS §4).

**DECIDED HERE (amended):** the R8 "MCP confirm tool" is named **`tenfour_confirm`**
— matching CONSENT.md §3.2 and `strings.ts TOOL_CONFIRM_DESCRIPTION` (and avoiding
collision with the CLI command `tenfour accept`).

Schema source of truth — the `packages/schema` package MUST export these modules
(normative module map; the package is authored against this table; in the current
tree the `wire/*` exports all live in `packages/schema/src/protocol.ts`, which
re-exports per this map when the split lands):

| Module | Exports |
|---|---|
| `packages/schema/src/wire/envelope.ts` | `SendRequestSchema`, `StampedEnvelopeSchema` |
| `packages/schema/src/wire/kinds.ts` | `KindSchema` (10 literals) |
| `packages/schema/src/wire/artifacts.ts` | `ArtifactSchema` (discriminated union per ARTIFACTS §1) |
| `packages/schema/src/wire/errors.ts` | `ErrorCodeSchema` (the 20 canonical codes), `WireErrorSchema` |
| `packages/schema/src/wire/diag.ts` | `DiagPingRequestSchema`, `DiagPingResponseSchema` |
| `packages/schema/src/config.ts` | `TenfourConfigSchema`, `StandingRulesSchema` (canonical `~/.tenfour/config.json` schema) |
| `packages/schema/src/mcp/send.ts` | `TenfourSendInputSchema`, `TenfourSendOutputSchema` |
| `packages/schema/src/mcp/ack.ts` | `TenfourAckInputSchema`, `TenfourAckOutputSchema` |
| `packages/schema/src/mcp/thread.ts` | `TenfourThreadInputSchema`, `TenfourThreadOutputSchema` |
| `packages/schema/src/mcp/wait.ts` | `TenfourWaitInputSchema`, `TenfourWaitOutputSchema` |
| `packages/schema/src/mcp/confirm.ts` | `TenfourConfirmInputSchema`, `TenfourConfirmOutputSchema` |
| `packages/schema/src/cli/exit-codes.ts` | `EXIT` constants (§0 CLI-001, §4 DOC-12x) |

**MCP-001** Protocol rejections are returned as structured tool **results** (not MCP
protocol errors): `{status:"error", code:"TENFOUR/<CODE>", what_happened,
what_is_true_now, next_action, retryable:false}`. Field mapping from the wire error
shape (WIRE §9.1 / `strings.ts toWireError`): `message` → `what_happened` +
`what_is_true_now` (the two clauses, `ERRORS.<CODE>.what` and `.now`);
`human_action` → `next_action`. Rationale (doctrine, JOURNEYS §4):
result content steers model behavior; transport-level errors trigger repair loops.

### 2.1 `tenfour_send` — `mcp/send.ts`

| Input field | Type | Notes |
|---|---|---|
| `to` | agent name | REQUIRED |
| `kind` | one of the 10 kinds | REQUIRED. `accepted` is REJECTED here (MCP-010 below) |
| `thread_id` | ULID \| null | null legal only for `task` and `question` (R3) |
| `in_reply_to` | message id | **MODEL-SUPPLIED**, REQUIRED when `kind:answer` (R4) — the id of the question being answered; distinct from concurrency `parent_id`, which the adapter supplies automatically from the thread head |
| `repo` | canonical repo-id | REQUIRED iff `kind:task` (R10); forbidden otherwise |
| `body` | markdown ≤ 16 KB | REQUIRED; adapter NFC-normalizes |
| `artifacts` | array per ARTIFACTS §1 | optional; ancestor check runs pre-send (ARTIFACTS §8) |

| Output (`status`) | Shape |
|---|---|
| `"sent"` | `{status, envelope:<canonical stamped envelope>, round:{n,max}, client_id}` |
| `"duplicate"` (R7) | `{status:"duplicate", note:<strings.ts SEND_DUPLICATE_NOTE — names the message id and its current delivery_state>, envelope:<canonical original>, delivery_state:"queued"\|"claimed"\|"injected"\|"acked"}` — success-shaped, never an error |
| `"error"` | MCP-001 shape |

**MCP-010** `tenfour_send` MUST reject `kind:accepted` locally with the message
owned by `strings.ts` export `SEND_ACCEPTED_REJECTED` (which names `tenfour accept
<thread>` and the `tenfour_confirm` tool — never `tenfour_accept`, which does not
exist). (R8: `accepted` is structurally gated, not model-disciplined.)

**MCP-011** Outbound idempotency (R11): before transmit, the adapter persists
`prepared(client_id, content_hash)` → `sending` → `confirmed` in the journal ops
table; network retries reuse the original `client_id`. Broker failure to confirm
leaves `sending`; the next adapter start re-sends the SAME `client_id` (dedup-safe by
R7) — never a phantom outbox.

### 2.2 `tenfour_ack` — `mcp/ack.ts`

| Input | `{message_id, attempt_id}` — both REQUIRED, from the delivery wrapper |
|---|---|
| Output | `{status:"acked"}` or `{status:"already_acked", note:"noted"}` — repeat acks are success-shaped idempotent (R2: ack = model-received, nothing more) |
| Errors | `NOT_THREAD_PARTY`, `THREAD_NOT_FOUND` per MCP-001 |

### 2.3 `tenfour_thread` — `mcp/thread.ts`

| Input | `{thread_id}` |
|---|---|
| Output | `{thread_id, state, frozen:boolean, head:<message id>, round:{n,max}, consent:{present:boolean, scope}, repo, messages:[<stamped envelopes, seq order>]}` — everything the model needs is in the response; nothing is assumed remembered (compaction-proof doctrine) |
| Errors | `THREAD_NOT_FOUND`, `NOT_THREAD_PARTY` |

### 2.4 `tenfour_wait` — `mcp/wait.ts`

| Input | `{thread_id, timeout_s}` — `timeout_s` default 300, min 10, max 600 (**DECIDED HERE:** max 600 keeps a blocked turn under Claude Code tool-timeout norms) |
|---|---|
| Legality | Only when the human asked to wait OR immediately after sending a blocking in-thread `question` on active work (J2-a). The tool description carries this rule verbatim |
| Output (message) | `{status:"message", envelope:<wrapped delivery>, attempt_id}` — journaled through the same local client as hooks (atomic claim; once per attempt) |
| Output (timeout) | `{status:"timeout", note:<strings.ts WAIT_TIMEOUT_NOTE>}` |

### 2.5 `tenfour_confirm` — `mcp/confirm.ts`

| Input | `{thread_id, consent_token}` — the token is minted by the broker per offered task and surfaced in the delivery wrapper (R8: echo proves the model read the surfaced message under a human "go"; the token is wire-visible to both parties per WIRE D16, but only the recipient's `accepted` is role-legal) |
|---|---|
| Gesture | The Claude Code **permission prompt** this tool raises is the human consent gesture (CONSENT §3.2): ask-rule required, allow-rule forbidden (F-3). It also serves as the MCP-side unfreeze gesture (STATE §6.2) |
| Output | `{status:"accepted", envelope, round:{n,max}}`; the adapter sends `kind:accepted` with `consent: {token, granted_via: "mcp_confirm"}`; the broker writes the R9 consent record `{granted_via, granted_at, scope: "whole_thread"}` |
| Token mismatch | **DECIDED HERE:** `{status:"error", code:"TENFOUR/CONSENT_REQUIRED", ...}` with the copy owned by `strings.ts` export `CONFIRM_TOKEN_MISMATCH` |
| Other errors | `TERMINAL_THREAD`, `THREAD_FROZEN`, `NOT_THREAD_PARTY`, `THREAD_NOT_FOUND`, `STALE_HEAD` (adapter auto-refreshes head once, as CLI §1.4) |

### 2.6 Broker diagnostic method

`diag.ping` (R6) is a broker interface method, NOT an MCP tool and NOT a message
kind. **WIRE §8.1 / `protocol.ts` own the shape**: authenticated request
`{protocol, auth, nonce?, mark?}` → response `{ok, pong, nonce, agent,
server_time, protocol_versions:["tenfour/1"], broker_version, peer:{agent,
last_ping_ts, last_mark} | null}`. Agent bearer tokens only (AUTH READ-6).
Excluded from threads, rounds, retention, and inbox — but NOT rate-exempt
(WIRE §10: 30/60 s). Consumers: doctor (§4), `join` step 6 (celebration ping,
`mark:"hello"`), `status --json` latency field. Schema: `wire/diag.ts`.

---

## 3. Hooks — installed set, exact shapes, sentinels

### 3.1 Command shape

**HK-001** All four hooks invoke the same entry with an event argument and the
sentinel flag. Paths are absolute, expanded at install time, double-quoted (spaces in
`C:\Users\Jonathan Smith` are the doctor's canonical quoting test). **DECIDED HERE:**
no env-var expansion (`$HOME`/`%USERPROFILE%`) is relied on inside hook command
strings — expansion behavior differs across shells; absolute paths are deterministic.

POSIX example / Windows example:

```
node "/Users/brian/.tenfour/bin/tenfour-hook.mjs" session-start --tenfour-hook-v1
node "C:\Users\Jonathan Smith\.tenfour\bin\tenfour-hook.mjs" session-start --tenfour-hook-v1
```

### 3.2 Exact `~/.claude/settings.json` shapes (HK-002)

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command",
                     "command": "node \"<ABS>/bin/tenfour-hook.mjs\" session-start --tenfour-hook-v1",
                     "timeout": 15 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
                     "command": "node \"<ABS>/bin/tenfour-hook.mjs\" user-prompt-submit --tenfour-hook-v1",
                     "timeout": 5 } ] }
    ],
    "PostToolUse": [
      { "matcher": "*",
        "hooks": [ { "type": "command",
                     "command": "node \"<ABS>/bin/tenfour-hook.mjs\" post-tool-use --tenfour-hook-v1",
                     "timeout": 5 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
                     "command": "node \"<ABS>/bin/tenfour-hook.mjs\" stop --tenfour-hook-v1",
                     "timeout": 10 } ] }
  ]
  }
}
```

**DECIDED HERE:** `SessionStart` matcher covers all four sources
(`startup|resume|clear|compact`) — queued-but-unacked messages must survive `/clear`
and compaction; the journal bounds redelivery, so re-matching is safe.

### 3.3 Sentinel + merge algorithm (HK-003)

- Sentinel substring: `--tenfour-hook-v1`.
- An entry is tenfour-owned iff any command string contains the sentinel.
- `init` merge: for each of the four events — if no owned entry exists, append one;
  if an owned entry exists, replace it in place (upgrade path). Non-tenfour entries
  are NEVER modified or reordered.
- Removal (no uninstall command in the R12 manifest — **DECIDED HERE:** deferred):
  SETUP.md documents manual removal = delete entries containing the sentinel.

### 3.4 Per-hook I/O contract (HK-004)

| Hook | Reads (stdin JSON) | Emits on stdout | Failure posture |
|---|---|---|---|
| `session-start` | session metadata | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<digest>"}}` — digest is surface-to-human FIRST, ≤ 5 one-liners + `run tenfour inbox for more`; full wrapper only when exactly one message; each line shows `round n/m` | **Fails open**: broker unreachable ⇒ exit 0 with a one-line warning as context; NEVER blocks session start |
| `user-prompt-submit` | prompt metadata | same shape, `"hookEventName":"UserPromptSubmit"`, prepending pending messages | fails open, exit 0 |
| `post-tool-use` | tool metadata | if pending arrivals: same shape, `"hookEventName":"PostToolUse"`, wrapped message (R1 mid-turn delivery); else empty, exit 0 | MUST NOT touch the network. Implementation: `stat` of the `journal/pending.flag` marker written by the MCP subscription (DELIVERY §5.1/§11); compare mtime to injected watermark; local, sub-ms. **DECIDED HERE:** marker filename `journal/pending.flag` |
| `stop` | includes `stop_hook_active` | if undelivered arrivals: `{"decision":"block","reason":<strings.ts STOP_HOOK_MESSAGE — the sole source of the bytes>}`; else exit 0, no output | **HK-005** MUST NOT block when `stop_hook_active:true` (loop guard) |

**HK-006** Doctor mode: with env `TENFOUR_DOCTOR=1` + `TENFOUR_JOURNAL_DIR=<temp>`,
every hook runs its full code path against the isolated temp journal and emits
`{"tenfour_doctor":"ok","event":"<event>"}`; never touches the live journal or broker.

### 3.5 Per-project gate rules (`init --workspace`) (HK-007)

Merged into `<repo>/.claude/settings.json` under the same backup/sentinel discipline
(sentinel key: `"_tenfour": "gate-rules-v1"` inside the permissions comment slot is
not possible in strict JSON — **DECIDED HERE:** ownership is tracked by an adjacent
`"_tenfour_gate_rules": "v1"` top-level key, ignored by Claude Code, used for
idempotent replace). The rule list implements the DESIGN §5 gate list as `ask`
patterns: merge, deploy, push-to-protected, secret access, dependency install,
destructive fs, spend, network exfil tools, modifying CLAUDE.md/hooks/CI/agent
config, persistence mechanisms, credential stores. The exact pattern strings live in
the `strings.ts` export `GATE_RULE_PATTERNS` (single source; snapshot-tested;
build-time extracted into docs).
Documented limit verbatim: shell indirection can evade pattern rules — the human gate
is the real boundary.

---

## 4. `tenfour doctor` — the 14 named checks (FINAL COUNT: 14)

Doctrine: **execute-not-inspect** (JOURNEYS §3). Doctor never mutates live protocol
state; the ONLY broker method it calls is `diag.ping` (R6); hook execution uses the
isolated temp journal (HK-006). Checks 13–14 fold in the CONSENT.md §10 checks —
one numbered list, no second manifest.

| # | Check ID | Verifies | Method | PASS | FAIL/WARN | Uses `diag.ping` | Uses temp journal | `--fix` |
|---|---|---|---|---|---|---|---|---|
| 1 | `config-parse` | `config.json` + `credentials.json` exist, parse, schema-valid | Zod parse | valid | FAIL: parse error + offending path | — | — | — |
| 2 | `credentials-perms` | secret file permissions | POSIX: mode == 0600. Windows: parse `icacls` output | sole-user access | FAIL if group/world readable; on Windows FAIL if any grant to `Everyone`, `BUILTIN\Users`, or `NT AUTHORITY\Authenticated Users` | — | — | yes (chmod / §6 icacls sequence) |
| 3 | `node-runtime` | node on PATH resolves and ≥ minimum version; same node the hook command strings use | spawn `node --version` via the exact hook prefix | ≥ min | FAIL + version found | — | — | — |
| 4 | `environment-path` | WSL/OneDrive/path traps | locate BOTH `claude` and `npm`; verify same side of the WSL boundary (interop trap); flag drvfs `TENFOUR_HOME`; flag OneDrive-synced `~/.claude` | clean | WARN drvfs/OneDrive; FAIL split claude/npm resolution | — | — | — |
| 5 | `broker-reach` | transport to broker | authenticated `diag.ping`, 10s timeout | response received | FAIL: unreachable / `UNSUPPORTED_VERSION` | yes | — | — |
| 6 | `auth-valid` | token accepted | same `diag.ping` response | authenticated as expected agent | FAIL: `AUTH_FAILED` / `AUTH_REVOKED` (+ re-pair copy) | yes (shared ping) | — | — |
| 7 | `clock-skew` | local clock vs broker | `server_time` from same ping vs local, RTT-compensated | \|skew\| ≤ 30s | WARN 30–300s; FAIL > 300s | yes (shared ping) | — | — |
| 8 | `hooks-execute` | all four hooks fire — execute-not-inspect | read `~/.claude/settings.json`; verify 4 sentinel entries; spawn each EXACT command string with `TENFOUR_DOCTOR=1`, `TENFOUR_JOURNAL_DIR=<temp>`; require exit 0 + `{"tenfour_doctor":"ok"}` | 4/4 | FAIL naming the event and the raw spawn error (quoting bugs on `C:\Users\Jonathan Smith` fail loudly HERE) ; missing sentinel ⇒ FAIL "not installed" | — | yes | yes (reinstall §3 shapes) |
| 9 | `gate-rules` | per-project gates in designated workspaces (founder decision) | for each `workspaces[]` entry: `<repo>/.claude/settings.json` contains `_tenfour_gate_rules` | all tagged workspaces have rules | FAIL: workspace missing rules (untagged-repo WARN moved to check 14) | — | — | yes (offer per-repo merge, with consent prompt) |
| 10 | `journal-integrity` | live journal readable, seq-gap-free, fsync-able | read-only scan + fsync probe on a scratch file in `journal/` | clean | FAIL: gap/corruption + likely cause named (e.g. "dashboard hand-edit", "restored from cloud sync") | — | — (read-only on live) | — |
| 11 | `repo-map` | every `repos` entry is a git checkout with the configured remote; ancestor-check machinery works | `git -C <path> rev-parse --git-dir`; `git cat-file -e HEAD^{commit}`; verify `refs/remotes/<remote>` exists; same env caps as ARTIFACTS §8.2 (no network) | all entries usable | FAIL per entry + one next action | — | — | — |
| 12 | `notify-toast` | OS notification dispatch | dispatch a test toast via the bundled cross-platform notifier | dispatch call succeeded | Copy is honest: `test toast dispatched (if you didn't see it, check Focus Assist / notification settings)`. FAIL only if dispatch call errors | — | — | — |
| 13 | `consent-ask-rule` | the R8 consent gesture fires (CONSENT §10) | for each tagged workspace: an ask-rule covers `tenfour_confirm`; scan every settings scope doctor can read for allow-rules matching it | ask-rule present everywhere, no allow-rule anywhere | FAIL: missing ask-rule or any allow-rule matching `tenfour_confirm` (F-3 — release-blocking) | — | — | yes (install ask-rule with consent prompt) |
| 14 | `workspace-tagged` | workspace coverage (CONSENT §10) | every repo named in `allowed_repos` or a queued inbound task appears (by derived repo-id) in `workspaces[]` | all covered | WARN: "untagged target repo — run tenfour init --workspace there" | — | — | — |

**DOC-120** Checks 5–7 share a single `diag.ping` round trip.
**DOC-121** Doctor exit codes: `0` all PASS; `4` warnings, no failures; `1` ≥ 1 FAIL;
`2` doctor itself could not run (e.g. no config). CI treats nonzero as red or
allowlists 4. **DECIDED HERE.**
**DOC-122** `--fix` is offered only where marked; every fix re-runs its check and
reports before/after. `--fix` never edits broker state.
**DOC-123** `--json` emits `{check_id, status, detail, fix_applied}` per check.

---

## 5. Windows-native specifics per command (WIN-xxx)

Jonathan's persona column: **native Windows PowerShell**. WSL is the alternate column
in SETUP.md, not here.

| Area | Rule |
|---|---|
| WIN-001 Paths | `TENFOUR_HOME` = `%USERPROFILE%\.tenfour`. All internal path handling uses Node `path.win32` semantics; every spawned command string double-quotes paths (spaces canonical test: `C:\Users\Jonathan Smith`) |
| WIN-002 icacls | Any command that writes `credentials.json`/`admin.json` (`init --create-broker`, `join`, `token rotate`) immediately runs, in order: `icacls "<file>" /inheritance:r` then `icacls "<file>" /grant:r "%USERDOMAIN%\%USERNAME%:F"` — inheritance strip + sole-user grant. Best-effort, documented as such (DESIGN §3); doctor check 2 is the verifier. Credential Manager/DPAPI rejected (no maintained Node bindings; breaks WSL + CI) |
| WIN-003 ExecutionPolicy | The `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` pre-step lives in **SETUP.md ONLY** — it unblocks npm's `tenfour.ps1` shim so the literal first command works in PowerShell. NO tenfour command ever runs or requires PowerShell at runtime (CLI-002); `tenfour.cmd` is the documented no-policy-change alternative shim |
| WIN-004 Hooks | Hook commands invoke `node.exe` directly with an absolute `.mjs` path (§3.1) — no `.ps1`, no `.cmd`, no shell scripts ⇒ ExecutionPolicy is irrelevant to hook firing |
| WIN-005 Notifications | Toast via the bundled cross-platform notifier; wording per doctor check 12 (Focus Assist honesty). Fires at hook moments only — no realtime-idle-alert claim |
| WIN-006 Journal | `journal/` writes use fsync; doctor check 10's fsync probe validates NTFS behavior. WARN if `TENFOUR_HOME` resolves into a OneDrive-synced directory (check 4) |
| WIN-007 MCP registration | `claude mcp add tenfour --scope user -- node "%USERPROFILE%\.tenfour\bin\tenfour-mcp.mjs"` — executed by `init` with the path pre-expanded to absolute (no `%VAR%` reliance, §3.1) |
| WIN-008 Clock | WSL clock-skew is out of scope for native Windows; ordering never depends on local clocks anywhere (broker `seq` is the primitive); doctor check 7 still validates sanity for display timestamps |

---

## 6. Conformance checklist

Every CLI-/MCP-/DOC-/HK-/WIN- rule maps to a test. Mandatory minimums: settings.json
merge idempotency (run `init` 3×, byte-identical after first — HK-003); invalid
settings JSON aborts untouched (CLI §1.1 step 2); `join` decline-at-confirm sends
nothing (network tap — §1.3.3); duplicate `tenfour_send` returns R7 shape (MCP §2.1);
`tenfour_send` local rejection of `kind:accepted` (MCP-010); consent-token mismatch
copy (MCP §2.5); Stop hook no-block under `stop_hook_active` (HK-005); PostToolUse
hook zero-network under `unshare -rn` (HK-004); doctor spawns hooks with a
space-containing profile path on the Windows CI runner (check 8); doctor exit codes
0/1/2/4 (DOC-121); icacls sequence applied and parsed (WIN-002 + check 2).
