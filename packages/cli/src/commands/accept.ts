/**
 * tenfour CLI — `tenfour accept <thread-id>` (CLI-MCP §1.4; CONSENT §3.1). The R8
 * structured consent gesture. Fetch thread → verify caller is the recipient and the
 * thread is `offered` (or `frozen` with resume_state:offered) → send kind:accepted with
 * consent {token, granted_via:"cli_accept"} (+ unfreeze:true when frozen). Prints the
 * root task summary, repo, and round budget BEFORE the send. One STALE_HEAD retry.
 */

import { ULID_REGEX } from '../../../schema/src/protocol.ts';
import type { BrokerClient } from '../../../adapter/src/client.ts';
import { ulid } from '../../../adapter/src/ids.ts';
import { CONSENT_ALREADY_ACTIVE_NOTE, fmt, shortThreadId } from '../../../adapter/src/strings.ts';
import { LocalError, requireClient, type CliContext } from '../context.ts';
import { out, printBrokerError, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

/** Resolve a full ULID or a ≥8-char prefix (via the peek inbox) to a full thread id. */
export async function resolveThreadId(client: BrokerClient, arg: string): Promise<string> {
  if (ULID_REGEX.test(arg)) return arg;
  if (arg.length < 8)
    throw new LocalError('thread id must be a full ULID or a prefix of at least 8 characters');
  const peek = await client.inbox({ mode: 'peek' });
  if (!peek.ok) throw new LocalError('cannot resolve thread prefix — broker unreachable');
  const candidates = [...new Set(peek.items.map((i) => i.message.thread_id))].filter((t) =>
    t.startsWith(arg),
  );
  if (candidates.length === 0) throw new LocalError(`no pending thread matches prefix ${arg}`);
  if (candidates.length > 1)
    throw new LocalError(`ambiguous prefix ${arg} — candidates: ${candidates.join(', ')}`);
  return candidates[0];
}

export async function runAccept(
  argv: string[],
  ctx: CliContext,
  flags: GlobalFlags,
): Promise<number> {
  const arg = argv.find((a) => !a.startsWith('--'));
  if (!arg) throw new LocalError('usage: tenfour accept <thread-id>');
  if (!ctx.credentials) throw new LocalError('no credentials.json — run tenfour join first');
  const client = requireClient(ctx);
  const threadId = await resolveThreadId(client, arg);
  const short = shortThreadId(threadId);

  const tr = await client.thread({ thread_id: threadId });
  if (!tr.ok) {
    printBrokerError(tr.error);
    return EXIT.BROKER_REJECTED;
  }
  const t = tr.thread;
  if (t.recipient !== ctx.credentials.agent) {
    throw new LocalError(
      `you are not the recipient of thread ${short}; only the receiver accepts (tenfour_thread to inspect).`,
    );
  }
  if (t.consent.state === 'granted') {
    out(fmt(CONSENT_ALREADY_ACTIVE_NOTE, { thread_short: short }));
    return EXIT.OK;
  }
  const frozen = t.status === 'frozen';
  const acceptable = t.status === 'offered' || (frozen && t.resume_state === 'offered');
  if (!acceptable) {
    if (t.status === 'closed')
      throw new LocalError(`thread ${short} is terminal (${t.closed_reason}) — nothing to accept.`);
    if (frozen)
      throw new LocalError(
        `thread ${short} is frozen with resume_state ${t.resume_state} — use tenfour approve ${short} to resume.`,
      );
    throw new LocalError(`thread ${short} is ${t.status}, not offered — nothing to accept.`);
  }

  // Resolve the current consent token: the newest message carrying one (root task or re-offer).
  const token = [...tr.messages].reverse().find((m) => m.consent_token !== null)?.consent_token;
  if (!token)
    throw new LocalError(
      `thread ${short} has no active consent token — re-fetch and try again, or tell your human.`,
    );

  // Print what is being consented to BEFORE the network call (CONSENT §3.1).
  const root = tr.messages.find((m) => m.kind === 'task') ?? tr.messages[0];
  out(
    `accepting thread ${short} — task from ${t.initiator}, repo ${t.repo}, round ${t.round}/${t.max_rounds}`,
  );
  if (root) out(`  “${root.body.split('\n')[0].slice(0, 120)}”`);

  const resp = await sendAccept(client, {
    to: t.initiator,
    thread_id: threadId,
    parent_id: t.head_id,
    token,
    unfreeze: frozen,
  });
  if (!resp.ok) {
    printBrokerError(resp.error);
    return EXIT.BROKER_REJECTED;
  }
  out(
    `accepted — thread ${short} is now ${resp.thread.status} (round ${resp.thread.round}/${resp.thread.max_rounds}).`,
  );
  return EXIT.OK;
}

/** Send kind:accepted; on a single STALE_HEAD, refetch the head and retry once (§1.4). */
async function sendAccept(
  client: BrokerClient,
  p: { to: string; thread_id: string; parent_id: string; token: string; unfreeze: boolean },
): ReturnType<BrokerClient['send']> {
  const first = await client.send({
    client_id: ulid(),
    to: p.to,
    kind: 'accepted',
    thread_id: p.thread_id,
    parent_id: p.parent_id,
    body: '',
    consent: { token: p.token, granted_via: 'cli_accept' },
    ...(p.unfreeze ? { unfreeze: true } : {}),
  });
  if (first.ok || first.error.code !== 'TENFOUR/STALE_HEAD') return first;
  const tr = await client.thread({ thread_id: p.thread_id });
  if (!tr.ok) return first;
  return client.send({
    client_id: ulid(),
    to: p.to,
    kind: 'accepted',
    thread_id: p.thread_id,
    parent_id: tr.thread.head_id,
    body: '',
    consent: { token: p.token, granted_via: 'cli_accept' },
    ...(p.unfreeze ? { unfreeze: true } : {}),
  });
}
