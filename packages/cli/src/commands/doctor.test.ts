// @vitest-environment node
/**
 * Doctor check pass/fail logic (CLI-MCP §4) — broker mocked via a PingProbe (NO network).
 * Covers config-parse, consent-surface (check 13, release-blocking), broker-reach,
 * auth-valid, clock-skew, credentials-perms, and the exit-code summary (DOC-121).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkConfigParse,
  checkConsentSurface,
  checkBrokerReach,
  checkAuthValid,
  checkClockSkew,
  checkCredentialsPerms,
  summarizeExit,
  repoIdFromRemote,
  type PingProbe,
  type CheckResult,
} from './doctor.ts';
import { DOCTOR_EXIT } from '../exit-codes.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-doc-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      broker_url: 'https://x.convex.cloud',
      agent: 'jonathan/web',
      peer: 'brian/design',
      workspaces: [],
      allowed_repos: [],
      standing_rules: { auto_answer_questions: false, auto_accept_from: [] },
    }),
  );
  fs.writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({ agent: 'jonathan/web', token: 'tf1_' + 'A'.repeat(43) }),
  );
}

const goodPing = (skewMs = 0): PingProbe => ({
  ok: true,
  rtt_ms: 20,
  local_ts: 1_000_000,
  response: {
    ok: true,
    pong: true,
    nonce: 'doctor',
    agent: 'jonathan/web',
    server_time: 1_000_000 + skewMs,
    protocol_versions: ['tenfour/1'],
    broker_version: '1',
    peer: null,
  },
});

describe('check 1 config-parse', () => {
  it('PASS with a valid config + credentials', () => {
    writeConfig();
    expect(checkConfigParse(home).status).toBe('PASS');
  });
  it('FAIL when config is missing', () => {
    expect(checkConfigParse(home).status).toBe('FAIL');
  });
});

describe('check 13 consent-surface (release-blocking)', () => {
  it('PASSes: exactly four tools and tenfour_send rejects kind:accepted', async () => {
    const res = await checkConsentSurface();
    expect(res.status).toBe('PASS');
  });
});

describe('checks 5–7 (shared diag.ping)', () => {
  it('broker-reach PASS on a good ping, FAIL on an unreachable one', () => {
    expect(checkBrokerReach(goodPing()).status).toBe('PASS');
    expect(
      checkBrokerReach({ ok: false, rtt_ms: 0, local_ts: 0, error: 'ECONNREFUSED' }).status,
    ).toBe('FAIL');
  });
  it('auth-valid PASS when the agent matches, FAIL on mismatch', () => {
    expect(checkAuthValid(goodPing(), 'jonathan/web').status).toBe('PASS');
    expect(checkAuthValid(goodPing(), 'someone/else').status).toBe('FAIL');
  });
  it('clock-skew PASS ≤30s, WARN ≤300s, FAIL >300s', () => {
    expect(checkClockSkew(goodPing(1_000)).status).toBe('PASS');
    expect(checkClockSkew(goodPing(60_000)).status).toBe('WARN');
    expect(checkClockSkew(goodPing(400_000)).status).toBe('FAIL');
  });
});

describe('check 2 credentials-perms', () => {
  it('FAILs a world-readable secret on POSIX, PASSes 0600', () => {
    if (process.platform === 'win32') return;
    const paths = {
      credentialsJson: path.join(home, 'credentials.json'),
      configJson: path.join(home, 'config.json'),
      adminJson: path.join(home, 'admin.json'),
    };
    fs.writeFileSync(paths.credentialsJson, '{}');
    fs.writeFileSync(paths.configJson, '{}');
    fs.chmodSync(paths.credentialsJson, 0o644);
    fs.chmodSync(paths.configJson, 0o600);
    expect(checkCredentialsPerms(paths).status).toBe('FAIL');
    fs.chmodSync(paths.credentialsJson, 0o600);
    expect(checkCredentialsPerms(paths).status).toBe('PASS');
  });
});

describe('exit-code summary (DOC-121)', () => {
  const r = (status: CheckResult['status']): CheckResult => ({ check_id: 'x', status, detail: '' });
  it('1 on any FAIL, 4 on WARN-only, 0 on all PASS', () => {
    expect(summarizeExit([r('PASS'), r('FAIL')])).toBe(DOCTOR_EXIT.FAILURES);
    expect(summarizeExit([r('PASS'), r('WARN')])).toBe(DOCTOR_EXIT.WARNINGS);
    expect(summarizeExit([r('PASS'), r('PASS')])).toBe(DOCTOR_EXIT.ALL_PASS);
  });
});

describe('repoIdFromRemote (ART-081)', () => {
  it('derives host/owner/name from ssh and https remotes', () => {
    expect(repoIdFromRemote('git@github.com:careswift/web.git')).toBe('github.com/careswift/web');
    expect(repoIdFromRemote('https://github.com/careswift/web')).toBe('github.com/careswift/web');
  });
});
