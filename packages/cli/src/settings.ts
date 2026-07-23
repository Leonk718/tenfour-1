/**
 * tenfour CLI — `~/.claude/settings.json` hook merge (CLI-MCP §3.2/§3.3, HK-002/HK-003)
 * and per-project gate-rule merge (§3.5, HK-007). Sentinel-substring idempotency:
 * MUST merge, never clobber; MUST NOT duplicate; non-tenfour entries are never touched.
 *
 * Invalid existing JSON aborts (caller exits 2, file untouched — CLI §1.1 step 2); a
 * timestamped backup is written before any successful write.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GATE_RULE_PATTERNS } from '../../adapter/src/strings.ts';

/** The sentinel substring that marks a hook command string as tenfour-owned (HK-003). */
export const HOOK_SENTINEL = '--tenfour-hook-v1';
/** The top-level key marking a project settings.json as carrying tenfour gate rules (HK-007). */
export const GATE_RULES_KEY = '_tenfour_gate_rules';
export const GATE_RULES_VERSION = 'v1';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
export type SettingsHookEvent = (typeof HOOK_EVENTS)[number];

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks?: Partial<Record<SettingsHookEvent, HookEntry[]>>;
  permissions?: { ask?: string[]; allow?: string[]; deny?: string[] };
  [k: string]: unknown;
}

/** The four owned hook entries, built for an absolute hook-entry path (double-quoted, §3.1). */
export function tenfourHookEntries(hookEntryAbsPath: string): Record<SettingsHookEvent, HookEntry> {
  const cmd = (event: string): string => `node "${hookEntryAbsPath}" ${event} ${HOOK_SENTINEL}`;
  return {
    SessionStart: { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: cmd('session-start'), timeout: 15 }] },
    UserPromptSubmit: { hooks: [{ type: 'command', command: cmd('user-prompt-submit'), timeout: 5 }] },
    PostToolUse: { matcher: '*', hooks: [{ type: 'command', command: cmd('post-tool-use'), timeout: 5 }] },
    Stop: { hooks: [{ type: 'command', command: cmd('stop'), timeout: 10 }] },
  };
}

const entryIsTenfourOwned = (entry: HookEntry): boolean =>
  Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_SENTINEL));

export type ParseResult =
  | { ok: true; settings: Settings; existed: boolean }
  | { ok: false; reason: 'invalid_json'; detail: string };

export function parseSettings(file: string): ParseResult {
  if (!fs.existsSync(file)) return { ok: true, settings: {}, existed: false };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'invalid_json', detail: (e as Error).message };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_json', detail: 'settings.json is not a JSON object' };
  }
  return { ok: true, settings: raw as Settings, existed: true };
}

/**
 * Merge the four tenfour hooks into a settings object (pure). For each event: replace the
 * owned entry in place if present (upgrade), else append. Non-tenfour entries untouched.
 * Returns a NEW settings object (does not mutate the input).
 */
export function mergeHooks(settings: Settings, hookEntryAbsPath: string): Settings {
  const owned = tenfourHookEntries(hookEntryAbsPath);
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const event of HOOK_EVENTS) {
    const existing = [...(next.hooks![event] ?? [])];
    const idx = existing.findIndex(entryIsTenfourOwned);
    if (idx >= 0) existing[idx] = owned[event];
    else existing.push(owned[event]);
    next.hooks![event] = existing;
  }
  return next;
}

/** Merge the per-project gate rules as `ask` patterns (pure), idempotent via GATE_RULES_KEY. */
export function mergeGateRules(settings: Settings): Settings {
  const next: Settings = { ...settings };
  const perms = { ...(next.permissions ?? {}) };
  const ask = new Set<string>(perms.ask ?? []);
  for (const p of GATE_RULE_PATTERNS) ask.add(p);
  perms.ask = [...ask];
  next.permissions = perms;
  next[GATE_RULES_KEY] = GATE_RULES_VERSION;
  return next;
}

/** ISO-8601 basic timestamp for backup filenames (e.g. 20260723T014455Z). */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** Write a timestamped backup of an existing settings file (no-op if it does not exist). */
export function backupSettings(file: string, now: Date = new Date()): string | null {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.tenfour-backup-${backupStamp(now)}`;
  fs.copyFileSync(file, backup);
  return backup;
}

export function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
