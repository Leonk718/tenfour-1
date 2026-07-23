# tenfour/1 — CONSENT (normative)

**Status: NORMATIVE, v1.0-draft.** Part of the R13 normative artifact set (DESIGN.md §11).
Implements rulings **R8** (structured gesture), **R9** (consent is a broker record),
**R10** (first-class `repo` on `task`), and the JOURNEYS §2 consent-scope ruling
("go" covers the whole thread).

Requirements language per RFC 2119 / RFC 8174: **MUST**, **MUST NOT**, **SHOULD**,
**MAY** are normative only when capitalized.

All model-facing strings quoted in this document are **build-time extracted from
`packages/adapter/src/strings.ts`**, which is the single source of truth. If this
document and `strings.ts` ever disagree, `strings.ts` wins and the build is broken.

---

## 1. Model and principles

**Consent** is the receiving human's recorded authorization for implementation work on
one thread. It is a broker-side record, never an interpretation of chat text.

| # | Principle | Consequence |
|---|---|---|
| P1 | Consent is a **broker record** (R9) | Enforcement happens in the broker mutation, not in model discipline |
| P2 | Only **structured gestures** create records (R8) | Natural-language "go"/"sure"/"sounds good" detection MUST NOT create, modify, or imply consent |
| P3 | Scope is **`whole_thread`** | One grant covers the thread's full lifecycle, including later `change_request` rounds, until a re-consent trigger (§6) or thread termination. (Revocation is RESERVED for v1.1 — §7) |
| P4 | Consent gates specific wire operations (§9) | Everything else (ack, question, answer, declined, cancel, done, needs_human) is never consent-gated |
| P5 | Consent is **additive** to Claude Code permission rules | An active consent record never loosens, bypasses, or pre-answers any permission prompt. Merges and deploys remain human acts regardless of consent state |

**Consent party.** For a task-rooted thread, the consent party is exactly the `to`
agent of the root `task` (the receiver). The initiator never grants consent; the
initiator's control instruments are `cancel` and `done`. Question-rooted micro-threads
(R3) have **no consent party**: `question`/`answer`/`cancel` on them are never
consent-gated, and their consent state reads `not_required`.

---

## 2. The consent record

### 2.1 Schema (wire-visible)

The wire shape is `protocol.ts ConsentRecordSchema` — the sole owner. Prose recap:

| Field | Type | Required | Semantics |
|---|---|---|---|
| `thread_id` | ULID | yes | The thread this record governs (carried by the surrounding thread object). One record governs exactly one thread |
| `granted_via` | `"cli_accept"` \| `"mcp_confirm"` \| `"standing_rule"` | yes | How consent was granted (§3; `protocol.ts GRANTED_VIA`). No other values exist in `tenfour/1`; unknown values MUST be rejected |
| `granted_at` | integer ms since Unix epoch | yes | Broker clock, **display-only** (per DESIGN §4.1 timestamps are never ordering primitives) |
| `scope` | `"whole_thread"` | yes | The only legal value in `tenfour/1`. Receivers MUST reject records with any other value |

Example (as embedded in a `thread` response, WIRE §7.4):

```jsonc
{
  "state": "granted",
  "granted_via": "cli_accept",
  "granted_at": 1784767391000,
  "scope": "whole_thread"
}
```

(A `revoked_at` field is RESERVED for v1.1 alongside revocation — §7.)

**DECIDED HERE:** the broker additionally stamps an internal `grant_seq` — the thread's
`seq` at the moment of grant — because status derivation (§2.3) needs seq-ordering and
timestamps are display-only. `grant_seq` is broker-internal and does not appear on the
wire; conformance tests reach it through the broker test interface only.

### 2.2 Record lifecycle rules

| Rule | Statement |
|---|---|
| REC-1 | Records are **append-only**. No field is ever mutated after creation |
| REC-2 | At most **one current record** per thread: the record with the highest `grant_seq`. Older records are derived-status `superseded` and have no effect |
| REC-3 | A record is created **only** by a successful gesture (§3). There is no other creation path — not migration, not admin fiat, not inference |
| REC-4 | Records survive thread termination (audit trail) but have no effect on terminal threads |

### 2.3 Derived consent state

The enum is `protocol.ts CONSENT_STATES` = `{not_required, none, granted, stale,
revoked}` — the sole owner of the vocabulary. The broker derives a thread's
`consent_state` (exposed in `tenfour_thread` responses and inbound wrapper state
headers) as follows, evaluated top-down:

