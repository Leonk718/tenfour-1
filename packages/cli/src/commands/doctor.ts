/**
 * tenfour CLI — `tenfour doctor [--fix] [--strict] [--json]` (CLI-MCP §4). The 14 named
 * checks, execute-not-inspect (JOURNEYS §3). The ONLY broker method doctor calls is
 * diag.ping (R6); hook execution runs against an ISOLATED temp journal (HK-006). Checks
 * 5–7 share a single ping (DOC-120). Exit codes: 0 all PASS, 4 warnings, 1 ≥1 FAIL, 2
 * doctor could not run (DOC-121).
 *
 * The check functions are pure over injected inputs so unit tests drive pass/fail logic
 * with a mocked broker (no network).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, loadCredentials } from '../../../adapter/src/local-config.ts';
import { checkPerms } from '../../../adapter/src/secure-file.ts';
import { Journal } from '../../../adapter/src/journal.ts';
import { notify } from '../../../adapter/src/notify.ts';
import { tenfourPaths } from '../../../adapter/src/paths.ts';
import { claudeSettingsPath } from '../../../adapter/src/paths.ts';
import { BrokerClient } from '../../../adapter/src/client.ts';
import { TOOL_NAMES, handleSend, type ToolDeps } from '../../../adapter/src/mcp/tools.ts';
import { HOOK_SENTINEL } from '../settings.ts';
import type { DiagPingResponse } from '../../../schema/src/protocol.ts';
import { type CliContext } from '../context.ts';
import { out, json, type GlobalFlags } from '../output.ts';
import { DOCTOR_EXIT } from '../exit-codes.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN';
export interface CheckResult {
  check_id: string;
  status: CheckStatus;
  detail: string;
  fix_applied?: boolean;
}
const R = (
  check_id: string,
  status: CheckStatus,
  detail: string,
  fix_applied?: boolean,
): CheckResult => ({
  check_id,
  status,
  detail,
  ...(fix_applied !== undefined ? { fix_applied } : {}),
});

const MIN_NODE_MAJOR = 20;

// ── Individual checks (pure where possible) ───────────────────────────────────

export function checkConfigParse(home?: string, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const cfg = loadConfig(home, env);
  const creds = loadCredentials(home, env);
  if (!cfg.ok) return R('config-parse', 'FAIL', `config.json: ${cfg.detail}`);
  if (!creds.ok) return R('config-parse', 'FAIL', `credentials.json: ${creds.detail}`);
  return R('config-parse', 'PASS', `config + credentials valid (agent ${creds.value.agent})`);
}

export function checkCredentialsPerms(
  paths: { credentialsJson: string; configJson: string; adminJson: string },
  platform: NodeJS.Platform = process.platform,
  fix = false,
): CheckResult {
  const targets = [paths.credentialsJson, paths.configJson];
  if (fs.existsSync(paths.adminJson)) targets.push(paths.adminJson);
  const present = targets.filter((f) => fs.existsSync(f));
  if (present.length === 0) return R('credentials-perms', 'FAIL', 'no credential files present');
  const bad: string[] = [];
  for (const f of present) {
    let res = checkPerms(f, platform);
    if (!res.ok && fix) {
      try {
        if (platform !== 'win32') fs.chmodSync(f, 0o600);
        res = checkPerms(f, platform);
      } catch {
        /* fix best-effort */
      }
    }
    if (!res.ok) bad.push(`${path.basename(f)}: ${res.detail}`);
  }
  return bad.length === 0
    ? R('credentials-perms', 'PASS', 'sole-user access', fix || undefined)
    : R('credentials-perms', 'FAIL', bad.join('; '), fix ? true : undefined);
}

export function checkNodeRuntime(): CheckResult {
  const res = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (res.status !== 0) return R('node-runtime', 'FAIL', 'node not resolvable on PATH');
  const m = /v(\d+)\./.exec((res.stdout ?? '').trim());
  const major = m ? Number(m[1]) : 0;
  return major >= MIN_NODE_MAJOR
    ? R('node-runtime', 'PASS', `node ${res.stdout.trim()}`)
    : R('node-runtime', 'FAIL', `node ${res.stdout.trim()} < v${MIN_NODE_MAJOR}`);
}

