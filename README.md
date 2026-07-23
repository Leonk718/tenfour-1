# tenfour

**10-4 between your Claudes.** A durable, human-gated task relay between two Claude Code
sessions on two machines. Certified mail, not a chat app.

Two developers, each running Claude Code. One's Claude ships a design; the other's Claude
implements it — a structured hand-off that survives closed laptops, enforces its own loop
limits, and never lets one AI's message act as the other human's authority. Think EMS and
NYPD dispatchers: two desks, each with a radio operator, passing structured traffic
neither side has to be present to receive.

> **Status:** pre-1.0. The `tenfour/1` protocol is frozen and conformance-tested; the
> broker, adapter, and CLI are implemented and covered by an automated suite. Cross-Mac /
> Windows / Linux. MIT. No telemetry.

## What it is

- **1:1, durable, async.** A task sent while the peer's session is closed lands the next
  time it opens. Mailbox, not doorbell.
- **Human-gated.** Received work never auto-runs. The receiving human says go (or writes a
  standing rule). Merges, deploys, and secrets are always human acts.
- **Loop-safe by construction.** Round caps, rate ceilings, and terminal-reply rejection
  are enforced in the broker — not in a prompt — so two confused agents can't spin.
- **Model-legible.** Every protocol error is a typed, instructive message that tells the
  agent to stop and inform its human, never to retry.

## What it is not

Not a secure autonomous-agent substrate, not end-to-end encrypted, not a general
multi-agent framework, not realtime chat. See [SECURITY.md](docs/SECURITY.md) for the
threat model and the honest limits of each control.

## The 60-second security model

| Layer | What it actually guarantees |
|---|---|
| Per-agent bearer token (256-bit, sha256-hashed at rest) | Broker writes require a valid token; `from` is derived from it, so spoofing is a rejected write, not a detection problem. |
| Broker-enforced protocol (state machine, head rule, round caps, rate ceiling, size caps) | Loops and storms die at the database even if both models are confused. This is code, tested, and the strongest claim we make. |
| Provenance wrapping (per-message nonce delimiters + fixed framing) | Marks every inbound message as peer-agent task input so the model always knows it isn't a human instruction. **Provenance, not an injection boundary** — it can't stop a model from being persuaded by content. |
| Shipped permission rules + human gate list | Friction and audit points for merge/deploy/push/deps/secrets/spend. **Permission rules are friction, not a sandbox.** The human at the keyboard is the real boundary. |
| Best-effort DLP secret scan | Rejects common credential shapes on send. Coarse by design; the real control is refs-not-content. |

The peer human is **trusted**. In scope: compromised/prompt-injected peer *sessions*,
accidental loops, token leakage, open-relay abuse, secret spillage. Out of scope: a
malicious co-founder, broker-operator confidentiality (bodies are plaintext to the broker
— stated), OS-level sandboxing.

## Quickstart

One person owns the broker; the other just redeems a pairing code and never touches the
backend.

```bash
# Both machines
npm install -g tenfour

# Owner (once): create the broker + your agent
tenfour init --create-broker      # runs the Convex CLI; free tier, no card
tenfour invite jonathan/web        # prints a one-line TENFOUR1.… pairing code

# Peer: redeem the code (paste when prompted — never on the command line)
tenfour join                       # masked paste; confirms "joining as … — correct?"

# Both: designate the repos peer work may touch, then verify
tenfour init --workspace           # run inside each repo you'll collaborate on
tenfour doctor                     # 14 checks: hooks fire, rules present, broker reachable
```

Then launch Claude Code as usual — the four hooks and four MCP tools are installed at user
scope. Full walkthrough (macOS + Windows native/WSL): [docs/SETUP.md](docs/SETUP.md).

## The hand-off, end to end

```
brian/design                                   jonathan/web
  │  commits the spec, sends:                     │
  ├─ task {repo, artifacts:[design@sha]} ───────▶ │  (SessionStart injects it)
  │                                               │  human says go →
  │                                        ◀────── ┤  accepted   (tenfour accept)
  │                                               │  …implements on a branch…
  │  (inbox)                               ◀────── ┤  result {branch@sha, PR#42}
  │  verifies 1:1 against the checklist            │
  ├─ done  ──────────────────────────────────────▶│
  │                                               │
        A human merges the PR. Always.
```

Round budget shown to both humans every step; if a thread hits the cap it freezes and both
humans get a `needs_human`. Nothing merges, deploys, or runs on the peer's say-so.

## Documentation

- [PROTOCOL](docs/spec/) — `tenfour/1` wire format, state machine, auth, delivery,
  consent, artifacts. A second implementer can build from these.
- [SECURITY](docs/SECURITY.md) — threat model, scope, disclosure.
- [SETUP](docs/SETUP.md) — 10-minute install for both platforms.
- [FAQ](#faq) — below.

## FAQ

**Why not Slack / a shared repo / GitHub issues?** Those are great for humans. tenfour is
for the *agents* — a durable, human-gated hand-off with a lifecycle (accept → result →
review → done), broker-enforced loop limits, and protocol errors the model can actually
act on. If two attentive humans are both online, a branch + a Slack ping is simpler; say
so. tenfour earns its keep on async continuation and enforced limits.

**"Two AIs talking sounds like a loop machine."** It can't loop unbounded: the broker caps
rounds per thread and messages per hour, rejects replies to terminal messages, and freezes
a thread to both humans at the cap. These are database invariants, not prompt requests.

**Does my code get sent to a third party?** Messages carry *references* (git commits, PRs)
— a 16 KB body cap makes pasting a codebase impossible by design. The broker (Convex by
default) can read message bodies and metadata in plaintext; it is **not** end-to-end
encrypted, and SECURITY.md says so. Self-hosting the broker is on the roadmap.

**Why Convex?** It's the v1 broker implementation behind a small 4-method interface
(`send`/`inbox`/`ack`/`thread` + the invite/diag methods). The data model is documented
and the interface is swappable; a self-host guide ships when CI exercises it, not before.

**Why only two agents?** v1 is deliberately 1:1 — it's the shape that made the design
tractable and testable. More agents is a future direction, not a v1 promise.

**Is this "secure"?** It's a durable, human-gated relay with honest, layered controls — not
a sandbox and not an autonomous-agent safety system. Read SECURITY.md; the claims there are
the ones we'll defend.

## Contributing

Issues and PRs welcome. Protocol changes go through `docs/spec/` first. Security reports:
see [SECURITY.md](docs/SECURITY.md) (GitHub Private Vulnerability Reporting).

## License

MIT. No telemetry, ever.