| Order | Condition | `consent_state` |
|---|---|---|
| 1 | Thread is question-rooted (R3) | `not_required` |
| 2 | No consent record exists for the thread | `none` |
| 3 | A re-consent trigger event (§6, the STATE [S] predicate) exists in the thread with `seq > grant_seq` of the current record | `stale` |
| 4 | Otherwise | `granted` |

(`revoked` is RESERVED for v1.1 and unreachable in v1 — §7.)

Only `granted` satisfies consent-gated operations (§9).

---

## 3. Gestures

Exactly two interactive gestures exist (plus the standing-rule path, §3.3). All
terminate the same way: the adapter sends `kind: accepted` through the ordinary
`send` method carrying the `consent { token, granted_via }` block
(WIRE §7.1; `protocol.ts SendRequestSchema` REQUIRES the block iff
`kind === "accepted"`).

**DECIDED HERE (amended):** there are NO `consent.grant` / `consent.revoke` broker
methods — the `tenfour/1` method set is exactly the seven of WIRE §1. Consent
rides the send plane; the broker validates the gesture block and creates the
consent record atomically inside the same `send` mutation that persists the
`accepted` message and transitions the thread.

### 3.1 CLI gesture: `tenfour accept <thread>`

- **Syntax:** `tenfour accept <thread-id>` where `<thread-id>` is a full ULID or an
  unambiguous prefix of **≥ 8 characters**. Ambiguous prefixes MUST fail listing the
  candidates; nothing is sent. (**DECIDED HERE:** 8-char minimum prefix.)
- **Operator:** the receiving human, on the receiving machine, in a terminal. The CLI
  is a human surface by covenant; the MCP surface has no equivalent unprompted path.
- **Behavior:** the CLI resolves the thread's current `consent_token` (§4) from the
  local journal or a `thread` fetch, then sends `kind: accepted` with
  `consent: { token, granted_via: "cli_accept" }`.
- The command MUST print the thread's root task summary, declared `repo`, and round
  budget (`round X/{max_rounds}`) **before** issuing the network call, so the human
  sees what they are consenting to.

### 3.2 MCP gesture: the `tenfour_confirm` tool

**DECIDED HERE:** the MCP confirm tool is named **`tenfour_confirm`**.

- **Input:** `{ thread_id: string, consent_token: string }`. The model MUST echo the
  consent token exactly as it appeared in the surfaced task's inbound wrapper (R8).
  The echo binds the confirmation to the specific task version that was surfaced —
  a rotated token (§4) makes confirmations of stale task versions impossible.
- **The human gesture is the Claude Code permission prompt.** `tenfour_confirm`
  MUST be covered by an **ask-rule** and MUST NOT be covered by any allow-rule.
  `tenfour init --workspace` installs the ask-rule **per-project** in designated
  tenfour workspace repos (§8.4). The human's approval of that prompt is the gesture;
  the token echo is the binding, not the authorization.
- On approval, the adapter sends `kind: accepted` with
  `consent: { token, granted_via: "mcp_confirm" }`.
- **Degradation, stated honestly:** if the user has globally allow-listed all MCP
  tools, the prompt never fires and this gesture degrades to model-initiated.
  `tenfour doctor` check `consent-ask-rule` MUST FAIL (not warn) when any allow-rule
  matches `tenfour_confirm`, and SECURITY.md states this limit in plain words.
- The model MUST only call `tenfour_confirm` after its human explicitly directed
  acceptance in the session. This is doctrine (enforced by the tool description in
  `strings.ts` and by the permission prompt), not by broker code — the broker cannot
  see who typed what.

### 3.3 Standing-rule acceptance (automatic path)

When a standing rule (§8) covers an inbound task, the adapter executes **the same
accept code path** (§3.1) without human interaction at delivery time.

**DECIDED HERE (amended):** standing-rule acceptances record
`granted_via: "standing_rule"` (`protocol.ts GRANTED_VIA` includes it as a
first-class value), so the broker record itself distinguishes interactive from
standing-rule grants. The acceptance is authorized by a human-authored,
file-permission-protected config declaration (`packages/schema/src/config.ts`).
The adapter's local delivery journal additionally records `standing_rule: true`
for local audit.

