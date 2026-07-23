/**
 * tenfour CLI — `tenfour join [--code <code>]` (CLI-MCP §1.3). Joiner redeems an invite
 * and completes local install in one command. Decode + checksum-verify LOCALLY before any
 * network call (AUTH INV-3); confirm "joining as X to Y" before redeeming; write creds +
 * config; emit the celebration ping (mark:"hello") and the covenant line verbatim.
 */

import { BrokerClient } from '../../../adapter/src/client.ts';
import { decodeInviteCode } from '../../../adapter/src/invite-code.ts';
import { saveConfig, saveCredentials } from '../../../adapter/src/local-config.ts';
import { TenfourConfigSchema } from '../../../schema/src/config.ts';
import { COVENANT_LINE } from '../../../adapter/src/strings.ts';
import { AbortError, LocalError, clientInfo, loadCliContext, type CliContext } from '../context.ts';
import { baseInstall } from './init.ts';
import { confirm, readLine } from '../prompt.ts';
import { out, err, printBrokerError, printCodeError, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

export async function runJoin(argv: string[], ctx: CliContext, flags: GlobalFlags): Promise<number> {
  const yes = argv.includes('--yes') || flags.json;

  // Step 1 — imply base init if not installed.
  if (!ctx.config) baseInstall(flags);

  // Step 2 — obtain + locally verify the code (before any network call).
  const codeIdx = argv.indexOf('--code');
  let code: string;
  if (codeIdx >= 0) {
    code = argv[codeIdx + 1] ?? '';
    err('warning: passing --code puts the invite in your shell history; prefer the interactive prompt.');
  } else {
    code = await readLine('Paste your tenfour invite code: ');
  }
  const decoded = await decodeInviteCode(code);
  if (!decoded.ok) {
    printCodeError('INVITE_INVALID', { detail: decoded.reason });
    return EXIT.BROKER_REJECTED;
  }
  const { agent, broker_url } = decoded.payload;
  const host = new URL(broker_url).host;

  // Step 3 — confirmation (paste-mangling defense). Decline → exit 3, nothing sent.
  const okToJoin = await confirm(`joining as ${agent} to ${host} — correct?`, true, { yes });
  if (!okToJoin) {
    err('aborted — nothing was sent.');
    throw new AbortError('join declined at confirmation');
  }

  // Step 4 — redeem.
  const client = new BrokerClient({ url: broker_url });
  const resp = await client.redeem({ code, client_info: clientInfo() });
  if (!resp.ok) {
    printBrokerError(resp.error);
    return EXIT.BROKER_REJECTED;
  }

  // Step 5 — write credentials + config.
  saveCredentials({ agent: resp.agent, token: resp.token, token_id: resp.token_id, peer: resp.pair.peer }, flags.home);
  const config = TenfourConfigSchema.parse({
    broker_url,
    agent: resp.agent,
    peer: resp.pair.peer,
    workspaces: [],
    allowed_repos: [],
    standing_rules: { auto_answer_questions: false, auto_accept_from: [] },
  });
  saveConfig(config, flags.home);

  // Step 6 — celebration round trip (diag.ping mark:"hello") + covenant line verbatim.
  const authed = new BrokerClient({ url: broker_url, token: resp.token });
  try {
    await authed.ping({ mark: 'hello' });
  } catch {
    /* celebration ping is best-effort */
  }
  out('');
  out(`paired: ${resp.agent} ↔ ${resp.pair.peer} (round budget ${resp.pair.max_rounds}).`);
  out(resp.covenant || COVENANT_LINE);
  out('');
  out('Next: your peer sends you a task; it will surface in your Claude sessions. Grant it with: tenfour accept <thread>.');

  // Step 7 — hygiene reminders.
  err('reminder: delete the message that carried this code. On Windows also clear clipboard history (Win+V).');
  return EXIT.OK;
}
