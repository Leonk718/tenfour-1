/**
 * tenfour CLI — `tenfour approve <thread-id> --kind <kind> [--body <text>]
 * [--artifact git:<repo>@<sha>:<ref>] [--pr <repo>#<number>:<url>]` (CLI-MCP §1.5). The
 * unfreeze gesture: issues a `send` carrying unfreeze:true for a frozen thread. --kind is
 * REQUIRED and MUST NOT be `accepted` (use tenfour accept). Prints the freeze reason,
 * resume_state, and round budget BEFORE sending. Non-frozen thread → success no-op.
 */

import { KindSchema, type Artifact, type Kind } from '../../../schema/src/protocol.ts';
import { ulid } from '../../../adapter/src/ids.ts';
import { shortThreadId } from '../../../adapter/src/strings.ts';
import { LocalError, requireClient, type CliContext } from '../context.ts';
import { resolveThreadId } from './accept.ts';
import { out, printBrokerError, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}

/** Parse `git:<repo>@<sha>:<ref>` (git_commit) or `branch:<repo>@<sha>:<ref>` (git_branch). */
function parseGitArtifact(spec: string): Artifact {
  const [prefix, rest] = spec.startsWith('branch:') ? ['git_branch', spec.slice(7)] : ['git_commit', spec.replace(/^git:/, '')];
  const at = rest.indexOf('@');
  const colon = rest.indexOf(':', at + 1);
  if (at < 0 || colon < 0) throw new LocalError(`--artifact must be git:<repo>@<sha>:<ref> (got ${spec})`);
  const repo = rest.slice(0, at);
  const sha = rest.slice(at + 1, colon);
  const ref = rest.slice(colon + 1);
  return { type: prefix as 'git_commit' | 'git_branch', repo, sha, ref };
}

/** Parse `<repo>#<number>:<url>` (pull_request). */
function parsePrArtifact(spec: string): Artifact {
  const hash = spec.indexOf('#');
  const colon = spec.indexOf(':', hash + 1);
  if (hash < 0 || colon < 0) throw new LocalError(`--pr must be <repo>#<number>:<url> (got ${spec})`);
  const repo = spec.slice(0, hash);
  const number = Number(spec.slice(hash + 1, colon));
  const url = spec.slice(colon + 1);
  if (!Number.isInteger(number)) throw new LocalError(`--pr number must be an integer (got ${spec})`);
  return { type: 'pull_request', repo, number, url };
}

export async function runApprove(argv: string[], ctx: CliContext, flags: GlobalFlags): Promise<number> {
  const arg = argv.find((a) => !a.startsWith('--'));
  if (!arg) throw new LocalError('usage: tenfour approve <thread-id> --kind <kind> [--body <text>] [--artifact …] [--pr …]');
  if (!ctx.credentials) throw new LocalError('no credentials.json — run tenfour join first');

  const kindStr = flagValue(argv, '--kind');
  if (!kindStr) throw new LocalError('--kind is required for tenfour approve');
  if (kindStr === 'accepted') {
    throw new LocalError('use tenfour accept, which accepts and unfreezes in one step; approve never sends accepted.');
  }
  const kindParsed = KindSchema.safeParse(kindStr);
  if (!kindParsed.success) throw new LocalError(`unknown kind '${kindStr}'`);
  const kind: Kind = kindParsed.data;
  const body = flagValue(argv, '--body') ?? '';
  const repo = flagValue(argv, '--repo') ?? null;
  const artifacts: Artifact[] = [...flagValues(argv, '--artifact').map(parseGitArtifact), ...flagValues(argv, '--pr').map(parsePrArtifact)];

  const client = requireClient(ctx);
  const threadId = await resolveThreadId(client, arg);
  const short = shortThreadId(threadId);
  const tr = await client.thread({ thread_id: threadId });
  if (!tr.ok) {
    printBrokerError(tr.error);
    return EXIT.BROKER_REJECTED;
  }
  const t = tr.thread;
  if (t.status !== 'frozen') {
    out(`thread ${short} is not frozen — nothing to approve.`);
    return EXIT.OK;
  }

  // Print the freeze context BEFORE sending (CLI §1.5).
  out(`thread ${short} is frozen (${t.frozen_reason}); resume_state ${t.resume_state}; round ${t.round}/${t.max_rounds}.`);
  const to = t.initiator === ctx.credentials.agent ? t.recipient : t.initiator;

  const resp = await client.send({
    client_id: ulid(),
    to,
    kind,
    thread_id: threadId,
    parent_id: t.head_id,
    repo,
    body,
    artifacts,
    unfreeze: true,
  });
  if (!resp.ok) {
    printBrokerError(resp.error);
    return EXIT.BROKER_REJECTED;
  }
  out(`resumed — thread ${short} is now ${resp.thread.status} (round ${resp.thread.round}/${resp.thread.max_rounds}).`);
  return EXIT.OK;
}
