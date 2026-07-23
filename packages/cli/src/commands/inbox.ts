/**
 * tenfour CLI — `tenfour inbox [--thread <id>] [--all] [--json]` (CLI-MCP §1.9). Lists
 * queued/undelivered/blocked messages one line each. `--thread <id>` prints the full
 * wrapped body AND marks a journal re-surface attempt (the documented recovery step after
 * REPO_NOT_ALLOWED). `--all` includes acked history.
 */

import { Journal } from '../../../adapter/src/journal.ts';
import { requireClient, LocalError, type CliContext } from '../context.ts';
import { wrapItem, ageString, summarize, itemViewOf } from '../../../adapter/src/hooks/common.ts';
import { shortThreadId } from '../../../adapter/src/strings.ts';
import { resolveThreadId } from './accept.ts';
import { out, json, printBrokerError, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

export async function runInbox(argv: string[], ctx: CliContext, flags: GlobalFlags): Promise<number> {
  const threadIdx = argv.indexOf('--thread');
  const threadArg = threadIdx >= 0 ? argv[threadIdx + 1] : undefined;
  const all = argv.includes('--all');
  const client = requireClient(ctx);
  const journal = new Journal(ctx.paths.journalDir);

  // --thread: print the full wrapped body and record a journal re-surface attempt.
  if (threadArg) {
    const threadId = await resolveThreadId(client, threadArg);
    const tr = await client.thread({ thread_id: threadId });
    if (!tr.ok) {
      printBrokerError(tr.error);
      return EXIT.BROKER_REJECTED;
    }
    const last = tr.messages[tr.messages.length - 1];
    if (!last) throw new LocalError(`thread ${shortThreadId(threadId)} has no messages`);
    journal.ensure();
    journal.appendInbound({ at: Date.now(), message_id: last.id, attempt_id: 'resurface', state: 'received' });
    const view = { message: last, thread: { thread_id: tr.thread.thread_id, root_kind: tr.thread.root_kind, status: tr.thread.status, round: tr.thread.round, max_rounds: tr.thread.max_rounds, repo: tr.thread.repo } };
    if (flags.json) {
      json({ thread_id: threadId, message: last });
      return EXIT.OK;
    }
    out(wrapItem(view));
    return EXIT.OK;
  }

  const peek = await client.inbox({ mode: 'peek' });
  if (!peek.ok) {
    printBrokerError(peek.error);
    return EXIT.BROKER_REJECTED;
  }
  const items = peek.items.filter((i) => (all ? true : i.delivery_state !== 'acked'));
  if (flags.json) {
    json({ items: items.map(itemViewOf) });
    return EXIT.OK;
  }
  if (items.length === 0) {
    out('inbox empty.');
    return EXIT.OK;
  }
  for (const i of items) {
    out(`[${i.message.kind}] from ${i.message.from} | thread ${shortThreadId(i.message.thread_id)} | ${ageString(i.message.ts)} | ${i.thread.repo ?? '-'} : ${summarize(i.message.body, 60)}`);
  }
  return EXIT.OK;
}
