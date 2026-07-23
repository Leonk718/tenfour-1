/**
 * tenfour CLI — argument parsing, global flags, command dispatch, and uniform exit-code
 * mapping (CLI-MCP §0/§1). Nine commands: init, invite, join, accept, approve, token,
 * doctor, status, inbox. Global flags on every command: --json, --quiet, --home <dir>.
 */

import { loadCliContext, LocalError, AbortError } from './context.ts';
import { setGlobalFlags, err, type GlobalFlags } from './output.ts';
import { EXIT } from './exit-codes.ts';
import { runInit } from './commands/init.ts';
import { runInvite } from './commands/invite.ts';
import { runJoin } from './commands/join.ts';
import { runAccept } from './commands/accept.ts';
import { runApprove } from './commands/approve.ts';
import { runToken } from './commands/token.ts';
import { runDoctor } from './commands/doctor.ts';
import { runStatus } from './commands/status.ts';
import { runInbox } from './commands/inbox.ts';
import type { CliContext } from './context.ts';

const COMMANDS = [
  'init',
  'invite',
  'join',
  'accept',
  'approve',
  'token',
  'doctor',
  'status',
  'inbox',
] as const;
export type Command = (typeof COMMANDS)[number];

type Handler = (argv: string[], ctx: CliContext, flags: GlobalFlags) => Promise<number>;
const HANDLERS: Record<Command, Handler> = {
  init: runInit,
  invite: runInvite,
  join: runJoin,
  accept: runAccept,
  approve: runApprove,
  token: runToken,
  doctor: runDoctor,
  status: runStatus,
  inbox: runInbox,
};

/** Extract the global flags and strip them from argv, returning the remaining args. */
export function parseGlobalFlags(argv: string[]): { flags: GlobalFlags; rest: string[] } {
  const rest: string[] = [];
  const flags: GlobalFlags = { json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--home') {
      flags.home = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const USAGE = `tenfour — 10-4 between your Claudes.
Usage: tenfour <command> [args] [--json] [--quiet] [--home <dir>]
Commands: ${COMMANDS.join(', ')}`;

export async function main(rawArgs: string[]): Promise<number> {
  const { flags, rest } = parseGlobalFlags(rawArgs);
  setGlobalFlags(flags);
  const command = rest[0] as Command | undefined;
  if (!command || command === undefined) {
    err(USAGE);
    return EXIT.USAGE;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    err(`unknown command: ${command}\n${USAGE}`);
    return EXIT.USAGE;
  }
  const ctx = loadCliContext(flags.home);
  try {
    return await HANDLERS[command](rest.slice(1), ctx, flags);
  } catch (e) {
    if (e instanceof AbortError) return EXIT.USER_ABORTED;
    if (e instanceof LocalError) {
      err(`tenfour ${command}: ${e.message}`);
      return EXIT.LOCAL_ERROR;
    }
    err(`tenfour ${command}: ${(e as Error).message}`);
    return EXIT.LOCAL_ERROR;
  }
}
