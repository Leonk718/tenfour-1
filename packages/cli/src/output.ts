/**
 * tenfour CLI — output helpers. Broker rejections print to stderr as the canonical
 * grammar `TENFOUR/<CODE>: <what happened>. <what is true now>. <one next action>`
 * (CLI-MCP §0). All model/human-facing protocol copy is sourced from strings.ts.
 */

import type { ErrorObject } from '../../schema/src/protocol.ts';
import { renderError, type TenfourErrorCode } from '../../adapter/src/strings.ts';

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  home?: string;
}

let flags: GlobalFlags = { json: false, quiet: false };
export function setGlobalFlags(f: GlobalFlags): void {
  flags = f;
}
export function getGlobalFlags(): GlobalFlags {
  return flags;
}

export function out(line: string): void {
  if (!flags.quiet) process.stdout.write(line + '\n');
}

export function err(line: string): void {
  process.stderr.write(line + '\n');
}

export function json(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Print a broker ErrorObject in the canonical one-line grammar (to stderr). */
export function printBrokerError(error: ErrorObject): void {
  if (flags.json) {
    json({ ok: false, error });
    return;
  }
  err(`${error.code}: ${error.message} ${error.human_action}`);
}

/** Print a canonical error by code (adapter-side, e.g. local invite checksum failure). */
export function printCodeError(
  code: TenfourErrorCode,
  vars: Record<string, string | number> = {},
): void {
  if (flags.json) {
    json({ ok: false, code: `TENFOUR/${code}` });
    return;
  }
  err(renderError(code, vars));
}
