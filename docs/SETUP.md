# Setup

Two machines, ~10 minutes each. One person owns the broker; the other redeems a pairing
code and never touches the backend. Works on macOS, Windows (native PowerShell or WSL),
and Linux.

## Prerequisites

- **Node 20+** on both machines (`node --version`).
- The owner needs a free **Convex** account (created on first `npx convex login`; no card).
- **Claude Code** installed on both machines (the hooks and MCP tools attach to it).

```bash
npm install -g tenfour        # both machines
```

## Owner — create the broker (once)

The broker is the small Convex backend that relays messages. You provision it once.

```bash
tenfour init --create-broker
```

This runs `npx convex login` + `npx convex deploy` for the bundled broker, generates a
256-bit **admin key**, stores it and the deployment URL in the broker config, and writes
`~/.tenfour/admin.json` (broker URL + admin key, `0600` / icacls-locked). Keep that file
private — it mints invites.

> Behind the scenes this calls the broker's one-time `setup.initConfig` (control-plane,
> not a wire method) to record the admin-key hash and the deployment URL that every invite
> code embeds. The admin key hash is never overwritten (no takeover); re-running only
> refreshes the URL, and only for the key holder.

## Owner — invite your peer

```bash
tenfour invite jonathan/web
```

Prints a one-line `TENFOUR1.…` pairing code (default TTL 24h, single use). Send it over a
channel you both trust — a shared password-manager item is best (cross-platform, nothing
to retype). The code carries the broker URL, so the peer needs nothing else.

## Peer — join

```bash
tenfour join                  # prompts: paste your code (masked), then confirms "joining as … — correct?"
# or, non-interactively (the code lands in shell history):
tenfour join --code TENFOUR1.… --yes
```

On success it prints `paired: jonathan/web ↔ brian/design (round budget 10)` and writes
`~/.tenfour/config.json` + `credentials.json` (token, `0600` / icacls-locked). Delete the
code message afterward.

## Both — designate workspaces and verify

Run inside each git repo the two of you will collaborate in, so peer-driven work is gated
there and nowhere else:

```bash
tenfour init --workspace
```

Then verify the whole install:

```bash
tenfour doctor
```

`doctor` runs 14 checks (config, credential permissions, Node runtime, PATH, broker
reachability, auth, clock skew, hooks fire, gate rules, journal, repo map, notifications,
consent surface, workspace tagging). A clean install prints `[PASS]` for all 14.

## Windows notes

- **PowerShell execution policy:** if the first `tenfour …` command is blocked, run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or invoke `tenfour.cmd`.
- Config lives under `%USERPROFILE%\.tenfour\` and is locked with `icacls` (the POSIX
  `chmod 0600` equivalent). `tenfour doctor` verifies the ACL.
- **WSL:** run `where.exe claude` (PowerShell) and `which claude` (WSL) to confirm which
  side Claude Code is on, and install `tenfour` on that same side (nvm recommended in WSL).

## What you get

Claude Code now has the four tenfour MCP tools and four hooks at user scope. When your
peer's Claude sends you a task, it surfaces in your session (never auto-runs); you grant it
with `tenfour accept <thread>`, and the round trip proceeds — task → accepted → result →
done, with a human merging at the end. See the [README](../README.md) for the full flow.
