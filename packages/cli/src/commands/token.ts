/**
 * tenfour CLI — `tenfour token rotate | tenfour token revoke [--agent <name>]`
 * (CLI-MCP §1.6; AUTH §9–§10). Credential lifecycle. `revoke` (self) truncates
 * credentials.json to {} locally and prints the recovery path. Rotation and peer
 * revocation are broker CONTROL-PLANE operations (AUTH §9/§10) — endpoints that live on
 * the broker, not in the 7-method data-plane; against a data-plane-only broker they
 * report that plainly rather than corrupting local credentials.
 */

import * as fs from 'node:fs';
import { writeSecureFile } from '../../../adapter/src/secure-file.ts';
import { LocalError, type CliContext } from '../context.ts';
import { out, err, type GlobalFlags } from '../output.ts';
import { EXIT } from '../exit-codes.ts';

export async function runToken(
  argv: string[],
  ctx: CliContext,
  flags: GlobalFlags,
): Promise<number> {
  const sub = argv.find((a) => !a.startsWith('--'));
  if (sub === 'revoke') return runRevoke(argv, ctx, flags);
  if (sub === 'rotate') return runRotate(ctx);
  throw new LocalError('usage: tenfour token rotate | tenfour token revoke [--agent <name>]');
}

function runRevoke(argv: string[], ctx: CliContext, flags: GlobalFlags): number {
  const agentIdx = argv.indexOf('--agent');
  const peer = agentIdx >= 0 ? argv[agentIdx + 1] : undefined;

  if (peer) {
    // Peer revocation requires the admin key + the broker control-plane admin.revokeAgent.
    if (!ctx.admin) throw new LocalError('revoking a peer requires admin.json (owner machine).');
    throw new LocalError(
      `peer revocation (admin.revokeAgent) is a broker control-plane operation not exposed by this broker's 7-method interface. ` +
        `Recover pairing with a fresh tenfour invite + tenfour join.`,
    );
  }

  // Self-revoke: invalidate the local token by truncating credentials.json to {}.
  if (!ctx.credentials) {
    out('already revoked; nothing to do.');
    return EXIT.OK;
  }
  writeSecureFile(ctx.paths.credentialsJson, JSON.stringify({}) + '\n');
  out('local credentials revoked (credentials.json truncated).');
  out('Recover with a fresh invite: the owner runs tenfour invite; you run tenfour join.');
  void fs;
  void flags;
  return EXIT.OK;
}

function runRotate(_ctx: CliContext): number {
  // Rotation is a broker control-plane method (token.rotate, AUTH §9) — mint-new-token +
  // overlap window happen broker-side. It is not part of the deployed 7-method interface.
  err(
    'token rotation (token.rotate) is a broker control-plane operation not exposed by this broker build. ' +
      'To replace this machine’s credential, revoke it (tenfour token revoke) and re-pair with a fresh tenfour invite + tenfour join.',
  );
  return EXIT.LOCAL_ERROR;
}
