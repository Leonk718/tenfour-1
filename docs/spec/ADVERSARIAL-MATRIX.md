# tenfour/1 — ADVERSARIAL ATTACK / FAILURE MATRIX (NORMATIVE VERIFICATION)

**Status: ADVERSARIAL VERIFICATION of the v1.0-draft normative set. This document does
not add protocol; it audits the existing artifacts (`DESIGN.md`, `JOURNEYS.md`,
`WIRE.md`, `STATE-MACHINE.md`, `DELIVERY.md`, `AUTH.md`, `CONSENT.md`, `ARTIFACTS.md`,
`CLI-MCP-MANIFEST.md`, `packages/schema/src/protocol.ts`,
`packages/adapter/src/strings.ts`) against a hostile actor.**

Written for a hostile OSS audience: every row names the exact defending clause
(file + section/rule), a **falsifiable test** that proves the defense fires, and a
verdict. Where no clause stops the attack — or where the defending clause is rendered
**inoperable or non-deterministic by an internal contradiction between two normative
files** — the row is marked **UNCOVERED** and escalated to §3.

**DECIDED HERE (verification methodology):**
- Test IDs are `ADV-nn`; each maps to at least one conformance fixture the R13 gate
  requires before wire implementation.
- **Severity taxonomy**: `BLOCKING` = a security-critical defense is inoperable,
  self-contradictory, or absent; an implementer following the letter of the specs can
  ship the weaker variant. `MAJOR` = the defense exists but two normative files disagree
  on the value/shape, so no single conformance test can be authored. `MINOR` = honest,
  stated limitation or a low-severity residual under the trust model.
- **A spec-internal contradiction that makes a named defense inoperable or
  non-deterministic is treated as UNCOVERED for matrix purposes**, even though prose for
  the defense exists — because a hostile implementer picks the weaker reading.
- Authority rule applied throughout: `WIRE.md` §Preamble and `protocol.ts` header both
  declare `protocol.ts` the executable winner on wire shapes. Where a prose spec
  contradicts `protocol.ts`, the prose spec is reported as carrying the bug — but the
  contradiction is still BLOCKING/ MAJOR because the prose file is *also* normative and
  a reader has no in-band signal which to obey.

**Trust model recap (DESIGN §5):** peer *human* trusted; **in scope**: prompt-injected
/ compromised peer *sessions*, accidental loops, token leakage, open-relay abuse, secret
spillage. **Out of scope**: malicious co-founder, broker-operator confidentiality
(plaintext bodies), OS sandboxing. Permission rules are friction, not a sandbox.

---

## 1. Verdict summary

| # | Attack | Verdict | Escalation |
|---|---|---|---|
| A1 | Injected fake "go" consent | **COVERED** — sole grant path: CLI `tenfour accept` → `send {kind:accepted, consent{token,granted_via}}`; no MCP confirm tool, no `consent.grant` method | resolved (was C-1/C-2/C-6/C-11) |
| A2 | Stale demoted session sending / injecting | COVERED | §3 C-13 (MAJOR: reclaim window), residual R2 (MINOR) |
| A3 | Malicious remote in artifact `repo`/`url` | **COVERED** — no auto-fetch (SSRF class removed); three-segment host/owner/name grammar + host allowlist + PR url host-match (ART-049b) | resolved (was C-3) |
| A4 | Invite replay / expiry abuse | **PARTIAL — replay covered; tamper-checksum + expiry defense contradictory** | §3 C-4 (BLOCKING), C-9 (MAJOR) |
| A5 | Duplicate ambiguity (retry + content drift) | COVERED | — |
| A6 | Crash at every journal point | COVERED | — |
| A7 | Over-cap racing sends | COVERED | — |
| A8 | Status-kind flooding | COVERED in principle; **rate ceiling contradictory** | §3 C-5 (MAJOR) |
| A9 | Secret in artifact ref name | COVERED (best-effort, honestly labeled) | — |
| A10 | Revoked token on open subscription | COVERED in substance; **`subscribe` is not a wire method** | §3 C-7 (MAJOR) |
| A11 | `diag.ping` abuse | PARTIAL — flooding/enum covered; **peer-presence rule contradictory**; covert-channel residual | §3 C-8 (MAJOR), C-12 (MINOR), covert channel (MINOR) |

Net (at time of the original audit): 4 BLOCKING, 7 MAJOR, 5 MINOR — **all now RESOLVED**
by the single-authority reconciliation pass (§3 records the current authority and value
for each C-1…C-14). The Verdict/Escalation columns above are retained as the audit trail
of what was found; the live requirement in every row is now conformance-testable against
a single value.

---

## 2. The attack matrix

Each subsection: the attack broken into steps, the defending clause(s), the proving
test, and the residual.

### A1 — Injected fake "go" consent