### 3.4 Forbidden mechanisms

| ID | MUST NOT |
|---|---|
| F-1 | The adapter MUST NOT infer consent from natural language ("go", "yes", "looks good", or any prose), in any language, ever (R8) |
| F-2 | The **generic MCP send tool `tenfour_send`** MUST NOT accept `kind: "accepted"` — the adapter rejects it locally with `TENFOUR/CONSENT_REQUIRED` (CLI-MCP MCP-010). Acceptance reaches the broker `send` method ONLY through the gesture paths (§3.1–§3.3), which construct the `kind:accepted` + `consent` block themselves. The broker independently rejects any `kind:accepted` send whose `consent` block is absent or invalid (`CONSENT_REQUIRED`, defense in depth) |
| F-3 | No allow-rule may cover `tenfour_confirm` (§3.2); shipping one is a release-blocking defect |
| F-4 | Standing rules MUST NOT be read from CLAUDE.md or any prose file (§8.5) |
| F-5 | The broker MUST NOT create consent records on unfreeze, on `change_request` receipt, or on any event other than a valid gestured `accepted` send |

### 3.5 Gesture outcomes by thread state

| Thread state at gesture | Outcome |
|---|---|
| `offered`, valid current token | The adapter sends `kind: accepted` + `consent` block; the broker atomically validates the token, creates the consent record, persists the **adapter-authored** `accepted` message, and transitions the thread to `in_progress`. `accepted` is a status kind and does not consume a round (DESIGN §4.4). This row covers the initial offer AND every structural re-offer after a scope-expanding `change_request` (§6): re-grant is re-offer, so the same cell applies. If a `pending_repo` exists (§6.2), it is committed as the thread's declared `repo` in the same mutation |
| Any state with `consent_state: granted` | **Success-shaped no-op** (doctrine: repeated gestures are not errors): `strings.ts CONSENT_ALREADY_ACTIVE_NOTE`. No new record, no wire message |
| `frozen` | `TENFOUR/THREAD_FROZEN`. Unfreeze first (`tenfour approve`, STATE §6.2), then gesture |
| Terminal (`closed`) | `TENFOUR/TERMINAL_THREAD` |
| Token stale, wrong, or already used | `TENFOUR/CONSENT_REQUIRED` (§9.3, `data.reason: "bad_token"`). No record created |
| Gesture by any agent other than the consent party | `TENFOUR/NOT_THREAD_PARTY` (`role_forbidden` — `accepted` is owner-only in the STATE §5 table). **DECIDED HERE:** for consent operations, "party" means the consent party (§1); the initiator receives this error even though it is a message-plane party of the thread |

---

## 4. The consent token

| Property | Rule |
|---|---|
| Format | **`protocol.ts CONSENT_TOKEN_REGEX` owns this (WIRE D16):** 22-char base64url (128-bit broker-minted entropy), e.g. `X4fN0qL9rW2tCvB7hJkPmQ`. Byte-exact echo required |
| Minted | (a) at root `task` creation; (b) at every re-consent trigger (§6, the STATE [S] predicate). Each mint **invalidates all prior tokens for the thread** |
| Single-use | A token is consumed by the successful gestured `accepted` send it authorizes. Reuse → `TENFOUR/CONSENT_REQUIRED` |
| Expiry | **DECIDED HERE:** tokens do not expire by wall time. They die only by rotation or use. (Time-based expiry would make the morning-catch-up journey — J4 — randomly fail) |
| Rendering | Stamped on the wire envelope (`consent_token`, WIRE §5.5) — **visible to both thread parties** (WIRE D16); usable only by the recipient because `accepted` is role-checked. Surfaced in the inbound wrapper of the message that requires the gesture (`WRAPPER_CONSENT_TOKEN_LINE` / `WRAPPER_RECONSENT_LINE` in `strings.ts`) and in `tenfour_thread` responses |
| Not a secret boundary | The receiving model can read the token (it must, to echo it). The token is a **binding**, not an authorization: authorization is the human's prompt approval or typed CLI command (§3.2). SECURITY.md repeats this |

---

## 5. What consent covers — and does not

A `granted` consent state on a thread authorizes the receiving agent to perform
**implementation work scoped to the thread's declared `repo`** (the root task's
first-class `repo` field, R10, as amended by any committed repo change, §6.2):

