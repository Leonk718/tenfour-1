/**
 * tenfour — secret-file writing and permission verification (CLI-MCP §0 CLI-003,
 * WIN-002; AUTH CRED-3). `credentials.json`/`admin.json`/`config.json` are written
 * atomically (temp + fsync + rename) and immediately tightened to sole-user access:
 * POSIX `chmod 0600`; Windows `icacls /inheritance:r` then `/grant:r <user>:F`.
 *
 * `tenfour doctor` check 2 (`credentials-perms`) is the verifier — see `checkPerms`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Write bytes to `file` atomically, then tighten permissions to sole-user (0600/icacls). */
export function writeSecureFile(file: string, contents: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  tightenPerms(file, platform);
}

/** Apply the sole-user permission doctrine to an existing file (idempotent, best-effort). */
export function tightenPerms(file: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    // WIN-002: strip inheritance, grant sole current user Full. Best-effort (documented).
    spawnSync('icacls', [file, '/inheritance:r'], { stdio: 'ignore' });
    const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
    spawnSync('icacls', [file, '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } else {
    fs.chmodSync(file, 0o600);
  }
}

export interface PermResult {
  ok: boolean;
  detail: string;
}

/**
 * Doctor check 2 logic. POSIX: mode must be exactly 0600 (no group/world bits).
 * Windows: parse `icacls` output — FAIL on any grant to Everyone, BUILTIN\Users, or
 * NT AUTHORITY\Authenticated Users.
 */
export function checkPerms(file: string, platform: NodeJS.Platform = process.platform): PermResult {
  if (!fs.existsSync(file)) return { ok: false, detail: `missing: ${file}` };
  if (platform === 'win32') {
    const out = spawnSync('icacls', [file], { encoding: 'utf8' });
    const text = `${out.stdout ?? ''}`;
    const broad = [/\bEveryone\b/i, /BUILTIN\\Users/i, /NT AUTHORITY\\Authenticated Users/i];
    for (const re of broad) {
      if (re.test(text)) return { ok: false, detail: `broad grant matched ${re.source}` };
    }
    return { ok: true, detail: 'sole-user access (icacls)' };
  }
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { ok: false, detail: `mode ${mode.toString(8)} is group/world accessible; expected 600` };
  }
  return { ok: true, detail: `mode ${mode.toString(8)}` };
}