**Attack.** A prompt-injected peer session (or the receiver's own confused model) tries
to start implementation work without the human's structured gesture: (a) infer consent
from prose ("go", "sounds good"); (b) send `kind:accepted` directly; (c) call the MCP
confirm tool unprompted, echoing a token it can read.

| Vector | Defending clause (file §/rule) | Proving test | Verdict |
|---|---|---|---|
| Prose-inferred consent | CONSENT.md P2, F-1; JOURNEYS §8 (R8); DESIGN §11 R8 | **ADV-01**: feed "the peer said go" into any adapter path; assert no `consent.*`/`accepted` traffic emitted and consent_state unchanged | COVERED |
| Model sends `accepted` via generic send tool | CLI-MCP MCP-010 (local reject); CONSENT.md F-2 (adapter **and** broker reject); strings.ts `TOOL_SEND_DESCRIPTION` | **ADV-02**: `tenfour_send {kind:"accepted"}` → local `CONSENT_REQUIRED`, no wire call | COVERED |
| Model calls a would-be consent MCP tool | there is NO MCP consent tool (B1; CONSENT §3.2, F-3); the served surface is EXACTLY `tenfour_send`/`tenfour_ack`/`tenfour_thread`/`tenfour_wait`, and `tenfour_send` rejects `kind:accepted` (MCP-010); doctor `consent-surface` (check 13) FAILs on any served consent/confirm tool | **ADV-03**: register a consent/confirm MCP tool (or make `tenfour_send` accept `kind:accepted`) → doctor `consent-surface` FAILs | COVERED — the model has no MCP consent surface to call; acceptance is the human's CLI `tenfour accept` gesture |
| Token echo binds to surfaced version | CONSENT.md §4 (single-use, rotates on trigger); WIRE §5.5 D16 (token role-checked) | **ADV-04**: grant with a rotated/stale token → `CONSENT_REQUIRED` `reason:bad_token`; no record | COVERED |

**Residual / escalation.** RESOLVED. The grant path is now single-authority: consent is
granted by *sending* `kind:accepted` with a `consent{token, granted_via}` block on the
`send` method (protocol.ts `SendRequestSchema`; WIRE §7.1). There is no `consent.grant`
method and no MCP confirm tool; the `accepted` message is adapter-authored via the CLI
`tenfour accept` gesture, `granted_via ∈ {cli_accept, standing_rule}`. One system, one
grant path, conformance-testable. No BLOCKING residual.

### A2 — Stale / demoted session sending and injecting

**Attack.** The human opens a second session (laptop) for the same agent. The now-demoted
session is compromised and tries to (a) keep sending, (b) claim + inject inbound messages
to double-deliver, (c) suppress delivery to the live session.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Demoted session still sends | DELIVERY DEL-14 (send accepted — durability outranks ceremony; demotion surfaced) | **ADV-05**: send from demoted session → `ok:true` + `session:{holder:false}`; adapter emits `session_demoted` notice once (DEL-17) | COVERED **by design** — the sender is the trusted human's own machine |
| Demoted session claims / injects | DELIVERY DEL-08 (only active session claims), DEL-15 (demoted MUST NOT inject/claim; `demoted.flag` stat gate), DEL-16 | **ADV-06**: with `demoted.flag` present, PostToolUse/hook injection is suppressed; claim call returns `claimable:false` | COVERED |
| Superseded claim double-delivers | DELIVERY DEL-06 (lease expiry reclaim, new `attempt_id`), §5.2 (journal dedup by `message_id`, not attempt), C2 | **ADV-07**: claim, demote, reclaim by active session → model sees message once (journal `received` dedup) | COVERED |
| Two subscriptions, same token | AUTH SUB-5 (warn + last-connect-wins, **not** an auth error) | **ADV-08**: second subscribe → old subscription demoted, no `CLIENT_ID_CONFLICT` | COVERED |

**Residual / escalation.**
- **C-13 (MAJOR):** the reclaim window the test in ADV-06/07 must assert is
  **contradictory**: WIRE §7.2 D23 and `protocol.ts LIMITS.CLAIM_LEASE_MS` = **15 min**;
  DELIVERY DEL-04 = **300 s (5 min)**, and DELIVERY's crash matrix C2 hard-codes
  "worst-case extra delay 5 min." No single expiry can be tested.
- **CLOSED (was MINOR R2 residual):** the demoted-ack channel is now shut by rule:
  an ack referencing a **superseded** attempt is rejected `TENFOUR/AUTH_FAILED`
  (WIRE D23; DELIVERY DEL-10, DEL-14/§3.2). A demoted session can neither claim
  nor ack-to-suppress rows the active session holds.

### A3 — Malicious remote in artifact `repo` / `url`

**Attack.** Attacker puts a hostile host in a `repo`/`url` to (a) trigger broker-side
fetch/SSRF, (b) route work to `evil-github.com`, (c) smuggle a human-clickable link to an
arbitrary domain inside a `github.com` artifact, (d) homoglyph a trusted host.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Broker fetch / SSRF | DESIGN §4.5 (never fetch/clone/checkout); ARTIFACTS ART-043, ART-049c, ART-091; R5 replaces `ls-remote` with local ancestor check (ARTIFACTS §8.3, ART-087 offline test) | **ADV-09**: run the full send + ancestor path under `unshare -rn` → passes; zero network syscalls | **COVERED** |
| Host allowlist (`evil-github.com`) | ARTIFACTS ART-030/031/032 (`allowed_hosts`, exact byte equality, default `["github.com"]`) | **ADV-10**: `repo` host not in `allowed_hosts` → `REPO_NOT_ALLOWED` `reason:host_not_allowed` | **UNCOVERED — see below** |
| Link smuggling (url host ≠ repo host) | ARTIFACTS ART-049b (url host MUST equal repo host) | **ADV-11**: `pull_request` with `url` host ≠ repo host → `ARTIFACT_INVALID` `reason:url_host_mismatch` | **UNCOVERED — see below** |
| Homoglyph / IDN | ARTIFACTS ART-022 (punycode-only, no IDN on wire) | **ADV-12**: non-ASCII host byte → rejected | Depends on the same broken grammar |

**Residual / escalation — BLOCKING (C-3).** The entire host-based defense is
**inoperable against the wire schema.** ARTIFACTS §2.1 defines the canonical repo-id as
`host "/" owner "/" name` (two slashes, e.g. `github.com/careswift/web`) and builds
`allowed_hosts` (ART-030–032) and `url_host_mismatch` (ART-049b) on that host segment.
But `WIRE.md §3` and `protocol.ts REPO_SLUG_REGEX` define `RepoSlug` as
`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$` — **`owner/name`, one slash, no host**
— and the `§6` content-hash test vector uses `careswift/webapp`. Consequences a hostile
auditor exploits:
1. A value like `github.com/careswift/web` **fails** `RepoSlugSchema` (two slashes) — the
   ARTIFACTS grammar is unrepresentable on the wire.
2. With `owner/name` only, there is **no host field for ART-031 to check** — the
   allowed-hosts defense (ADV-10) has nothing to evaluate; it is dead spec.
3. ART-049b compares "url host" to "the artifact's repo host" — the repo **has no host**,
   so the link-smuggling check (ADV-11) cannot compute and PR-url host smuggling is
   **UNCOVERED**.

SSRF remains covered by the no-fetch guarantee, so blast radius is limited to
mis-routing + a human clicking a smuggled link. But two named defenses do not function.
**Fix**: make `protocol.ts`/`WIRE.md` the host-carrying grammar (three-segment) OR strip
host machinery from ARTIFACTS and re-found link-smuggling on a different check; then
re-issue the §6 hash vector.

### A4 — Invite replay / expiry abuse

**Attack.** Attacker (a) replays a redeemed code, (b) races two redemptions, (c) uses an
expired code, (d) brute-forces the secret, (e) tampers the payload and relies on a weak
checksum, (f) probes which field was wrong.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Replay after redemption | AUTH INV-5/INV-7 (atomic `outstanding→redeemed` CAS) | **ADV-13**: redeem twice → second `INVITE_INVALID` `reason:redeemed` | COVERED |
| Concurrent double-redeem | AUTH INV-7 (CAS loser loses) | **ADV-14**: two simultaneous redeems → exactly one `ok`, one `INVITE_INVALID` | COVERED |
| Expired code | AUTH INV-6; WIRE §8.4 (`INVITE_EXPIRED`) | **ADV-15**: redeem past `exp` → `INVITE_EXPIRED` | COVERED — **but which `exp`? see C-9** |
| Brute-force secret | AUTH INV-4 (128-bit) / WIRE D29 (256-bit); WIRE D30 + §10 (5 failures → lockout); AUTH ENUM-3 (10 auth-fails/min/source) | **ADV-16**: 5 bad redemptions of one code → `INVITE_INVALID` `reason:lockout` | COVERED (lockout) — secret width contradictory (C-4) |
| Field-probe oracle | AUTH INV-6 (cause-uniform `INVITE_INVALID` across unknown/wrong-secret/redeemed/revoked/superseded/malformed) | **ADV-17**: diff serialized bodies of all non-expiry failures → byte-identical | COVERED |
| Payload tamper vs checksum | AUTH §6.2 / WIRE §8.3 (verify check locally before network; INV-2 "not crypto") | **ADV-18**: flip one payload byte → local checksum fail before any network call | **UNCOVERED — checksum defined two ways (C-4)** |

**Residual / escalation.**
- **BLOCKING (C-4):** the invite code is specified as **two incompatible formats.**
  WIRE §8.3 D29 + `protocol.ts` (`InviteCodePayloadSchema`, `INVITE_CODE_REGEX`): check =
  **6 base64url chars of SHA-256(payload)**; secret = **256-bit / 43 chars**; `exp` =
  **ms epoch**; payload keys are full words (`agent`,`broker_url`,`exp`,`invite_id`,
  `secret`,`v`) with **no `pair_with`**. AUTH §6.2 D29: check = **8-hex-char CRC32C**;
  secret = **128-bit / 16 bytes**; `e` = **unix seconds**; keys are short
  (`v,b,i,a,p,s,e`) **with `p`=pair_with**. The regexes even disagree
  (`...\.[A-Za-z0-9_-]{6}$` vs `...\.[0-9a-f]{8}$`). ADV-18's "verify checksum locally
  before network" — the paste-mangling + tamper defense and the JOURNEYS §3
  "joining as X to Y — correct?" prompt — **cannot be built to one standard.**
- **MAJOR (C-9):** invite lifetime is 24 h (WIRE §8.2 `ttl_s` default 86400 +
  `protocol.ts INVITE_TTL_DEFAULT_S`) vs a fixed 72 h with no parameter (AUTH §6.1
  "issuance + 72 h exactly", INV-4) vs "--ttl default 72 hours" (CLI-MCP §1.2). ADV-15
  cannot pin the boundary.
- **MINOR:** AUTH's `INVITE_INVALID` reason list (INV-6) omits `lockout`, which
  WIRE/`protocol.ts` include; AUTH §15 register also omits it.

### A5 — Duplicate ambiguity: retry after timeout with content drift

**Attack.** After a send times out with unknown outcome, the adapter (or a confused
model) retries — but the content has drifted (different body/artifacts/parent) while
reusing the `client_id`, hoping to overwrite or double-post.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Same id, same content | WIRE §6 (dedup on `(from,client_id)`+hash → R7 duplicate success); §7.1 step 9 (checked **before** thread-state); STATE §3 step 5; DELIVERY DEL-36, C11 | **ADV-19**: resend identical → `ok:true, duplicate:true`, canonical original + current `delivery_state`; no second thread event | COVERED |
| Same id, drifted content | WIRE §6 (hash mismatch → `CLIENT_ID_CONFLICT`); DELIVERY DEL-35; STATE §7.1 last row | **ADV-20**: resend with mutated body, same `client_id` → `CLIENT_ID_CONFLICT` `data.{client_id,original_message_id}`; nothing persisted | COVERED |
| Hash field-set stability | WIRE §6 D17 (exactly nine fields; unknown fields stripped pre-hash, D9); `protocol.ts CONTENT_HASH_FIELDS` + `CONTENT_HASH_TEST_VECTOR` | **ADV-21**: add an unknown field → same hash → still R7 duplicate (not conflict); vector reproduces on all 3 OSes | COVERED |
| Legit head drift after timeout | CLI-MCP §1.4 (`accept` refetches head, retries **with a fresh `client_id`** since parent changed); DELIVERY DEL-38 (no phantom outbox) | **ADV-22**: head moved → adapter uses new `client_id`; old id never silently reused for new content | COVERED |

**Residual.** None. The dedup-before-thread-state ordering (WIRE §7.1 note; STATE §3
"dedup (5) precedes rate (6)") specifically defeats the "retry after the thread moved on"
ambiguity: a crashed-adapter retry returns the original outcome. **COVERED.**

### A6 — Crash at every journal point

**Attack.** Kill the process at each fsync boundary to lose a message, double-deliver
without warning, or produce a phantom send.

| Crash point | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Broker accepted, machine off (C1) | DELIVERY C1; DEL-01 (durability independent of subscription) | **ADV-23**: kill before fetch → next SessionStart delivers once, no preamble | COVERED |
| Claimed, before `received` fsync (C2) | DELIVERY C2; DEL-06 lease reclaim | **ADV-24**: kill → reclaim ≤ lease; delivered once | COVERED (lease value = C-13) |
| After `injected` fsync, before model sees it (C4) | DELIVERY DEL-20 step 4 (write-ahead), DEL-27/28, C4 | **ADV-25**: kill → re-present **with** `REDELIVERY_PREAMBLE` exactly once | COVERED |
| Model saw it, before ack (C5) | DELIVERY DEL-27/28 (at-most-one uncertain redelivery), C5 | **ADV-26**: kill → seen twice, 2nd labeled; model verifies | COVERED |
| `ack_pending`, before/at RPC (C6/C7/C8) | DELIVERY DEL-28 (`ack_pending` never re-presents; silent ack retry), DEL-10 (ack by message even if lease expired) | **ADV-27**: kill in each → invisible; no re-present; idempotent ack | COVERED |
| Compaction crash (C9) | DELIVERY §5.1 (temp+rename; discard stale temp) | **ADV-28**: kill mid-compaction → original authoritative | COVERED |
| Outbound `prepared`, no `sending` (C10) | DELIVERY DEL-40 (**abandoned**, never auto-sent), DEL-38 | **ADV-29**: kill → op surfaced "never transmitted", no phantom send | COVERED |
| Outbound `sending`, outcome unknown (C11) | DELIVERY DEL-35/36, C11 | **ADV-30**: kill → idempotent retry, same `client_id` → accept or R7 → `confirmed`; exactly-once | COVERED |
| Round-cap freeze mid-commit (§8.4) | STATE §8.4 (single ACID txn); WIRE §11.7 | **ADV-31**: kill between reject and system `needs_human` → unobservable (atomic) | COVERED |
| `received` fsync before `pending.flag` (C14) | DELIVERY DEL-20 step 3 (journal before flag), DEL-45, C14 | **ADV-32**: kill → picked up next turn boundary regardless of flag | COVERED |

**Residual.** None. INV-1 (no loss), INV-2 (≤ one labeled redelivery), INV-5
(exactly-once wire), INV-6 (no phantom transmit) are each backed by a crash row.
**COVERED.**

### A7 — Over-cap racing sends

**Attack.** Two substantive sends race at `rounds_used = max_rounds − 1`, each hoping its
increment commits so the thread runs past the cap (loop past containment).

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Concurrent increment | STATE §8.4(c) (head rule forces the 2nd to `STALE_HEAD` **before** round logic); single-writer mutation | **ADV-33**: two sends, same `parent_id`, at cap−1 → one commits, one `STALE_HEAD`; `rounds_used` increments once | COVERED |
| Cap breach itself | STATE §8.2 pseudocode + §8.4 (reject + system `needs_human` + freeze, one txn); WIRE §7.1 round accounting, §11.7 | **ADV-34**: send that would make `new_round > max_rounds` → `ROUND_CAP`, breaching msg **not** persisted, thread `frozen(round_cap)`, one system `needs_human` fan-out (DELIVERY DEL-42) | COVERED |
| Graceful close at cap | STATE §8.3 rows 12/13 (`needs_human`/`cancel` legal at cap; status kinds never blocked) | **ADV-35**: `cancel` at cap → `closed(cancelled)`, not `ROUND_CAP` | COVERED |
| Reset abuse via unfreeze | STATE §6.2 (unfreeze resets counter but **costs a human gesture**); DESIGN R8 posture | **ADV-36**: infinite loop requires infinite human approvals → containment holds | COVERED |

**Residual.** None. `max_rounds` default 10 / clamp 1–12 is consistent across WIRE §7.1,
STATE §8.1, and `protocol.ts LIMITS.MAX_ROUNDS_*`. **COVERED.**

### A8 — Status-kind flooding

**Attack.** Status kinds (`accepted`,`declined`,`cancel`,`done`,`needs_human`) and `ack`
do not count toward rounds; attacker floods them as a "free" abuse channel (ack-storms,
`needs_human` spam) to exhaust the peer or the broker.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Status sends bypass rounds → rate | STATE §9.1 ("**status kinds count toward rate**"); WIRE §10 (all `send` kinds under the send ceiling) | **ADV-37**: flood status sends → `RATE_LIMITED` after the ceiling; thread state untouched (STATE §9.3) | COVERED in principle |
| Ack storm | WIRE §10 (`ack` 120/60 s); `protocol.ts RATE_LIMITS.ack` | **ADV-38**: >120 acks/min → `RATE_LIMITED` | COVERED |
| `needs_human` spam | STATE §5 [M] (freeze does not stack; 2nd → `THREAD_FROZEN`); DELIVERY DEL-42 (system fan-out ≤ 1/freeze) | **ADV-39**: second `needs_human` on frozen thread → `THREAD_FROZEN`, no new freeze/post | COVERED |
| Rejected-send hammering | STATE §9.1 (rejected sends don't persist, don't count — transport abuse is platform concern) + AUTH ENUM-3 (auth-fail throttle) | **ADV-40**: hammer invalid sends → each typed-rejected, no state change | COVERED (protocol); transport DoS explicitly out of scope |

**Residual / escalation — MAJOR (C-5).** The rate ceiling the flooding test must assert
is **contradictory.** STATE §9.1 specifies **60 messages / rolling hour / agent**, with an
exact sliding-log algorithm (§9.2) and boundary examples (§9.3: "send #61 →
`RATE_LIMITED`"). WIRE §10 and `protocol.ts RATE_LIMITS.send` specify
**12/60 s AND 120/3600 s** — a 120/hour hourly ceiling, twice STATE's number, and adds a
per-minute sub-window STATE §9.3 explicitly denies ("No smoothing and no sub-window
quota"). Every boundary example in STATE §9.3 is wrong under `protocol.ts`. ADV-37 cannot
be authored deterministically. **The abuse is bounded either way; the spec is not.**

### A9 — Secret in artifact ref name (and other artifact strings)

**Attack.** Embed a live credential in a place a body-only DLP scan would miss — a branch
name (`ref`), a PR `url`, or the `repo` slug — to exfiltrate it through the relay.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Secret in body | WIRE §7.1 step 7; STATE §3 step 13; DESIGN §5 (best-effort DLP) | **ADV-41**: known-secret corpus in body → `SECRET_DETECTED`, `data.field`, match never echoed | COVERED |
| Secret in `ref` / `url` / artifact strings | ARTIFACTS §9 sending-adapter row ("`ref` and `url` included — a token pasted into a branch name is caught here"); broker defense-in-depth row | **ADV-42**: token in `git_branch.ref` → `SECRET_DETECTED` at adapter; broker re-scans | COVERED |
| tenfour's own keys relayed | AUTH CRED-4 (own `tf1_`/`tfadmin_` regexes wired into the scan) | **ADV-43**: put a `tf1_…` string in `ref` → `SECRET_DETECTED` | COVERED |
| False sense of safety | strings.ts `SECRET_DETECTED` ("this scan is best-effort — a pass is not proof"); DESIGN §5; ARTIFACTS ART-088 posture | **ADV-44**: novel secret shape passes → documented as best-effort, primary control is git-refs-not-content | COVERED (honestly labeled) |

**Residual — MINOR (observation).** `GIT_REF_REGEX` (`protocol.ts`) admits nearly any
non-whitespace/non-control string up to 255 chars, so a high-entropy third-party secret
that matches no corpus pattern will pass. This is the stated best-effort limitation, not a
gap — but the corpus is the sole line for non-tenfour secrets and must be treated as such
in SECURITY.md. **COVERED.**

### A10 — Revoked token on an open subscription

**Attack.** The human revokes/rotates a token, but a live subscription (or long-lived MCP
server holding the token in memory) keeps streaming inbox contents, or the attacker keeps
issuing calls on the still-open channel.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Calls after revoke commit | AUTH §3.4 step 2 + REV-2 (`AUTH_REVOKED`), REV-4 (effective at commit) | **ADV-45**: any `send`/`inbox`/`ack`/`thread` after revoke → `AUTH_REVOKED` | COVERED |
| Subscription keeps pushing | AUTH SUB-3 (terminate ≤ 5 s of revoke/retirement commit; terminal `AUTH_REVOKED`; no push after commit), SUB-2 (bound to opening credential) | **ADV-46**: revoke → subscription closes ≤ 5 s with `AUTH_REVOKED` terminal event | Defense exists — **but see C-7** |
| Adapter auto-retries with dead token | AUTH SUB-4 (no auto-retry same credential); DELIVERY DEL-41 (halt traffic, preserve journals) | **ADV-47**: `AUTH_REVOKED` → adapter halts, surfaces `tenfour join`; no loop | COVERED |
| Rotation overlap window abuse | AUTH ROT-1/ROT-4 (overlap ends on first new-token call or deadline; revoke has no overlap) | **ADV-48**: use old token after first new-token call → `AUTH_REVOKED` | COVERED |

**Residual / escalation — MAJOR (C-7).** The subscription defense (SUB-1..5, and the
`subscribe` row in AUTH §3.3's capability matrix) is written against a method **that does
not exist on the wire**: WIRE §1 enumerates exactly seven methods and states "There are
no other methods in `tenfour/1`. Anything not defined here is not on the wire";
`protocol.ts METHODS` has no `subscribe`. DELIVERY/DESIGN treat the subscription as a
transport-layer Convex reactive query whose *correctness never matters* (DEL-01). So
ADV-46's "terminate ≤ 5 s" is a broker-implementation promise with **no wire contract to
conform to**, and a hostile reviewer will note that AUTH.md authorizes and rate-limits
(SUB-1, §3.4) a first-class method the wire spec forbids. **Substance is covered** (every
real wire call fails `AUTH_REVOKED` post-commit; correctness comes from cursor-on-reconnect
per DEL-01, and the channel only ever carried this agent's own claimable rows), so blast
radius is ≤ 5 s of already-authorized data — but the normative status of `subscribe` must
be resolved.

### A11 — `diag.ping` abuse

**Attack.** Use the thread/round/rate/retention-exempt diagnostic method to (a) flood the
broker, (b) enumerate agents, (c) leak peer state, (d) run a covert channel via the
presence `mark` that leaves no audit trail.

| Vector | Defending clause | Proving test | Verdict |
|---|---|---|---|
| Flood | WIRE §10 (`diag.ping` 30/60 s); `protocol.ts RATE_LIMITS['diag.ping']` | **ADV-49**: >30 pings/min → `RATE_LIMITED` | COVERED — but see C-12 |
| Agent enumeration | AUTH READ-6 (MUST NOT leak other agents' existence/inbox/thread; response limited to reachability/time/versions/own-address echo) | **ADV-50**: authenticated `diag.ping` never reveals a non-peer agent | COVERED for non-peers |
| Peer-state leak | WIRE §8.1 D26 (`peer` field readable only by the paired peer, 24 h TTL) | **ADV-51**: `peer` field present only for the one paired agent | **Resolved (C-8): peer presence readable only by the paired peer** |
| No thread/round pollution | WIRE §8.1 (excluded from threads/rounds/inbox/retention — R6); AUTH READ-6 | **ADV-52**: `diag.ping` traffic never appears in `inbox`/`thread` (WIRE §11.6) | COVERED |

**Residual / escalation.**
- **MAJOR (C-8):** WIRE §8.1 D26 **mandates** a `peer` presence object (peer agent name,
  `last_ping_ts`, `last_mark`) in the `diag.ping` response and `protocol.ts
  DiagPingSuccessSchema` encodes it; AUTH READ-6 says the response is **"limited to broker
  reachability, broker time, protocol versions, and the caller's own address echo"** —
  i.e. it forbids exactly the peer field the wire schema requires. ADV-50 and ADV-51 test
  opposite behaviors. (In v1 the only "other" agent *is* the peer, so the practical leak
  is one bit of presence to a trusted peer — but the two normative files literally
  contradict.)
- **MINOR (C-12):** WIRE §10 gives `diag.ping` a hard 30/60 s ceiling; STATE §9.1 says
  `diag.ping` is rate-**exempt** ("MAY have its own courtesy throttle outside this spec").
  ADV-49's ceiling is thus non-normative under STATE.
- **MINOR (covert channel — accepted risk, now audited):** the `mark` (≤ 64 chars,
  24 h TTL) is a peer-readable value on a method excluded from **retention** (R6).
  Mark-bearing pings now emit the `diag.mark` audit event (AUTH §13), so the beacon
  leaves a trace; the retention exemption of the presence record itself remains the
  documented accepted risk under the trust model — a prompt-injected session can
  beacon low-bandwidth data to its (trusted) peer with no thread and no round cost.

---

## 3. Resolved spec reconciliations (audit record)

> **RECONCILIATION NOTE (July 2026): every contradiction the verifier found (C-1…C-14)
> has been RESOLVED by the single-authority reconciliation pass.** `protocol.ts` is the
> ratified tie-breaker for wire shapes; the prose files now cite it and match it. The old
> "Contradictory" table has been removed — only the resolved authority remains, so a
> conformance fixture can be authored against each value directly. No reader-facing
> contradiction survives.

- **C-1 — Consent grant path — RESOLVED — current authority:** consent rides `send`
  with `kind:accepted` + a `consent{token,granted_via}` block (WIRE §7.1 /
  `protocol.ts SendRequestSchema`). No `consent.grant`/`consent.revoke` method and no
  MCP consent tool (B1); revocation reserved v1.1.
- **C-2 — `consent_state` vocabulary — RESOLVED — current authority:**
  `{not_required, none, granted, stale, revoked}` (`protocol.ts CONSENT_STATES`); only
  `granted` satisfies consent-gated ops.
- **C-3 — Repo grammar — RESOLVED — current authority:** three-segment lowercase
  `host/owner/name` everywhere (`protocol.ts REPO_SLUG_REGEX` + repo-semantics refine;
  ARTIFACTS §2.1). The §6 content-hash vector uses `github.com/careswift/web` and
  reproduces to `sha256:dc94…958d718`; `allowed_hosts` (ART-031) and `url_host_mismatch`
  (ART-049b) now have a real host segment to evaluate.
- **C-4 — Invite code format — RESOLVED — current authority:** WIRE §8.3 D29 /
  `protocol.ts` — SHA-256 6-char base64url check, 256-bit secret, ms `exp`, full-word
  keys, no `pair_with`; AUTH §6.2 references it.
- **C-5 — Send rate ceiling — RESOLVED — current authority:** 12/60 s AND 120/3600 s
  (WIRE §10 / `protocol.ts RATE_LIMITS.send`); STATE §9 rewritten to these numbers.
- **C-6 — MCP consent tool — RESOLVED — current authority:** there is NO MCP consent
  tool (B1). The served MCP surface is EXACTLY four tools (send/ack/thread/wait);
  consent-acceptance is the CLI `tenfour accept` gesture + standing rules. Doctor check
  13 is `consent-surface` (verifies the four-tool set), replacing the old ask-rule check.
- **C-7 — `subscribe` — RESOLVED — current authority:** a transport-layer Convex
  reactive query, NOT a `tenfour/1` wire method (WIRE §1; the seven methods stand).
- **C-8 — `diag.ping` peer field — RESOLVED — current authority:** the `peer` presence
  object is returned to the PAIRED peer only (WIRE §8.1 D26; AUTH READ-6 amended).
- **C-9 — Invite TTL — RESOLVED — current authority:** parameterized `ttl_s`, default
  **86400 s (24 h)**, broker-clamped **300–604800 s** (`protocol.ts LIMITS.INVITE_TTL_*`;
  WIRE §8.2; AUTH/CLI-MCP reference it).
- **C-10 — `granted_via` enum — RESOLVED — current authority:** `{cli_accept,
  standing_rule}` (`protocol.ts GRANTED_VIA`) — the MCP grant path is gone (B1).
- **C-11 — `accepted` authorship — RESOLVED — current authority:** the adapter authors
  the `accepted` message on the CLI / standing-rule gesture (STATE §5 [C]).
- **C-12 — `diag.ping` rate — RESOLVED — current authority:** the **30/60 s** ceiling is
  NORMATIVE, not exempt (WIRE §10 / `protocol.ts RATE_LIMITS['diag.ping']`; STATE §9.1).
- **C-13 — Inbox claim lease — RESOLVED — current authority:** **5 minutes** everywhere
  (`protocol.ts LIMITS.CLAIM_LEASE_MS = 300_000`; WIRE §7.2; DELIVERY DEL-04).
- **C-14 — Micro-thread open state — RESOLVED — current authority:** the literal is
  `open` everywhere (`protocol.ts THREAD_STATUSES`; STATE §1.2; WIRE §3 D6).

The A2 demoted-ack residual is closed: an ack referencing a superseded attempt ⇒
`AUTH_FAILED` (WIRE D23; DELIVERY DEL-10/§3.2). The A11 mark beacon emits a `diag.mark`
audit event (AUTH §13); its retention exemption remains the documented accepted risk.

## 4. Conformance-test index (ADV → assertion)

Every `ADV-nn` above is a required fixture under the DESIGN R13 gate. Grouping:

| Group | IDs | Anchors |
|---|---|---|
| Consent gesture integrity | ADV-01…04 | CONSENT P2/F-1/F-2/F-3/§3.2/§4; CLI-MCP MCP-010 |
| Session lease / demotion | ADV-05…08 | DELIVERY DEL-05/06/08/14/15/16/17; AUTH SUB-5 |
| Artifact remote safety | ADV-09…12 | DESIGN §4.5; ARTIFACTS §8.3/ART-030-032/049b/087; **resolved (C-3): three-segment host/owner/name grammar + host allowlist** |
| Invite lifecycle | ADV-13…18 | AUTH INV-4/5/6/7/§6.2, ENUM-3; WIRE §8.3/8.4/D30; **resolved (C-4): single invite code format, WIRE §8.3/8.4** |
| Idempotency / dedup | ADV-19…22 | WIRE §6/§7.1; `protocol.ts` vector; DELIVERY DEL-35/36/38 |
| Crash matrix | ADV-23…32 | DELIVERY §8 C1–C14, §5.3, §9; STATE §8.4 |
| Round containment | ADV-33…36 | STATE §8.2/§8.3/§8.4; WIRE §7.1/§11.7; DELIVERY DEL-42 |
| Rate / flooding | ADV-37…40 | STATE §9; WIRE §10; AUTH ENUM-3; **resolved (C-5): rate ceilings per WIRE §10 / protocol.ts RATE_LIMITS** |
| DLP / secrets | ADV-41…44 | WIRE §7.1 step 7; ARTIFACTS §9; AUTH CRED-4 |
| Revocation / subscription | ADV-45…48 | AUTH REV-2/4, SUB-2/3/4, ROT-1/4; DELIVERY DEL-41; **resolved (C-7): subscription is a transport-layer Convex reactive query, not a wire method** |
| diag.ping | ADV-49…52 | WIRE §8.1/§10/§11.6; AUTH READ-6; **resolved (C-8): peer presence readable only by the paired peer** |

The C-1…C-14 items that were the original release gates are **all resolved (§3)** and
replaced above with their single current authoritative value, so every fixture is
authorable against one authority.

---

## 5. Verifier verdict

The protocol's **containment core is sound and adversarially strong** where a single file
owns the rule: round-cap racing (A7), the crash matrix (A6), duplicate/drift dedup (A5),
status-flood rate backstops (A8, modulo the number), the no-fetch/offline artifact
guarantee (A3 SSRF sub-case), and secret DLP (A9) all hold up, with honestly labeled
friction-not-sandbox limits on consent (A1) and DLP (A9).

The **exploitable weaknesses were not in the threat reasoning but in cross-file drift** —
and that drift is now **eliminated**. All four original BLOCKING contradictions and all
seven MAJOR ones are RESOLVED (§3): the consent grant path (C-1) rides `send` with no MCP
consent tool (B1); the state vocabulary (C-2), repo host grammar (C-3), invite format
(C-4), send rate (C-5), `subscribe` status (C-7), `diag.ping` peer field (C-8) and 30/60 s
ceiling (C-12), invite TTL (C-9), claim lease (C-13, 5 min), and micro-thread `open`
literal (C-14) each now have exactly one authority and value.

**No attack in the named set is defeated by a conceptual gap.** `protocol.ts` is ratified
as the in-band tie-breaker for wire shapes; the prose files cite it and match it, so a
hostile reader has no weaker reading to choose. The named C-items are cleared for the
conformance suite.
