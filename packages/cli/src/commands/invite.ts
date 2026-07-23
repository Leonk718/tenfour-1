/**
 * tenfour CLI — `tenfour invite <agent-name> [--ttl <hours>]` (CLI-MCP §1.2). Owner mints
 * a single-use pairing invite. Requires admin.json. The code is printed once and NEVER
 * persisted locally. Default ttl 24h → ttl_s 86400 (broker-clamped 300s–604800s).
 */

import { AgentNameSchema } from '../../../schema/src/protocol.ts';
import { BrokerClient } from '../../../adapter/src/client.ts';
import { LocalError, type CliContext } from '../context.ts';
import { out, printBrokerError, type GlobalFlags } from '../output.ts';
import { json } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

export async function runInvite(
  argv: string[],
  ctx: CliContext,
  flags: GlobalFlags,
): Promise<number> {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const agent = positionals[0];
  if (!agent || !AgentNameSchema.safeParse(agent).success) {
    throw new LocalError(
      'usage: tenfour invite <agent-name> [--ttl <hours>] (agent-name is user/agent, lowercase)',
    );
  }
  if (!ctx.admin) {
    throw new LocalError(
      'no admin.json on this machine — invites are minted on the owner machine (tenfour init --create-broker).',
    );
  }
  const ttlIdx = argv.indexOf('--ttl');
  let ttl_s: number | undefined;
  if (ttlIdx >= 0) {
    const hours = Number(argv[ttlIdx + 1]);
    if (!Number.isFinite(hours) || hours <= 0)
      throw new LocalError('--ttl must be a positive number of hours');
    ttl_s = Math.round(hours * 3600);
  }

  const client = new BrokerClient({ url: ctx.admin.broker_url });
  const resp = await client.issueInvite({
    admin_key: ctx.admin.admin_key,
    agent,
    ...(ttl_s !== undefined ? { ttl_s } : {}),
  });
  if (!resp.ok) {
    printBrokerError(resp.error);
    return EXIT.BROKER_REJECTED;
  }
  if (flags.json) {
    json(resp.invite);
    return EXIT.OK;
  }
  out(resp.invite.code);
  out('');
  out('Share this once via a password manager (primary) or iMessage (secondary).');
  out('On Windows, warn the joiner about clipboard history (Win+V). The joiner runs: tenfour join');
  return EXIT.OK;
}
