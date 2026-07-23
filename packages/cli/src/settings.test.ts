// @vitest-environment node
/**
 * settings.json sentinel merge (HK-002/HK-003): merges the four hooks, NEVER clobbers
 * existing non-tenfour hooks, is idempotent (byte-identical after the first merge), and
 * replaces an owned entry in place (upgrade). Plus gate-rule merge (HK-007).
 */
import { describe, it, expect } from 'vitest';
import {
  mergeHooks,
  mergeGateRules,
  parseSettings,
  tenfourHookEntries,
  HOOK_SENTINEL,
  HOOK_EVENTS,
  GATE_RULES_KEY,
} from './settings.ts';
import { GATE_RULE_PATTERNS } from '../../adapter/src/strings.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = '/abs/.tenfour/bin/tenfour-hook.mjs';

describe('mergeHooks', () => {
  it('installs all four hook events with the sentinel', () => {
    const merged = mergeHooks({}, HOOK);
    for (const e of HOOK_EVENTS) {
      const cmds = (merged.hooks![e] ?? []).flatMap((x) => x.hooks).map((h) => h.command);
      expect(cmds.some((c) => c.includes(HOOK_SENTINEL))).toBe(true);
    }
  });

  it('never clobbers a pre-existing non-tenfour hook', () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'node /my/own/hook.js' }] }] } };
    const merged = mergeHooks(existing, HOOK);
    const stopCmds = merged.hooks!.Stop!.flatMap((x) => x.hooks).map((h) => h.command);
    expect(stopCmds).toContain('node /my/own/hook.js'); // preserved
    expect(stopCmds.some((c) => c.includes(HOOK_SENTINEL))).toBe(true); // ours added alongside
  });

  it('is idempotent — a second merge is byte-identical (HK-003)', () => {
    const once = mergeHooks({}, HOOK);
    const twice = mergeHooks(once, HOOK);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('replaces the owned entry in place on upgrade (no duplicate)', () => {
    const stale = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command' as const, command: `node "/old/hook.mjs" session-start ${HOOK_SENTINEL}` }] }] } };
    const merged = mergeHooks(stale, HOOK);
    const owned = merged.hooks!.SessionStart!.filter((x) => x.hooks.some((h) => h.command.includes(HOOK_SENTINEL)));
    expect(owned).toHaveLength(1); // replaced, not duplicated
    expect(owned[0].hooks[0].command).toContain(HOOK); // upgraded to the new path
  });

  it('does not mutate the input object', () => {
    const input = { hooks: {} };
    mergeHooks(input, HOOK);
    expect(input.hooks).toEqual({});
  });
});

describe('tenfourHookEntries', () => {
  it('double-quotes the absolute path and carries the sentinel + timeouts', () => {
    const e = tenfourHookEntries('/Users/Jonathan Smith/.tenfour/bin/tenfour-hook.mjs');
    expect(e.SessionStart.hooks[0].command).toBe('node "/Users/Jonathan Smith/.tenfour/bin/tenfour-hook.mjs" session-start --tenfour-hook-v1');
    expect(e.SessionStart.hooks[0].timeout).toBe(15);
    expect(e.SessionStart.matcher).toBe('startup|resume|clear|compact');
  });
});

describe('parseSettings', () => {
  it('flags invalid JSON (so init can abort untouched, exit 2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-set-'));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ nope');
    const res = parseSettings(file);
    expect(res.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('treats a missing file as an empty object', () => {
    const res = parseSettings(path.join(os.tmpdir(), 'tf-does-not-exist-xyz.json'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.existed).toBe(false);
  });
});

describe('mergeGateRules', () => {
  it('adds the ask patterns and the ownership sentinel key', () => {
    const merged = mergeGateRules({});
    expect(merged[GATE_RULES_KEY]).toBe('v1');
    for (const p of GATE_RULE_PATTERNS) expect(merged.permissions!.ask).toContain(p);
  });
  it('is idempotent', () => {
    const once = mergeGateRules({});
    const twice = mergeGateRules(once);
    expect(twice.permissions!.ask!.length).toBe(once.permissions!.ask!.length);
  });
});