export function checkEnvironmentPath(
  paths: { home: string },
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const claude = spawnSync(finder, ['claude'], { encoding: 'utf8' });
  const npm = spawnSync(finder, ['npm'], { encoding: 'utf8' });
  const claudeOk = claude.status === 0;
  const npmOk = npm.status === 0;
  const warnings: string[] = [];
  if (paths.home.includes('/mnt/'))
    warnings.push('TENFOUR_HOME on a drvfs mount (WSL) — journal fsync semantics differ');
  if (/OneDrive/i.test(claudeSettingsPath(env)))
    warnings.push('~/.claude appears OneDrive-synced — journal/settings churn risk');
  if (!claudeOk && !npmOk)
    return R('environment-path', 'WARN', 'neither claude nor npm found on PATH');
  if (claudeOk !== npmOk)
    return R(
      'environment-path',
      'FAIL',
      `split resolution: claude=${claudeOk} npm=${npmOk} (WSL interop trap)`,
    );
  if (warnings.length) return R('environment-path', 'WARN', warnings.join('; '));
  return R('environment-path', 'PASS', 'claude + npm resolve on the same side');
}

export interface PingProbe {
  ok: boolean;
  response?: DiagPingResponse;
  rtt_ms: number;
  local_ts: number;
  error?: string;
}

export function checkBrokerReach(probe: PingProbe): CheckResult {
  if (!probe.ok)
    return R('broker-reach', 'FAIL', `broker unreachable: ${probe.error ?? 'no response'}`);
  return R('broker-reach', 'PASS', `diag.ping ok (rtt ${probe.rtt_ms}ms)`);
}

export function checkAuthValid(probe: PingProbe, expectedAgent: string | undefined): CheckResult {
  if (!probe.ok || !probe.response || !probe.response.ok) {
    const code = probe.response && !probe.response.ok ? probe.response.error.code : 'unreachable';
    return R('auth-valid', 'FAIL', `authentication failed (${code}) — re-pair with tenfour join`);
  }
  const agent = probe.response.agent;
  if (expectedAgent && agent !== expectedAgent)
    return R('auth-valid', 'FAIL', `broker sees agent ${agent}, config says ${expectedAgent}`);
  return R('auth-valid', 'PASS', `authenticated as ${agent}`);
}

export function checkClockSkew(probe: PingProbe): CheckResult {
  if (!probe.ok || !probe.response || !probe.response.ok)
    return R('clock-skew', 'WARN', 'skipped — broker unreachable');
  const localMid = probe.local_ts + probe.rtt_ms / 2;
  const skew = Math.abs(probe.response.server_time - localMid);
  if (skew <= 30_000) return R('clock-skew', 'PASS', `skew ${Math.round(skew)}ms`);
  if (skew <= 300_000)
    return R('clock-skew', 'WARN', `skew ${Math.round(skew / 1000)}s (display timestamps only)`);
  return R('clock-skew', 'FAIL', `skew ${Math.round(skew / 1000)}s > 300s`);
}