| Covered (within the declared repo, subject to permission rules) |
|---|
| Reading and editing files; creating branches; committing |
| Running the project's build and tests |
| Sending `result` messages on the thread |
| Continuing work across subsequent `change_request` rounds on the same thread (scope is `whole_thread`) |

| NOT covered — these keep their own gates regardless of consent state |
|---|
| Any work in any other repo |
| Merge, deploy, push to protected branches, dependency install, destructive fs, spend, network-exfil tools, modifying CLAUDE.md/hooks/CI/agent config, credential stores (DESIGN §5 gate list) |
| Accepting or working any **other** thread, from the same sender or otherwise |
| Answering questions autonomously (that is `standing_rules.auto_answer_questions`, §8 — a separate declaration) |
| Anything after the consent state leaves `granted` (§6) |

Consent is friction-layer honesty: it gates the **tenfour protocol surface**. It is
not an OS sandbox, and CONSENT.md makes the same "friction, not a sandbox" claim as
DESIGN §5 — no stronger.

---

## 6. Re-consent triggers

**There is exactly ONE re-consent trigger, and STATE-MACHINE §5 [S] is its
normative definition** (referenced by WIRE D16 and ARTIFACTS ART-112):

> A `change_request` expands scope iff (a) it carries ≥ 1 artifact whose
> (`repo`, `sha`) pair was never previously referenced in this thread, or (b) it
> names a `repo` differing from the thread's declared repo.

A scope-expanding `change_request`: moves the current record's derived state to
`stale` (§2.3), mints a fresh consent token (§4), transitions the thread
`review → offered` (**structural re-offer** — STATE [S]), and causes the message's
inbound wrapper to carry `WRAPPER_RECONSENT_LINE`. Work on the thread MUST NOT
continue past the trigger until a fresh gestured `accepted` (§3, in the re-offered
state) creates a new record — re-grant is structural re-offer only; there is no
in-`in_progress` re-grant path (WIRE D20). The re-offer also restores the owner's
right to `declined` on the enlarged task.

### 6.1 Trigger mechanics

1. The broker evaluates the [S] predicate **inside the `send` mutation** that lands
   the `change_request` (atomic with the state transition).
2. On trigger: rotate the consent token, mark the trigger event (its `seq` drives
   §2.3 rule 3), transition to `offered`, and flag the message for re-consent
   wrapping at delivery.
3. The first message delivered to the consent party at or after the trigger carries
   `WRAPPER_RECONSENT_LINE` with the fresh token.
4. Re-consent uses the same gestures (§3). The resulting record supersedes (REC-2).

### 6.2 Repo change — `pending_repo`

**DECIDED HERE:** a repo-changing (hence scope-expanding) `change_request` does
**not** immediately rewrite the thread's declared repo. The new value is held as
`pending_repo`; the re-consent gesture commits it (§3.5). Until commit, `result`
sends fail `CONSENT_REQUIRED` and the thread's declared repo (for wrong-repo
injection, wrappers, and §5 scope) remains the old value. The new repo value MUST
pass the pair's invite-time `repo_allowlist` at `change_request` send time
(`TENFOUR/REPO_NOT_ALLOWED` otherwise, WIRE D27) — a repo the broker would reject
must fail fast at the sender, not after a burned round.

### 6.3 Non-triggers (explicit)

| Not a trigger |
|---|
| `change_request` whose artifacts all reference previously-seen (`repo`, `sha`) pairs, with same/absent `repo` — whole-thread scope covers it (JOURNEYS §2); it proceeds `review → in_progress` under the original consent |
| `question` / `answer` traffic on the thread |
| Ack activity, duplicate deliveries, redeliveries |
| New rounds as such — the round budget is a separate mechanism with its own freeze |
| Freeze/unfreeze — `consent_state` is untouched by freezing (STATE §6.2); the post-unfreeze re-prompt is receiving-adapter UX doctrine, not a broker consent transition |

---

## 7. Revocation — RESERVED for v1.1

**DECIDED HERE (amended — WIRE D20 wins):** consent revocation is **RESERVED for
v1.1**. The `revoked` value exists in `protocol.ts CONSENT_STATES` as a schema
reservation only; **no v1 wire method, MCP tool, or CLI command sets it**, and the
R12 CLI manifest contains no `revoke` command (the final nine commands are
`init`, `invite`, `join`, `accept`, `approve`, `token`, `doctor`, `status`,
`inbox` — CLI-MCP §1).

