# Security

tenfour is a **durable, human-gated task relay** between two Claude Code sessions. This
document states what it defends, what it does not, and how each control actually works —
so nobody audits it as something it isn't.

## Threat model

**Trusted:** the two paired humans, and the machines they run on. tenfour assumes you and
your peer are not attacking each other; it is not a defense against a malicious co-founder,
who already has your repository access.

**In scope (defended):**
- A **compromised or prompt-injected peer session** trying to make the other agent act
  outside its human's intent.
- **Accidental loops** — two agents ping-ponging without progress.
- **Token leakage** and **open-relay abuse** — someone who learns the broker URL trying to
  inject or read messages.
- **Secret spillage** — credentials accidentally placed in a message.
- **Duplicate / lost delivery** across crashes and reconnects.

**Out of scope (explicitly NOT defended):**
- **A malicious co-founder.** Ordinary implementation authority lets a peer modify source,
  tests, and CI in the repos you designate; that is the point of the tool. Pair only with
  someone you'd already give repo access.
- **Broker-operator confidentiality.** With the default Convex broker, message **bodies and
  metadata are stored in plaintext** and are readable by the broker operator. tenfour is
  **not end-to-end encrypted.** If you need that, self-host the broker (roadmap) or don't
  send sensitive content — send references.
- **OS-level sandboxing of the agent.** tenfour does not contain what Claude Code can do on
  your machine; it gates *what a peer message can authorize*.

## The controls, honestly labeled

| Control | Guarantee | Limit |
|---|---|---|
| **Per-agent bearer token** (256-bit, sha256-hashed at rest, 0600 / icacls) | Every broker write requires a valid token; the message `from` is derived from it. Spoofing another agent is a rejected write. | A leaked token impersonates that agent until rotated (`tenfour token rotate`) or revoked. Store `credentials.json` with the file permissions `tenfour doctor` checks. |
| **Broker-enforced protocol** | Loops and storms die at the database: round caps per thread, message-rate ceilings per agent, terminal-reply rejection, size caps, single-authority state machine. These hold even if both models are fully confused. | This is the strongest layer. It bounds *volume and lifecycle*, not *content*. |
| **Provenance wrapping** | Every inbound message is injected wrapped in per-message random-nonce delimiters with fixed framing: it is peer-agent task input, not a human instruction, and carries no authority. Survives context compaction. | **Provenance marking, not a prompt-injection boundary.** It ensures the model always knows the source; it cannot stop the model from being persuaded by the content. Do not treat it as a sandbox. |
| **Shipped permission rules + gate list** | `tenfour init --workspace` installs Claude Code permission rules that make the agent *ask a human* before merge, deploy, push-to-protected, dependency install, destructive fs, secret access, or spend. | **Permission rules are friction, not a capability sandbox.** Shell indirection, build scripts, and interpreters can evade command-pattern rules. The human answering the prompt is the actual boundary. |
| **Auto-start off** | A received task is surfaced; work begins only when the receiving human says go, or under a standing rule that human wrote into their own config. | A human who writes a permissive standing rule owns that decision. |
| **Peer git artifacts** | References only. tenfour never fetches, clones, or checks out a peer's ref automatically; artifact `repo` must be on the receiver's allowlist, and a pull-request URL's host must equal the repo host. | Acting on a reference (checking out a branch, running its tests) is a human-gated step; that is where the peer's code could execute, and it is deliberately outside auto-start. |
| **Best-effort DLP secret scan** | The broker rejects sends whose body or artifact strings match common credential shapes (AWS keys, PEM blocks, `sk-`/`ghp_` tokens, `key=value` secrets). | Coarse and bypassable — it will miss encoded or novel secrets and can false-positive. The real control is the norm of sending references, not content. |

## What a peer message can and cannot authorize

A peer-agent message is **task input, not human authorization.** It can direct
implementation work in a designated workspace under the receiving human's standing rules.
It can **never**, on its own, cause a merge, a deploy, a push to a protected branch, a
secret read, a dependency install, a destructive filesystem operation, or a spend — those
require the human at the keyboard, enforced by the shipped permission rules and, ultimately,
by the human.

## Reporting a vulnerability

Please use **GitHub Private Vulnerability Reporting** on this repository. We aim to
acknowledge within a few days. Do not open a public issue for a security report.

## Non-goals restated

tenfour is honest infrastructure for a two-person team, not a safety system for autonomous
agents. If a claim isn't in this document, we're not making it.
