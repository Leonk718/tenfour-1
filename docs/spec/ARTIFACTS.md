# tenfour spec — ARTIFACTS

**Status: NORMATIVE, v1.0-draft. Part of the tenfour/1 normative artifact set required by DESIGN.md §11 R13.**
**Scope: artifact validation for protocol `tenfour/1` — grammar, per-type rules, caps, normalization, validation responsibilities, allowlist semantics, and the sender-side ancestor check (R5).**

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, MAY are
to be interpreted as described in RFC 2119. Every rule in this document carries a rule
ID (`ART-…`) and is intended to map 1:1 to a conformance test.

Wire errors in this document use the canonical registry (see `docs/spec/` error
catalog); wire format is `TENFOUR/<CODE>`. Codes referenced here:
`ARTIFACT_INVALID`, `REPO_NOT_ALLOWED`, `SECRET_DETECTED`, `BODY_TOO_LARGE`.
The registry is **closed**: no new top-level codes are introduced by this document.
Fine-grained causes are carried in the machine-readable `reason` field of the error
detail object (§9). `reason` subcodes are an **open** set governed by this spec.

---

## 1. Artifact types

`tenfour/1` defines exactly three artifact types. An artifact is a *reference*; tenfour
NEVER fetches, clones, or checks out anything (DESIGN §4.5).

| Rule | Statement |
|---|---|
| ART-001 | The `type` field MUST be exactly one of `git_commit`, `git_branch`, `pull_request`. Any other value ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"unknown_type"`. |
| ART-002 | Per-type field presence MUST match the table in §1.1. A REQUIRED field absent, or a FORBIDDEN field present ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"field_presence"`, with `field` naming the offender. |
| ART-003 | Unknown fields are **stripped, never rejected** — the WIRE §4 D9 strip-everywhere policy governs artifacts too: the broker strips fields not listed in §1.1 before validation, hashing, and persistence (stripped fields can never cause `CLIENT_ID_CONFLICT`, since the content hash covers a fixed field set). Shape violations of KNOWN fields (wrong type, bad grammar, forbidden-for-type presence per §1.1) remain `TENFOUR/ARTIFACT_INVALID`. Receivers MUST tolerate unknown artifact fields — forward compatibility per DESIGN §4.6. Senders MUST NOT emit fields outside §1.1. |

### 1.1 Field presence matrix

| Field | `git_commit` | `git_branch` | `pull_request` |
|---|---|---|---|
| `type` | REQUIRED (literal) | REQUIRED (literal) | REQUIRED (literal) |
| `repo` | REQUIRED | REQUIRED | REQUIRED |
| `ref` | REQUIRED | REQUIRED | FORBIDDEN |
| `sha` | REQUIRED | REQUIRED | FORBIDDEN |
| `number` | FORBIDDEN | FORBIDDEN | REQUIRED |
| `url` | FORBIDDEN | FORBIDDEN | REQUIRED |

Semantics:

- `git_commit`: a specific commit; `ref` names the branch (or tag) that contextualizes
  it and is the ref used for the ancestor check (§8).
- `git_branch`: a branch snapshot; `sha` is the tip the sender observed at send time.
- `pull_request`: reference only. No sha pinning; a `result` MUST NOT satisfy its
  sha-pinned-artifact requirement (§5, ART-050) with a `pull_request` alone.

### 1.2 Per-kind artifact permissions