In v1, a receiving human who wants work on a thread to stop directs their agent to
send `needs_human` (freezing the thread for both humans — the ordinary STATE §5
cell), or simply declines to gesture on any future re-offer. The initiator's
analog is `cancel` (a wire kind). No consent-record mutation occurs in either
case. R9's "revocable" flag is honored by the schema reservation and the v1.1
plan, not by a v1 mechanism.

---

## 8. Standing rules (declared consent in config)

Standing rules are the **only** form of pre-declared consent (R9: "standing-rule
consent is declared in config, not inferred").

### 8.1 Format

Location: the tenfour config file (`~/.tenfour/config.json`; `%USERPROFILE%\.tenfour\config.json`
on Windows; `$TENFOUR_HOME/config.json` when set). **The canonical Zod schema is
`packages/schema/src/config.ts` (`TenfourConfigSchema`) — the sole owner of key
names and shapes.** The file is protected 0600 (POSIX) / icacls (Windows) — the
same doctrine as `credentials.json` (a separate file, CLI-MCP §0 CLI-003).
**NOT CLAUDE.md. NOT prose.**

```jsonc
{
  "broker_url": "https://…",
  "agent": "jonathan/web",
  "peer": "brian/design",
  "workspaces": ["/Users/jonathan/code/web"],           // absolute paths of tagged workspace checkouts
  "allowed_repos": ["github.com/careswift/web"],        // receive allowlist — three-segment slugs (DESIGN §4.5)
  "standing_rules": {
    "auto_answer_questions": false,
    "auto_accept_from": []
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowed_repos` | string[] of canonical three-segment repo slugs (`host/owner/name`, lowercase) | `[]` | The receive allowlist, enforced by the receiving adapter at surface time (ARTIFACTS §10). Exact byte equality; **no globs or wildcards in `tenfour/1`** |
| `workspaces` | string[] of absolute paths | `[]` | Repos designated tenfour workspaces (`tenfour init --workspace`, §8.4); also the checkout map for the ancestor check (ARTIFACTS §8) |
| `standing_rules.auto_answer_questions` | boolean | `false` | Permits the adapter (standby duty-officer per R1c, and mid-turn per R1a) to answer inbound `kind: question` messages without surfacing first. Questions only — never tasks, never any other kind |
| `standing_rules.auto_accept_from` | string[] of full agent names (e.g. `"brian/design"`) | `[]` | Senders whose tasks may be auto-accepted. **DECIDED HERE:** exact full-name matches only; no globs or wildcards in `tenfour/1` |

**DECIDED HERE (amended):** there is no separate `standing_rules.allowed_repos`
list — auto-acceptance is scoped by the ONE receive allowlist (`allowed_repos`)
plus workspace tagging (§8.2). Standing-rule schema validity is enforced by
doctor check 1 (`config-parse`, validating against `config.ts`).

### 8.2 Auto-accept algorithm (normative pseudocode)

```
on delivery of task t to this agent:
  if t.from  in standing_rules.auto_accept_from        # exact name match
  and t.repo in allowed_repos                           # exact canonical-slug match
  and workspace_tagged(t.repo):                         # §8.4 — DECIDED HERE: required
      execute accept path (§3.1) with the delivered consent_token,
        granted_via = "standing_rule"
      journal.record(accept, standing_rule = true)
  else:
      queue for human triage (normal surfacing; no error, no message)
```

Auto-accept runs at **delivery** (SessionStart / hook / standby claim), not at broker
arrival — the broker never auto-consents (F-5). Redelivery is safe: a second
evaluation hits the success-shaped no-op of §3.5.

**DECIDED HERE:** standing rules never satisfy **re-consent** (§6) — triggers exist
because the deal changed; auto-accepting a changed deal defeats the mechanism. Only
interactive gestures clear a `stale` state (i.e., gesture on the re-offered thread).
(`auto_answer_questions` is unaffected by consent state; questions are never gated.)

### 8.3 Transparency of autonomous acts

Every standing-rule acceptance and auto-answer MUST appear in the next SessionStart
digest (`DIGEST_AUTO_ACTED_LINE` in `strings.ts`) and in `tenfour status`. Silent
autonomy is a defect.

### 8.4 Per-project gates and workspace tagging

Gate permission rules are **per-project**: they are installed into a repo's own
`.claude/settings.json` when the repo is designated a tenfour workspace.

**DECIDED HERE:** designation is `tenfour init --workspace`, run in the repo root
(keeps the R12 command manifest; `init` is already merge-not-clobber). It:

1. installs the per-project gate rules (DESIGN §5 gate list) including the
   `tenfour_confirm` ask-rule (§3.2), merging with sentinel-substring idempotency;
2. registers the repo's absolute path under `workspaces[]` in config
   (`config.ts`; the adapter derives the canonical repo-id from the checkout's
   `origin` remote — used for wrong-repo detection, the ancestor check, and doctor
   checks).

`tenfour doctor` MUST WARN when any repo named in an inbound task or in
`allowed_repos` is not a tagged workspace ("gate rules are not installed there;
tasks targeting it get default permissions" — check 14, `workspace-tagged`,
CLI-MCP §4). Auto-accept additionally hard-requires tagging (§8.2).

### 8.5 Why not CLAUDE.md

CLAUDE.md is prose: not machine-checkable, model-visible, and model-editable — a
standing rule there could be rewritten by the very session it governs. Config is
parsed, schema-validated (Zod, shared with the broker), file-permission-protected,
and diffable. The adapter MUST ignore any consent-like statement found in prose
context (F-1/F-4). Humans MAY, of course, describe their standing rules in CLAUDE.md
for the model's awareness — such text has zero mechanical effect.

---

## 9. Gated operations and `TENFOUR/CONSENT_REQUIRED`

### 9.1 Gated operations

| `operation` value | Operation | Requires | Enforced by | Failure |
|---|---|---|---|---|
| `send:accepted` | `kind: accepted` from the generic `tenfour_send` tool | never allowed (gesture path only, F-2) | adapter AND broker | `CONSENT_REQUIRED` |
| `send:result` | `kind: result` on a task thread | `consent_state: granted` | broker (`send` mutation, §3 step 11) | `CONSENT_REQUIRED` |
| `confirm` | gestured `accepted` send with stale/wrong/used token | valid current token | broker | `CONSENT_REQUIRED` (`bad_token`) |

Nothing else is consent-gated. Standing-rule misses are silent queueing (§8.2), not
errors — an error would invite model repair behavior where none is wanted.

### 9.2 Wire shape

Like every protocol error (DESIGN §4.1): typed, final, non-retryable.

```jsonc
{
  "code": "TENFOUR/CONSENT_REQUIRED",
  "message": "<what happened> <what is true now>",
  "human_action": "<the one action instead>",
  "retryable": false
}
```

**DECIDED HERE:** the error wire shape is `{ code, message, human_action,
retryable: false }` — `message` carries the what-happened + what-is-true-now clauses,
`human_action` carries the single instead-action. (DESIGN §4.1 named `code`,
`human_action`, `retryable`; `message` is an additive field per §4.6.)

### 9.3 How it reads (extracted from `strings.ts`, `ERRORS.CONSENT_REQUIRED`)

> **what:** The operation '{operation}' on thread {thread_short} requires an active
> human consent record, and none is active (consent state: {consent_state}).
> **now:** Nothing was sent or changed; the thread is exactly as it was.
> **instead:** Tell your human. They grant consent with 'tenfour accept
> {thread_short}' or by approving a tenfour_confirm permission prompt; standing rules
> in config can cover future cases like this one.

Rendered examples (default `max_rounds` config):

- Model tried `tenfour_send {kind: "accepted"}`:
  `TENFOUR/CONSENT_REQUIRED: The operation 'send:accepted' on thread 01J9Z3M8 requires an active human consent record, and none is active (consent state: none). Nothing was sent or changed; the thread is exactly as it was. Tell your human. They grant consent with 'tenfour accept 01J9Z3M8' or by approving a tenfour_confirm permission prompt; standing rules in config can cover future cases like this one.`
- `result` after a scope-expansion trigger (§6): same shape with
  `operation: send:result`, `consent_state: stale`.
- `tenfour_confirm` echoing a rotated token: same shape with `operation: confirm`.

The string never says retry, resend, or try again; the sole action is
**tell your human** with the exact granting commands named. `{thread_short}` is the
first 8 characters of the thread ULID (matching the §3.1 prefix rule, so the quoted
command is directly runnable).

---

## 10. Doctor checks introduced by this spec

These are folded into the CLI-MCP §4 numbered manifest (final count: **14 named
checks**); this section is a cross-reference, not a second list.

| Check | Manifest # | Level | Asserts |
|---|---|---|---|
| `consent-ask-rule` | 13 | FAIL | An ask-rule covers `tenfour_confirm` in every tagged workspace, and no allow-rule matches it anywhere doctor can read |
| `workspace-tagged` | 14 | WARN | Every repo named in `allowed_repos` or a queued inbound task is a tagged workspace |

(Standing-rule schema validity is asserted by check 1, `config-parse`, which
validates against `packages/schema/src/config.ts` — no separate check.)

---

## 11. Conformance checklist (every rule testable)

| # | Test |
|---|---|
| C1 | `tenfour_send` with `kind: accepted` → rejected locally (`CONSENT_REQUIRED`, `operation: send:accepted`); raw broker `send` of `kind:accepted` without a valid `consent` block → `CONSENT_REQUIRED`; thread unchanged in both |
| C2 | Gestured `accepted` send with the valid current token on an `offered` thread → record created with correct `granted_via`; adapter-authored `accepted` persisted; state `in_progress`; round count unchanged |
| C3 | Gestured `accepted` with a stale/rotated token → `CONSENT_REQUIRED` (`bad_token`); no record created |
| C4 | Gesture by the initiator → `NOT_THREAD_PARTY` (`role_forbidden`); no record |
| C5 | Gesture on a `frozen` thread → `THREAD_FROZEN` |
| C6 | Gesture on a terminal thread → `TERMINAL_THREAD` |
| C7 | Repeat gesture while `granted` → success-shaped no-op; record count unchanged |
| C8 | `change_request` with 1 never-before-referenced (`repo`,`sha`) artifact → `consent_state: stale`; thread `review → offered`; token rotated; delivered wrapper contains `WRAPPER_RECONSENT_LINE` with the new token |
| C9 | `change_request` whose artifacts all reference previously-seen (`repo`,`sha`) pairs, no repo change → `consent_state` stays `granted`; thread `review → in_progress`; old token still invalid (single-use, consumed at grant) |
| C10 | `result` while `stale` → `CONSENT_REQUIRED` (`operation: send:result`) |
| C11 | Repo-changing `change_request`: `pending_repo` set at send; `result` before re-grant → `CONSENT_REQUIRED`; re-grant commits repo atomically; wrong-repo injection uses old repo until commit |
| C12 | Freeze (needs_human AND round-cap variants) → `consent_state` unchanged by the freeze; unfreeze (`tenfour approve` + `consent_ref` send) resumes without touching consent; the receiving adapter re-surfaces the resumed thread before work continues (UX doctrine, STATE §6.2) |
| C13 | No v1 surface can set `consent_state: revoked`: there is no `tenfour revoke` command, no revocation MCP tool, and no wire method — asserted by the CLI/MCP manifests and the 7-method registry |
| C14 | (reserved with revocation — v1.1) |
| C15 | Auto-accept fires iff sender ∈ `auto_accept_from` ∧ repo ∈ `allowed_repos` ∧ workspace tagged; resulting record has `granted_via: "standing_rule"`; journal has `standing_rule: true` |
| C16 | Config failing `TenfourConfigSchema` (config.ts) → doctor check 1 `config-parse` FAILs; malformed standing rules never partially apply |
| C17 | Allow-rule matching `tenfour_confirm` present → doctor `consent-ask-rule` (check 13) FAILs |
| C18 | Question micro-thread: `answer` sends with no consent record; `consent_state: not_required` in wrapper header |
| C19 | Token reuse after successful grant → `CONSENT_REQUIRED` |
| C20 | Every `CONSENT_REQUIRED` wire error carries `retryable: false` and `human_action` byte-identical to the `strings.ts` rendering |
| C21 | Standing rules present but thread `stale` (re-offered) → no auto-re-consent (§8.2); interactive gesture required |
| C22 | Consent-like prose in CLAUDE.md ("auto-accept everything from brian") has zero effect on any of C1–C21 |

---

*Cross-references: DESIGN.md §4, §5, §11 (R6, R8, R9, R10, R12), §12; JOURNEYS.md §2,
§4; PROTOCOL.md (state table; unfreeze rule); packages/adapter/src/strings.ts
(canonical strings).*