export function checkHooksExecute(
  hookEntryAbs: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  const settingsFile = claudeSettingsPath(env);
  if (!fs.existsSync(settingsFile))
    return R(
      'hooks-execute',
      'FAIL',
      'not installed — no ~/.claude/settings.json (run tenfour init)',
    );
  let settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    return R('hooks-execute', 'FAIL', `settings.json unparseable: ${(e as Error).message}`);
  }
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];
  const eventArg: Record<string, string> = {
    SessionStart: 'session-start',
    UserPromptSubmit: 'user-prompt-submit',
    PostToolUse: 'post-tool-use',
    Stop: 'stop',
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenfour-doctor-'));
  try {
    for (const event of events) {
      const entries = settings.hooks?.[event] ?? [];
      const cmd = entries
        .flatMap((e) => e.hooks ?? [])
        .map((h) => h.command)
        .find((c) => typeof c === 'string' && c.includes(HOOK_SENTINEL));
      if (!cmd) return R('hooks-execute', 'FAIL', `${event}: tenfour sentinel entry not installed`);
      const res = spawnSync(cmd, {
        shell: true,
        encoding: 'utf8',
        env: { ...env, TENFOUR_DOCTOR: '1', TENFOUR_JOURNAL_DIR: path.join(tmp, event) },
      });
      if (res.status !== 0)
        return R(
          'hooks-execute',
          'FAIL',
          `${event}: spawn failed (${res.status}) ${(res.stderr ?? '').slice(0, 120)}`,
        );
      if (!/"tenfour_doctor"\s*:\s*"ok"/.test(res.stdout ?? ''))
        return R('hooks-execute', 'FAIL', `${event}: no {"tenfour_doctor":"ok"} on stdout`);
    }
    void hookEntryAbs;
    return R('hooks-execute', 'PASS', '4/4 hooks fire and report ok');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function checkGateRules(workspaces: readonly string[]): CheckResult {
  if (workspaces.length === 0) return R('gate-rules', 'PASS', 'no tagged workspaces');
  const missing = workspaces.filter((w) => {
    const f = path.join(w, '.claude', 'settings.json');
    if (!fs.existsSync(f)) return true;
    try {
      return (
        (JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>)._tenfour_gate_rules ===
        undefined
      );
    } catch {
      return true;
    }
  });
  return missing.length === 0
    ? R('gate-rules', 'PASS', `${workspaces.length} workspace(s) carry gate rules`)
    : R('gate-rules', 'FAIL', `missing gate rules: ${missing.join(', ')}`);
}

export function checkJournalIntegrity(journalDir: string): CheckResult {
  const j = new Journal(journalDir);
  try {
    j.ensure();
    const probe = path.join(journalDir, '.fsync-probe');
    const fd = fs.openSync(probe, 'w');
    fs.writeFileSync(fd, 'probe');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.unlinkSync(probe);
    j.readInbound(); // parse scan; torn lines are skipped, not fatal
    return R('journal-integrity', 'PASS', 'journal readable + fsync-able');
  } catch (e) {
    return R(
      'journal-integrity',
      'FAIL',
      `journal probe failed: ${(e as Error).message} (dashboard hand-edit or cloud-sync restore?)`,
    );
  }
}

export function checkRepoMap(workspaces: readonly string[]): CheckResult {
  if (workspaces.length === 0) return R('repo-map', 'PASS', 'no workspaces to map');
  const bad: string[] = [];
  for (const w of workspaces) {
    const gitDir = spawnSync('git', ['-C', w, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    if (gitDir.status !== 0) {
      bad.push(`${w}: not a git checkout`);
      continue;
    }
    const head = spawnSync('git', ['-C', w, 'cat-file', '-e', 'HEAD^{commit}'], {
      encoding: 'utf8',
    });
    if (head.status !== 0) bad.push(`${w}: no HEAD commit`);
    const origin = spawnSync('git', ['-C', w, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (origin.status !== 0) bad.push(`${w}: no origin remote (repo_id underivable)`);
  }
  return bad.length === 0
    ? R('repo-map', 'PASS', `${workspaces.length} workspace(s) usable`)
    : R('repo-map', 'FAIL', bad.join('; '));
}

export function checkNotifyToast(platform: NodeJS.Platform = process.platform): CheckResult {
  const res = notify('tenfour', 'test toast dispatched', platform);
  return res.dispatched
    ? R(
        'notify-toast',
        'PASS',
        'test toast dispatched (if you didn’t see it, check Focus Assist / notification settings)',
      )
    : R('notify-toast', 'FAIL', `toast dispatch errored: ${res.detail}`);
}

export async function checkConsentSurface(): Promise<CheckResult> {
  const expected = ['tenfour_send', 'tenfour_ack', 'tenfour_thread', 'tenfour_wait'];
  const served = [...TOOL_NAMES];
  const exact =
    served.length === expected.length &&
    expected.every((t) => served.includes(t as (typeof TOOL_NAMES)[number]));
  if (!exact)
    return R(
      'consent-surface',
      'FAIL',
      `served MCP tools are not exactly the four: ${served.join(', ')}`,
    );
  // Verify tenfour_send rejects kind:accepted locally (MCP-010) — no network needed.
  const stub: ToolDeps = {
    agent: 'x/y',
    client: { thread: async () => ({ ok: false }) } as unknown as ToolDeps['client'],
  };
  const res = await handleSend(stub, {
    to: 'a/b',
    kind: 'accepted',
    thread_id: '01J1PAVH5N40E3D8QT2W9YRKM3',
    body: '',
  });
  if (res.status !== 'error' || res.code !== 'TENFOUR/CONSENT_REQUIRED') {
    return R(
      'consent-surface',
      'FAIL',
      'tenfour_send did not reject kind:accepted (F-3 release blocker)',
    );
  }
  return R('consent-surface', 'PASS', 'exactly four tools; tenfour_send rejects kind:accepted');
}

export function checkWorkspaceTagged(
  allowedRepos: readonly string[],
  workspaces: readonly string[],
): CheckResult {
  // Derive each workspace's repo-id from its origin remote (ART-081).
  const tagged = new Set<string>();
  for (const w of workspaces) {
    const origin = spawnSync('git', ['-C', w, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (origin.status === 0) {
      const id = repoIdFromRemote(origin.stdout.trim());
      if (id) tagged.add(id);
    }
  }
  const untagged = allowedRepos.filter((r) => !tagged.has(r));
  if (untagged.length === 0)
    return R('workspace-tagged', 'PASS', 'all allowlisted repos are tagged workspaces');
  return R(
    'workspace-tagged',
    'WARN',
    `untagged target repo(s): ${untagged.join(', ')} — run tenfour init --workspace there`,
  );
}

/** Best-effort host/owner/name repo-id from a git remote URL (ARTIFACTS §2.1). */
export function repoIdFromRemote(url: string): string | null {
  let m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  return null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function summarizeExit(results: readonly CheckResult[]): number {
  if (results.some((r) => r.status === 'FAIL')) return DOCTOR_EXIT.FAILURES;
  if (results.some((r) => r.status === 'WARN')) return DOCTOR_EXIT.WARNINGS;
  return DOCTOR_EXIT.ALL_PASS;
}

export async function runDoctor(
  argv: string[],
  ctx: CliContext,
  flags: GlobalFlags,
): Promise<number> {
  const fix = argv.includes('--fix');
  const strict = argv.includes('--strict');
  const env = process.env;
  const paths = ctx.paths;

  const results: CheckResult[] = [];
  results.push(checkConfigParse(flags.home, env));
  results.push(checkCredentialsPerms(paths, process.platform, fix));
  results.push(checkNodeRuntime());
  results.push(checkEnvironmentPath(paths, env));

  // Checks 5–7 share a single diag.ping (DOC-120).
  const probe = await probePing(ctx);
  results.push(checkBrokerReach(probe));
  results.push(checkAuthValid(probe, ctx.config?.agent));
  results.push(checkClockSkew(probe));

  results.push(checkHooksExecute(paths.hookEntry, env));
  results.push(checkGateRules(ctx.config?.workspaces ?? []));
  results.push(checkJournalIntegrity(paths.journalDir));
  results.push(checkRepoMap(ctx.config?.workspaces ?? []));
  results.push(checkNotifyToast(process.platform));
  results.push(await checkConsentSurface());
  results.push(checkWorkspaceTagged(ctx.config?.allowed_repos ?? [], ctx.config?.workspaces ?? []));

  if (flags.json) {
    json(results);
  } else {
    for (const r of results) out(`[${r.status}] ${r.check_id}: ${r.detail}`);
  }
  let exit = summarizeExit(results);
  if (strict && exit === DOCTOR_EXIT.WARNINGS) exit = DOCTOR_EXIT.FAILURES;
  return exit;
}

async function probePing(ctx: CliContext): Promise<PingProbe> {
  if (!ctx.config || !ctx.credentials)
    return { ok: false, rtt_ms: 0, local_ts: Date.now(), error: 'no config/credentials' };
  const client = new BrokerClient({ url: ctx.config.broker_url, token: ctx.credentials.token });
  const t0 = Date.now();
  try {
    const response = await client.ping({ nonce: 'doctor' });
    const t1 = Date.now();
    return { ok: response.ok, response, rtt_ms: t1 - t0, local_ts: t0 };
  } catch (e) {
    return { ok: false, rtt_ms: Date.now() - t0, local_ts: t0, error: (e as Error).message };
  }
}