| Rule | Statement |
|---|---|
| ART-010 | Artifacts are PERMITTED on kinds: `task`, `result`, `change_request` — EXACTLY the set owned by WIRE §5.2 / `protocol.ts ARTIFACT_KINDS`; this row is a cross-reference, not a second definition. |
| ART-011 | Artifacts are FORBIDDEN on the other seven kinds: `question`, `answer`, `accepted`, `declined`, `cancel`, `done`, `needs_human`. Violation ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"artifacts_forbidden_for_kind"`. **DECIDED HERE:** no non-artifact kind can smuggle references, so the R9 re-consent predicate (STATE [S]: never-before-referenced (`repo`,`sha`) pair, or repo change) remains decidable from `task`/`result`/`change_request` messages alone. |
| ART-012 | An absent `artifacts` field and an empty array `[]` are equivalent and both legal (where §1.2 permits and §5 does not require artifacts). **DECIDED HERE.** |

---

## 2. Canonical repo identifier

The canonical repo identifier is used in the artifact `repo` field AND in the
first-class `task.repo` envelope field (R10). Both are validated by the identical
grammar and identical checks.

### 2.1 Grammar (ABNF)

```abnf
repo-id   = host "/" owner "/" name
host      = dns-label *( "." dns-label ) [ ":" port ]
dns-label = 1*63( DIGIT / lower / "-" )      ; MUST NOT begin or end with "-"
lower     = %x61-7A                          ; a-z
port      = 1*5DIGIT                         ; decimal 1..65535
owner     = 1*100segchar
name      = 1*100segchar
segchar   = DIGIT / lower / "-" / "_" / "."
```

| Rule | Statement |
|---|---|
| ART-020 | A `repo-id` MUST match the ABNF above: exactly two `/` separators, ASCII only. |
| ART-021 | The wire form MUST be entirely lowercase. Adapters MUST lowercase before send; the broker MUST reject any uppercase byte (`reason:"not_canonical_case"`), never fold silently. **DECIDED HERE:** silent folding is forbidden because it would desynchronize the R11 canonical content hash between adapter and broker. |
| ART-022 | Internationalized hostnames MUST be pre-encoded to ASCII A-labels (punycode) by the sender. Raw non-ASCII ⇒ rejection under ART-020. **DECIDED HERE:** no IDN on the wire in v1 — this also forecloses the homoglyph-repo class. |
| ART-023 | `owner` and `name` MUST NOT be `.` or `..`. `name` MUST NOT end with `.git`; adapters MUST strip a trailing `.git` before send, and the broker MUST reject it if present (`reason:"dot_git_suffix"`). |
| ART-024 | Total `repo-id` length MUST be ≤ 300 characters; `host` ≤ 253 characters excluding port. |
| ART-025 | Nested group paths (e.g. GitLab subgroups, `host/a/b/c`) are NOT supported in v1; three or more `/` ⇒ rejection under ART-020. **DECIDED HERE:** two-segment paths only; revisit if a self-hosted GitLab user files the issue. |
| ART-026 | Repo-id equality everywhere in tenfour (allowlists, dedup, consent records, journal) is byte equality of the canonical lowercase form. No normalization at compare time — normalization happens once, at send. |

### 2.2 Allowed hosts (broker configuration)

| Rule | Statement |
|---|---|
| ART-030 | The broker MUST hold an `allowed_hosts` list — exact host strings (including port if any). Default: `["github.com"]`. Set at broker creation (`tenfour init --create-broker` prompt); mutable only by the broker owner (admin key). **DECIDED HERE:** default is GitHub-only; self-hosted forges are opt-in config, not default surface. |
| ART-031 | At send time the broker MUST reject any message whose `task.repo` or any artifact `repo` has a host not in `allowed_hosts` ⇒ `TENFOUR/REPO_NOT_ALLOWED`, `reason:"host_not_allowed"`. |
| ART-032 | `allowed_hosts` matching is exact byte equality against the canonical host (no wildcards, no suffix matching). **DECIDED HERE:** wildcard hosts invite `evil-github.com` classes; exactness is testable. |

---

## 3. `sha` rules

| Rule | Statement |
|---|---|
| ART-040 | `sha` MUST match `^([0-9a-f]{40}|[0-9a-f]{64})$`. Lowercase hex only; adapters MUST lowercase before send; the broker MUST reject uppercase (`reason:"sha_not_lowercase"`) and any other length (`reason:"sha_bad_length"`). |
| ART-041 | The hash algorithm is **discriminated by length alone**: 40 hex chars ⇒ SHA-1 object name; 64 hex chars ⇒ SHA-256 object name. There is no algorithm field. **DECIDED HERE:** length discrimination is unambiguous (the ranges cannot collide) and matches git's own object-name handling. |
| ART-042 | Abbreviated shas are FORBIDDEN on the wire. Display layers MAY shorten. |
| ART-043 | tenfour MUST NOT validate that the sha exists in any repository at broker level — the broker has no repository access by design. Existence checks are adapter-local only (§8). |

---

## 4. `ref`, `number`, `url` rules

### 4.1 `ref`

`ref` is a **short** ref name (e.g. `main`, `feature/tf-31-inbox`), never fully
qualified.

| Rule | Statement |
|---|---|
| ART-045 | `ref` MUST be 1..255 bytes measured in UTF-8 after NFC normalization (§7). |
| ART-046 | `ref` MUST NOT: begin with `refs/` (`reason:"ref_fully_qualified"`); begin with `-`; begin or end with `/`; contain `//`; contain `..`; contain `@{`; equal `@`; end with `.` or `.lock`; contain any of space, `~`, `^`, `:`, `?`, `*`, `[`, `\`, or any control character (U+0000–U+001F, U+007F). Each `/`-separated component MUST NOT begin with `.` or end with `.lock`. (This is the `git check-ref-format` rule set, restated so it is testable without shelling out.) Violations ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"ref_malformed"`. |
| ART-047 | Non-ASCII refs are LEGAL (git permits UTF-8 branch names) but MUST be NFC-normalized per §7. |

