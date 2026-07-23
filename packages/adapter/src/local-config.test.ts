// @vitest-environment node
/** Config / credentials parse + schema validation (CLI-MCP §0; doctor check 1 basis). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, loadCredentials, saveConfig, saveCredentials } from './local-config.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cfg-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const CONFIG = { broker_url: 'https://x.convex.cloud', agent: 'jonathan/web', peer: 'brian/design', workspaces: [], allowed_repos: [], standing_rules: { auto_answer_questions: false, auto_accept_from: [] } };
const CREDS = { agent: 'jonathan/web', token: 'tf1_' + 'A'.repeat(43) };

describe('config parse', () => {
  it('round-trips a valid config', () => {
    saveConfig(CONFIG, home);
    const res = loadConfig(home);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.agent).toBe('jonathan/web');
  });
  it('reports missing when absent', () => {
    const res = loadConfig(home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing');
  });
  it('reports unparseable on invalid JSON', () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
    const res = loadConfig(home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unparseable');
  });
  it('reports invalid on a schema violation (non-https broker_url)', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...CONFIG, broker_url: 'http://x' }));
    const res = loadConfig(home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });
});

describe('credentials parse', () => {
  it('round-trips a valid credential and enforces the token format', () => {
    saveCredentials(CREDS, home);
    const res = loadCredentials(home);
    expect(res.ok).toBe(true);
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ agent: 'jonathan/web', token: 'nope' }));
    const bad = loadCredentials(home);
    expect(bad.ok).toBe(false);
  });
  it('writes credentials with 0600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    saveCredentials(CREDS, home);
    const mode = fs.statSync(path.join(home, 'credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
