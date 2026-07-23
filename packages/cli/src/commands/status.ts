/**
 * tenfour CLI — `tenfour status [--json] [--clear-ops]` (CLI-MCP §1.8). Human dashboard:
 * threads visible via the inbox, their state/round/last-activity, the local delivery
 * journal, and stuck/abandoned outbound ops (R11). Read-only EXCEPT --clear-ops, which
 * acknowledges surfaced abandoned/resolved outbound-op records so they stop appearing.
 */

import { Journal } from '../../../adapter/src/journal.ts';
import { requireClient, type CliContext } from '../context.ts';
import { ageString } from '../../../adapter/src/hooks/common.ts';
import { shortThreadId } from '../../../adapter/src/strings.ts';
import { out, json, printBrokerError, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

export async function runStatus(
  argv: string[],
  ctx: CliContext,
  flags: GlobalFlags,
): Promise<number> {
  const clearOps = argv.includes('--clear-ops');
  const client = requireClient(ctx);
  const journal = new Journal(ctx.paths.journalDir);

  const peek = await client.inbox({ mode: 'peek' });
  if (!peek.ok) {
    printBrokerError(peek.error);
    return EXIT.BROKER_REJECTED;
  }

  const threadIds = [...new Set(peek.items.map((i) => i.message.thread_id))];
  const rows: Array<Record<string, unknown>> = [];
  for (const tid of threadIds) {
    const tr = await client.thread({ thread_id: tid });
    if (!tr.ok) continue;
    const t = tr.thread;
    const last = tr.messages[tr.messages.length - 1];
    rows.push({
      thread: shortThreadId(tid),
      peer: t.initiator === ctx.credentials?.agent ? t.recipient : t.initiator,
      state: t.status,
      round: `${t.round}/${t.max_rounds}`,
      last_kind: last?.kind ?? '-',
      last_activity: last ? ageString(last.ts) : '-',
    });
  }

  const outbound = [...journal.outboundStates().values()];
  const stuck = outbound.filter((o) => o.state === 'prepared' || o.state === 'sending');
  const abandoned = outbound.filter((o) => o.state === 'abandoned');

  if (clearOps) {
    for (const o of [...stuck, ...abandoned])
      journal.appendOutbound({ at: Date.now(), client_id: o.client_id, state: 'abandoned' });
  }

  if (flags.json) {
    json({ threads: rows, outbound: { stuck, abandoned } });
    return EXIT.OK;
  }

  if (rows.length === 0) out('no pending threads.');
  for (const r of rows) {
    out(
      `${r.thread}  ${r.peer}  ${r.state}  round ${r.round}  last:${r.last_kind} (${r.last_activity})`,
    );
  }
  for (const o of stuck)
    out(`outbound ${o.client_id.slice(0, 8)} stuck in ${o.state} — never confirmed.`);
  for (const o of abandoned)
    out(
      `outbound ${o.client_id.slice(0, 8)} abandoned (never transmitted). ${clearOps ? 'cleared.' : 'Re-send if still wanted; tenfour status --clear-ops to dismiss.'}`,
    );
  return EXIT.OK;
}