### 4.2 `number` (pull_request)

| Rule | Statement |
|---|---|
| ART-048 | `number` MUST be a JSON integer in [1, 999999999] (WIRE D13 / `protocol.ts LIMITS.PR_NUMBER_MAX` own the cap). Strings, floats, zero, negatives, over-cap ⇒ `reason:"number_invalid"`. |

### 4.3 `url` (pull_request)

| Rule | Statement |
|---|---|
| ART-049a | `url` MUST be an absolute `https://` URL, ≤ 512 characters (WIRE D13 / `protocol.ts LIMITS.URL_MAX_CHARS` own the cap), ASCII only. `http://`, other schemes, credentials-in-URL (`user:pass@`) ⇒ `reason:"url_invalid"`. |
| ART-049b | The URL's host (compared case-insensitively, including port) MUST equal the artifact's `repo` host ⇒ else `reason:"url_host_mismatch"`. **DECIDED HERE:** this stops a `github.com/...` artifact smuggling a link to an arbitrary domain into a human-clickable surface. |
| ART-049c | The broker MUST validate `url` purely syntactically. It MUST NOT fetch it, resolve it, or follow redirects — ever. |

---

## 5. Count and size caps

| Rule | Statement |
|---|---|
| ART-050 | A `result` MUST carry ≥ 1 sha-pinned artifact (`git_commit` or `git_branch`). Enforced by the broker at send ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"result_requires_sha_artifact"`. A `pull_request` alone does not satisfy this. |
| ART-051 | Max artifacts per message: **8** (WIRE D13 / `protocol.ts LIMITS.ARTIFACTS_MAX` own the cap). Exceeding ⇒ `reason:"too_many_artifacts"`. 8 covers the worked example (branch + PR + a few commits) with headroom; larger sets belong in the PR description, not the relay. |
| ART-052 | The serialized `artifacts` array (canonical JSON per the wire-schema spec, UTF-8, post-NFC) MUST be ≤ 8192 bytes (WIRE D13 / `protocol.ts LIMITS.ARTIFACTS_MAX_BYTES` own the cap) ⇒ else `reason:"artifacts_too_large"`. **DECIDED HERE:** artifact overflow is `ARTIFACT_INVALID`, not `BODY_TOO_LARGE` — `BODY_TOO_LARGE` is reserved for the `body` field and total-envelope caps defined in the envelope spec. |
| ART-053 | Field length caps recap (values owned by WIRE D13 / protocol.ts): `repo` ≤ 300 chars (ART-024); `ref` ≤ 255 bytes (ART-045); `url` ≤ 512 chars (ART-049a); `sha` exactly 40 or 64 (ART-040). |

---

## 6. Duplicate handling (within one message)

| Rule | Statement |
|---|---|
| ART-060 | Two `git_commit`/`git_branch` artifacts in the same message MUST NOT share the tuple (`type`, `repo`, `ref`) — regardless of `sha`. Two `pull_request` artifacts MUST NOT share (`repo`, `number`) — regardless of `url`. Comparison is post-normalization byte equality. Violation ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"duplicate_artifact"`, with the zero-based indices of both offenders in `detail`. |
| ART-061 | The broker MUST reject, never silently dedupe. **DECIDED HERE:** silent dedupe would hide model confusion and desynchronize the R11 content hash; the error copy teaches ("remove the duplicate artifact at index N and resend"). |
| ART-062 | The same (`type`,`repo`,`ref`) appearing with a *different* sha in a *later message of the same thread* is legal and expected (branch advanced). Cross-message dedup does not exist. |

