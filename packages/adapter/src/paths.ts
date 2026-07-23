/**
 * tenfour — TENFOUR_HOME resolution and the canonical file layout (CLI-MCP §0).
 *
 * `TENFOUR_HOME` defaults to `~/.tenfour` (POSIX) / `%USERPROFILE%\.tenfour` (Windows);
 * every command and hook honors the `TENFOUR_HOME` env override and the `--home <dir>`
 * global flag (which callers pass through `override`). Path handling uses Node `path`,
 * which selects win32/posix semantics from the platform (WIN-001).
 */

import * as os from 'node:os';
import * as path from 'node:path';

export interface TenfourPaths {
  home: string;
  configJson: string;
  credentialsJson: string;
  adminJson: string;
  binDir: string;
  hookEntry: string;
  mcpEntry: string;
  journalDir: string;
  brokerSrcDir: string;
  standbyMd: string;
}

/** Resolve TENFOUR_HOME: explicit override → `$TENFOUR_HOME` → `<homedir>/.tenfour`. */
export function resolveHome(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override && override.length > 0) return path.resolve(override);
  const fromEnv = env.TENFOUR_HOME;
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.tenfour');
}

/** Build the full canonical path set under a resolved TENFOUR_HOME. */
export function tenfourPaths(override?: string, env: NodeJS.ProcessEnv = process.env): TenfourPaths {
  const home = resolveHome(override, env);
  const binDir = path.join(home, 'bin');
  const journalDir = path.join(home, 'journal');
  return {
    home,
    configJson: path.join(home, 'config.json'),
    credentialsJson: path.join(home, 'credentials.json'),
    adminJson: path.join(home, 'admin.json'),
    binDir,
    hookEntry: path.join(binDir, 'tenfour-hook.mjs'),
    mcpEntry: path.join(binDir, 'tenfour-mcp.mjs'),
    journalDir,
    brokerSrcDir: path.join(home, 'broker-src'),
    standbyMd: path.join(home, 'standby.md'),
  };
}

/** The `~/.claude/settings.json` path (user scope), honoring `--home`-independent HOME. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const claudeHome = env.CLAUDE_CONFIG_DIR;
  if (claudeHome && claudeHome.length > 0) return path.join(path.resolve(claudeHome), 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}
