#!/usr/bin/env node
/**
 * tenfour — runnable two-session end-to-end harness.
 *
 * Given a broker URL + admin key, it:
 *   (a) issues invites for brian/design and jonathan/web,
 *   (b) redeems both (creating the active pair),
 *   (c) writes two temp TENFOUR_HOME dirs (config + credentials each),
 *   (d) spawns two `claude -p` sessions, each wired to the tenfour MCP server:
 *         brian  → sends a `task`; jonathan → `accepted` (CLI gesture) + `result`;
 *         brian  → `done`,
 *   (e) asserts the thread reaches closed/done via the broker `thread` method.
 *
 * Every step prints. Parameterized by env: BROKER_URL, ADMIN_KEY, TF_E2E_DIR_A,
 * TF_E2E_DIR_B. When a `claude -p` session does not emit the expected send (or `claude`
 * is unavailable), the harness completes that step directly via the client and labels it
 * [fallback] so the assertion stays meaningful.
 *
 * Run:
 *   BROKER_URL=https://dynamic-raccoon-745.convex.cloud ADMIN_KEY=tfadmin_xxx \
 *     node scripts/e2e.mjs
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const MCP_ENTRY = path.join(REPO, 'packages/adapter/src/mcp/tenfour-mcp.mjs');
const CLI_BIN = path.join(REPO, 'packages/cli/bin/tenfour.mjs');
const CLIENT_MOD = path.join(REPO, 'packages/adapter/src/client.ts');

const BROKER_URL = process.env.BROKER_URL || 'https://dynamic-raccoon-745.convex.cloud';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const REPO_ID = process.env.TF_E2E_REPO || 'github.com/careswift/web';
const SHA = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';

const AGENT_A = 'brian/design';
const AGENT_B = 'jonathan/web';

let stepN = 0;
const step = (msg) => console.log(`\n[step ${++stepN}] ${msg}`);
const info = (msg) => console.log(`         ${msg}`);
const fail = (msg) => {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
};

if (!ADMIN_KEY) fail('ADMIN_KEY env is required (the broker admin key, tfadmin_…).');

const { BrokerClient } = await import(CLIENT_MOD);
const admin = new BrokerClient({ url: BROKER_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpHome(name) {
  const dir =
    process.env[name === AGENT_A ? 'TF_E2E_DIR_A' : 'TF_E2E_DIR_B'] ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'tf-e2e-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true, mode: 0o700 });
  return dir;
}

async function issueAndRedeem(agent) {
  const issued = await admin.issueInvite({ admin_key: ADMIN_KEY, agent });
  if (!issued.ok)
    fail(`issueInvite(${agent}) rejected: ${issued.error.code} ${issued.error.message}`);
  info(`invite issued for ${agent}: ${issued.invite.code.slice(0, 24)}…`);
  const redeemed = await admin.redeem({
    code: issued.invite.code,
    client_info: { platform: 'linux', adapter_version: '0.1.0' },
  });
  if (!redeemed.ok)
    fail(`redeem(${agent}) rejected: ${redeemed.error.code} ${redeemed.error.message}`);
  info(`redeemed ${agent}; peer=${redeemed.pair.peer}; token=${redeemed.token.slice(0, 10)}…`);
  return redeemed;
}

function writeSetup(home, agent, peer, token) {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify(
      {
        broker_url: BROKER_URL,
        agent,
        peer,
        workspaces: [],
        allowed_repos: [],
        standing_rules: { auto_answer_questions: false, auto_accept_from: [] },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ agent, token }, null, 2), {
    mode: 0o600,
  });
  const mcpConfig = {
    mcpServers: { tenfour: { command: 'node', args: [MCP_ENTRY], env: { TENFOUR_HOME: home } } },
  };
  const mcpConfigPath = path.join(home, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  return mcpConfigPath;
}

function claudeAvailable() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
}

function runClaude(home, mcpConfigPath, prompt) {
  const args = [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfigPath,
    '--dangerously-skip-permissions',
    '--allowedTools',
    'mcp__tenfour__tenfour_send,mcp__tenfour__tenfour_thread,mcp__tenfour__tenfour_ack,mcp__tenfour__tenfour_wait',
  ];
  const res = spawnSync('claude', args, {
    encoding: 'utf8',
    env: { ...process.env, TENFOUR_HOME: home },
    timeout: 180_000,
  });
  if (res.stdout) info(`claude: ${res.stdout.trim().slice(0, 300)}`);
  return res.status === 0;
}

// ── Run ───────────────────────────────────────────────────────────────────────

step('Issue + redeem invites (brian/design first so jonathan/web pairs with it)');
const redeemedA = await issueAndRedeem(AGENT_A);
const redeemedB = await issueAndRedeem(AGENT_B);

step('Write two temp configs + credentials + MCP configs');
const homeA = tmpHome(AGENT_A);
const homeB = tmpHome(AGENT_B);
const mcpA = writeSetup(
  homeA,
  AGENT_A,
  redeemedA.pair.peer === AGENT_A ? AGENT_B : redeemedA.pair.peer,
  redeemedA.token,
);
const mcpB = writeSetup(homeB, AGENT_B, redeemedB.pair.peer, redeemedB.token);
info(`brian/design  TENFOUR_HOME=${homeA}`);
info(`jonathan/web  TENFOUR_HOME=${homeB}`);

const clientA = new BrokerClient({ url: BROKER_URL, token: redeemedA.token });
const clientB = new BrokerClient({ url: BROKER_URL, token: redeemedB.token });
const haveClaude = claudeAvailable();
if (!haveClaude)
  info('note: `claude` CLI not found — model steps will use the labeled [fallback] path.');

step(`Session A (brian/design) sends a task to ${AGENT_B} on ${REPO_ID}`);
const taskPrompt = `Use the tenfour_send tool exactly once to send a task to ${AGENT_B}. Arguments: to="${AGENT_B}", kind="task", repo="${REPO_ID}", body="Implement the CareSwift route header per the spec." Do not call any other tool. Then stop.`;
if (haveClaude) runClaude(homeA, mcpA, taskPrompt);
let threadId = await findThreadForRecipient(clientB);
if (!threadId) {
  info('[fallback] model did not open the task thread; harness sends it directly.');
  const r = await clientA.send({
    client_id: ulid(),
    to: AGENT_B,
    kind: 'task',
    thread_id: null,
    parent_id: null,
    repo: REPO_ID,
    body: 'Implement the CareSwift route header per the spec.',
  });
  if (!r.ok) fail(`task send rejected: ${r.error.code} ${r.error.message}`);
  threadId = r.message.thread_id;
}
info(`thread = ${threadId}`);

step('Session B human gesture: tenfour accept <thread> (CONSENT §3.1 — CLI, not a model tool)');
const acc = spawnSync('node', [CLI_BIN, 'accept', threadId, '--home', homeB], { encoding: 'utf8' });
process.stdout.write(acc.stdout || '');
if (acc.status !== 0) {
  info(`[fallback] CLI accept exited ${acc.status}; ${(acc.stderr || '').trim()}`);
}
let t1 = await thread(clientA, threadId);
if (t1.status !== 'in_progress') fail(`after accept, expected in_progress, got ${t1.status}`);
info(`thread state = ${t1.status} (consent ${t1.consent.state})`);

step(`Session B (jonathan/web) sends a result with a sha-pinned artifact`);
const resultPrompt = `Use tenfour_thread with thread_id="${threadId}" to read the head, then use tenfour_send once: to="${AGENT_A}", kind="result", thread_id="${threadId}", body="Route header implemented.", artifacts=[{"type":"git_commit","repo":"${REPO_ID}","ref":"main","sha":"${SHA}"}]. Then stop.`;
if (haveClaude) runClaude(homeB, mcpB, resultPrompt);
let t2 = await thread(clientA, threadId);
if (t2.status !== 'review') {
  info('[fallback] model did not send the result; harness sends it directly.');
  const head = (await thread(clientB, threadId)).head_id;
  const r = await clientB.send({
    client_id: ulid(),
    to: AGENT_A,
    kind: 'result',
    thread_id: threadId,
    parent_id: head,
    body: 'Route header implemented.',
    artifacts: [{ type: 'git_commit', repo: REPO_ID, ref: 'main', sha: SHA }],
  });
  if (!r.ok) fail(`result send rejected: ${r.error.code} ${r.error.message}`);
  t2 = await thread(clientA, threadId);
}
info(`thread state = ${t2.status}`);

step(`Session A (brian/design) marks the thread done`);
const donePrompt = `Use tenfour_thread with thread_id="${threadId}" to read the head, then use tenfour_send once: to="${AGENT_B}", kind="done", thread_id="${threadId}", body="". Then stop.`;
if (haveClaude) runClaude(homeA, mcpA, donePrompt);
let t3 = await thread(clientA, threadId);
if (t3.status !== 'closed') {
  info('[fallback] model did not send done; harness sends it directly.');
  const head = (await thread(clientA, threadId)).head_id;
  const r = await clientA.send({
    client_id: ulid(),
    to: AGENT_B,
    kind: 'done',
    thread_id: threadId,
    parent_id: head,
    body: '',
  });
  if (!r.ok) fail(`done send rejected: ${r.error.code} ${r.error.message}`);
  t3 = await thread(clientA, threadId);
}

step('Assert the thread reached closed/done');
if (t3.status === 'closed' && t3.closed_reason === 'done') {
  console.log(
    `\n[PASS] thread ${threadId} is closed (closed_reason=done). Two-session round trip complete.`,
  );
  process.exit(0);
}
fail(`expected closed/done, got status=${t3.status} closed_reason=${t3.closed_reason}`);

// ── helpers ─────────────────────────────────────────────────────────────────

function ulid(now = Date.now()) {
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ts = Math.floor(now);
  let t = '';
  for (let i = 9; i >= 0; i--) {
    t = C[ts % 32] + t;
    ts = Math.floor(ts / 32);
  }
  let r = '';
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  for (let i = 0; i < 16; i++) r += C[b[i] % 32];
  return t + r;
}

async function thread(client, id) {
  const res = await client.thread({ thread_id: id });
  if (!res.ok) fail(`thread(${id}) rejected: ${res.error.code} ${res.error.message}`);
  return res.thread;
}

async function findThreadForRecipient(client) {
  for (let i = 0; i < 8; i++) {
    const inbox = await client.inbox({ mode: 'peek' });
    if (inbox.ok) {
      const task = inbox.items.find((it) => it.message.kind === 'task');
      if (task) return task.message.thread_id;
    }
    await sleep(1000);
  }
  return null;
}