---

## 7. Unicode normalization

| Rule | Statement |
|---|---|
| ART-070 | Every artifact string field (`repo`, `ref`, `url` — and `sha`, trivially ASCII) MUST be Unicode NFC on the wire. The **adapter** normalizes to NFC *before* computing the R11 canonical content hash and before send. |
| ART-071 | The **broker** MUST verify is-NFC and reject non-NFC input ⇒ `TENFOUR/ARTIFACT_INVALID`, `reason:"not_nfc"`, naming the field. The broker MUST NOT normalize silently (same rationale as ART-021/ART-061: a byte-changing broker breaks `client_id` + content-hash idempotency). |
| ART-072 | `body` normalization is governed by the envelope spec, not this document. This document governs artifact fields and `task.repo` only. |

---

## 8. The ancestor check (R5) — sender-side push verification

Replaces `git ls-remote` (rejected: reintroduced the SSRF/network class). Runs in the
**sending adapter**, before any message carrying a `git_commit` or `git_branch`
artifact is transmitted.

### 8.1 Preconditions and configuration

| Rule | Statement |
|---|---|
| ART-080 | The check MUST run for every outbound message containing ≥ 1 `git_commit` or `git_branch` artifact, for each such artifact, regardless of kind. `pull_request` artifacts are never checked. |
| ART-081 | The sender's checkout map derives from `workspaces[]` in `~/.tenfour/config.json` (canonical schema: `packages/schema/src/config.ts`): each entry is an absolute path of a local checkout; the adapter resolves each workspace's canonical repo-id (`host/owner/name`) from its `origin` remote (remote name `origin` in v1). An artifact `repo` matches the workspace whose derived repo-id is byte-equal. |
| ART-082 | If the artifact's `repo` matches no workspace checkout on the sender machine, the check is **SKIPPED** and the send proceeds; the tool response MUST carry the warning string `ARTIFACT_ANCESTOR.SKIPPED_NO_CHECKOUT` (§8.4). **DECIDED HERE:** blocking would forbid legitimate flows (referencing a repo the sender has never cloned); a sender without a checkout cannot have minted an unpushed sha there, so the risk the check exists for is absent. |

### 8.2 Exact invocation

Both steps run with environment `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
`LC_ALL=C`, with inherited `GIT_DIR`/`GIT_WORK_TREE` removed from the child
environment, and a per-command timeout of 5 seconds.

```
Step 1 — object existence:
  git -C <path> cat-file -e <sha>^{commit}

Step 2 — pushed-ness:
  git -C <path> merge-base --is-ancestor <sha> refs/remotes/<remote>/<ref>
```

| Rule | Statement |
|---|---|
| ART-083 | Step 1 exit ≠ 0 ⇒ fail with `ARTIFACT_ANCESTOR.NO_SUCH_SHA`; Step 2 is not run. |
| ART-084 | Step 2 exit 0 ⇒ PASS. Exit 1 ⇒ fail with `ARTIFACT_ANCESTOR.NOT_PUSHED`. Exit 128 (missing `refs/remotes/<remote>/<ref>`) ⇒ fail with `ARTIFACT_ANCESTOR.NO_TRACKING_REF`. Timeout ⇒ fail with `ARTIFACT_ANCESTOR.GIT_TIMEOUT`. |
| ART-085 | Any failure ⇒ the send MUST NOT happen. The failure is surfaced to the model as a tool result with `code:"TENFOUR/ARTIFACT_INVALID"`, `retryable:false`, and the `reason` subcodes `sha_not_found` / `sha_not_pushed` / `no_tracking_ref` / `git_timeout`. **DECIDED HERE:** pre-send local failures reuse `ARTIFACT_INVALID` (closed registry; the artifact is not sendable as constituted) with adapter-local `reason` subcodes — no new top-level code. |
| ART-086 | For `git_commit` the `<ref>` used in Step 2 is the artifact's own `ref` field; likewise for `git_branch`. |

### 8.3 No-network guarantee (normative statement)

> The ancestor check performs **zero network I/O**. `git cat-file` and
> `git merge-base` are plumbing commands that read only the local object database and
> local refs. The adapter never invokes `fetch`, `pull`, `push`, `clone`, `ls-remote`,
> or `submodule` — in this check or anywhere else. `GIT_TERMINAL_PROMPT=0` guarantees
> no credential helper or terminal prompt can be reached or hung on. The check
> completes identically with all network interfaces down.

| Rule | Statement |
|---|---|
| ART-087 | CI MUST include a conformance test executing both steps under a disabled network namespace (Linux job: `unshare -rn`) and MUST pass. |
| ART-088 | Honesty rule: the check reflects the local remote-tracking ref, which is as fresh as the human's last fetch. A false **failure** is possible (pushed, not yet fetched — safe direction: copy says push/fetch first). A false **pass** is possible after a remote force-push removed the sha. Docs MUST state this: the check is a pre-flight aid that saves protocol rounds; it is not a security control and not a guarantee of remote state. |

### 8.4 Failure copy (bytes owned by `strings.ts` export `ARTIFACT_ANCESTOR`)

The five strings live in `packages/adapter/src/strings.ts` under the exported
object `ARTIFACT_ANCESTOR` — the single source of the bytes; this spec cites keys
only:

| Key | Fires on |
|---|---|
| `ARTIFACT_ANCESTOR.NOT_PUSHED` | Step 2 exit 1 (ART-084) |
| `ARTIFACT_ANCESTOR.NO_SUCH_SHA` | Step 1 exit ≠ 0 (ART-083) |
| `ARTIFACT_ANCESTOR.NO_TRACKING_REF` | Step 2 exit 128 (ART-084) |
| `ARTIFACT_ANCESTOR.GIT_TIMEOUT` | 5 s per-command timeout (ART-084) |
| `ARTIFACT_ANCESTOR.SKIPPED_NO_CHECKOUT` | No workspace checkout (ART-082) |

All failure strings state what happened, what is true now, and one action — never
anything retryable-sounding (JOURNEYS §4 doctrine).

---

## 9. Who validates what

| Layer | Validates | When | Error surface |
|---|---|---|---|
| **Sending adapter** | Everything the broker validates (fail fast, same rules); NFC normalization + lowercase canonicalization (performs, not just checks); best-effort secret scan over `body` AND all artifact strings (`ref` and `url` included — a token pasted into a branch name is caught here) ⇒ `TENFOUR/SECRET_DETECTED`; ancestor check §8 | Pre-send | Tool result to the model; send suppressed |
| **Broker** | Shape ONLY: §1 type/presence, §2 grammar + case + `allowed_hosts` (ART-031), §3 sha, §4 ref/number/url, §5 caps + kind rules (ART-050), §6 duplicates, §7 NFC verification. MAY additionally run the shared secret-regex corpus (defense in depth) ⇒ `TENFOUR/SECRET_DETECTED` | At `send`, atomically inside the send mutation | Typed wire rejection `TENFOUR/<CODE>`, `retryable:false` |
| **Receiving adapter** | Receiver repo allowlist (§10) — the ONLY layer that can: the allowlist lives in the receiver's local config | At **surface time**, every surface attempt | Human-directed notice (§10.3); never a wire error back to the sender |

| Rule | Statement |
|---|---|
| ART-090 | **Two allowlist layers exist, with distinct names and duties.** (1) The pair's invite-time `repo_allowlist` (WIRE §8.2 D27) is enforced by the BROKER at send (`TENFOUR/REPO_NOT_ALLOWED`, validation step 12) — plus the broker's own `allowed_hosts` (ART-031). (2) The receiver's local `allowed_repos` (config.ts) is enforced by the RECEIVING ADAPTER at surface time (§10) — the broker MUST NOT attempt to read or enforce it; it has no access to receiver config, and pretending otherwise would be a false security claim. |
| ART-091 | The broker MUST NOT perform any repository, filesystem, or network reachability validation of artifacts (ART-043, ART-049c). |
| ART-092 | Validation order at the broker is the WIRE §7.1 D19 13-step order: artifact shape checks run inside step 6 (in rule-ID order), the pair `repo_allowlist` at step 12; the FIRST failure is returned. One error per rejection. **DECIDED HERE:** single-error responses keep the model's recovery unambiguous (doctrine: one action instead). |

---

## 10. Receiver repo allowlist — surface-time semantics

### 10.1 Configuration

| Rule | Statement |
|---|---|
| ART-100 | The receiver's `~/.tenfour/config.json` holds `allowed_repos`: an array of canonical three-segment repo-ids (schema: `packages/schema/src/config.ts`). **DECIDED HERE (amended):** exact values only — no globs or wildcards in `tenfour/1` (matching CONSENT §8's no-glob rule); wildcard grants are deferred to v1.1. |
| ART-101 | A message is allowlist-clean iff `task.repo` (when present) AND every artifact `repo` match an `allowed_repos` entry by byte equality of the canonical lowercase form (ART-026). |

### 10.2 Evaluation time

| Rule | Statement |
|---|---|
| ART-102 | The allowlist is evaluated at **surface time** — the moment the receiving adapter is about to inject the message into a Claude session (SessionStart digest expansion, Stop/UserPromptSubmit/PostToolUse injection, `tenfour_wait` return, or `tenfour inbox --thread`). It is NOT evaluated at queue time, and it is re-evaluated on **every** surface attempt. |
| ART-103 | Consequence (normative, both directions): a repo allowed at send but removed from the allowlist before surfacing ⇒ blocked at surfacing. A repo NOT allowed at send but added before surfacing ⇒ surfaces normally. The broker's queue is oblivious to either change. |

### 10.3 Blocked-at-surface behavior

| Rule | Statement |
|---|---|
| ART-104 | On allowlist failure the adapter MUST NOT inject the message body. It injects a notice instead, carrying: `TENFOUR/REPO_NOT_ALLOWED`, `reason:"receiver_allowlist"`, thread id, sender, kind, and the offending repo-id(s) — but no body content. The notice bytes are owned by the `strings.ts` export `ARTIFACT_ALLOWLIST_BLOCKED` (single source; this spec quotes nothing). |
| ART-105 | Journal state remains `received` with `blocked_reason:"REPO_NOT_ALLOWED"`; **no ack is sent** (R2: ack means model-received; the content was not delivered to the model). The sender consequently sees ordinary unacked staleness in `tenfour status` — no phantom acks, no silent drops. |
| ART-106 | The notice is injected at most once per session per message (bounded by the journal, mirroring the wrong-repo rule in JOURNEYS §4); `tenfour inbox` continues to list the blocked message with its blocked reason until resolved. |
| ART-107 | After the human edits `allowed_repos`, the next surface attempt (ART-102) re-evaluates and, if clean, performs a normal full surfacing with normal ack flow. No special "unblock" verb exists. |

---

## 11. Interaction with `task.repo` (R10)

| Rule | Statement |
|---|---|
| ART-110 | `task.repo` is REQUIRED on `task`, FORBIDDEN on all other kinds (envelope spec), and validated by §2 grammar + ART-031 host allowlist at the broker, identically to artifact `repo` fields. |
| ART-111 | Artifacts on a `task` MAY reference repos other than `task.repo` (e.g. a design-spec commit in a sibling repo). There is no equality constraint. Receiver-side, ART-101 already requires ALL referenced repos to be allowlisted. **DECIDED HERE.** |
| ART-112 | Re-consent per R9 is governed by the SINGLE normative predicate of STATE-MACHINE §5 [S] (cross-referenced by WIRE D16 and CONSENT §6): a `change_request` triggers iff it carries ≥ 1 artifact whose (`repo`, `sha`) pair was never previously referenced in this thread, OR it names a `repo` differing from the thread's declared repo. This row is a cross-reference, not a second definition. |

---

## 12. Conformance checklist (test IDs = rule IDs)

Every ART-xxx rule above MUST have at least one passing test in the adversarial
matrix, including at minimum: uppercase repo/sha rejection (ART-021/040), NFD input
rejection (ART-071), `refs/heads/` prefixed ref rejection (ART-046), 41- and 63-hex
sha rejection (ART-040), duplicate artifact rejection with indices (ART-060), result
with only a `pull_request` rejection (ART-050), 9-artifact rejection (ART-051),
host-not-allowed rejection (ART-031), allowlist add/remove-between-queue-and-surface
both directions (ART-103), no-ack-on-block (ART-105), and the offline ancestor-check
run (ART-087).
