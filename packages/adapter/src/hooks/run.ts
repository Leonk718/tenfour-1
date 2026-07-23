/**
 * tenfour adapter — hook runtime IO (DELIVERY §4). Reads the hook stdin JSON, fetches +
 * journals inbound messages, and writes the exact hook output built by common.ts. Every
 * path FAILS OPEN (DEL-19): a broker error or missing setup exits 0 without blocking
 * Claude Code. PostToolUse is LOCAL-ONLY (HK-004): it never touches the network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrokerClient } from '../client.ts';
import { Journal } from '../journal.ts';
import { loadConfig, loadCredentials } from '../local-config.ts';
import { tenfourPaths } from '../paths.ts';
import type { InboxItem, StampedEnvelope, InboxThreadInfo } from '../../../schema/src/protocol.ts';
import {
  buildSessionStartOutput,
  buildUserPromptSubmitOutput,
  buildPostToolUseOutput,
  buildStopOutput,
  itemViewOf,
  type ItemView,
} from './common.ts';

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'post-tool-use' | 'stop';

export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop'];

interface HookContext {
  client: BrokerClient;
  journal: Journal;
  agent: string;
}

export async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeOutput(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

/** Load broker client + journal, or null (fail-open) if the machine is not set up. */
export function loadContext(home?: string, env: NodeJS.ProcessEnv = process.env): HookContext | null {
  const cfg = loadConfig(home, env);
  const creds = loadCredentials(home, env);
  if (!cfg.ok || !creds.ok) return null;
  const journal = new Journal(tenfourPaths(home, env).journalDir);
  journal.ensure();
  return { client: new BrokerClient({ url: cfg.value.broker_url, token: creds.value.token }), journal, agent: creds.value.agent };
}

/** Claim inbox, write-ahead journal `received`+`injected`, and return the views to inject. */
async function claimAndJournal(ctx: HookContext): Promise<ItemView[]> {
  const holder = ctx.journal.holderId();
  const resp = await ctx.client.inbox({ mode: 'claim', holder });
  if (!resp.ok) return [];
  const views: ItemView[] = [];
  const states = ctx.journal.states();
  for (const item of resp.items as InboxItem[]) {
    const st = states.get(item.message.id)?.state;
    if (st === 'ack_pending' || st === 'acked') continue; // journal dedup
    if (item.attempt_id) {
      ctx.journal.recordReceived(item.message.id, item.attempt_id);
      const redelivery = ctx.journal.recordInjected(item.message.id, item.attempt_id);
      views.push({ ...itemViewOf(item), redelivery: redelivery || item.prior_attempts > 0 });
    } else {
      views.push(itemViewOf(item));
    }
  }
  return views;
}

// ── PostToolUse local content sidecar (written by the MCP subscription, read here) ──────

const PENDING_CONTENT = 'pending.content.jsonl';

interface StashedRow {
  message: StampedEnvelope;
  thread: InboxThreadInfo;
  prior_attempts: number;
}

function readPendingContent(journal: Journal): ItemView[] {
  const file = path.join(journal.dir, PENDING_CONTENT);
  if (!fs.existsSync(file)) return [];
  const out: ItemView[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as StashedRow;
      out.push({ message: row.message, thread: row.thread, prior_attempts: row.prior_attempts });
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

const MIDTURN_THROTTLE_MS = 30_000;

export async function runEvent(event: HookEvent, input: Record<string, unknown>, home?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // PostToolUse: LOCAL ONLY — stat pending.flag vs watermark, honor demotion + throttle.
  if (event === 'post-tool-use') {
    const j = new Journal(tenfourPaths(home, env).journalDir);
    if (!fs.existsSync(j.dir)) return;
    if (j.isDemoted()) return;
    const flagMtime = j.statMtime(j.pendingFlag);
    if (flagMtime === null) return;
    const watermark = j.midturnWatermark();
    if (flagMtime <= watermark) return;
    if (Date.now() - watermark < MIDTURN_THROTTLE_MS && watermark !== 0) return; // throttle (DEL-46)
    const views = readPendingContent(j);
    const out = buildPostToolUseOutput(views);
    if (out) {
      j.setMidturnWatermark();
      writeOutput(out);
    }
    return;
  }

  const ctx = loadContext(home, env);
  if (!ctx) return; // not set up — fail open

  try {
    if (event === 'session-start') {
      const views = await claimAndJournal(ctx);
      const out = buildSessionStartOutput(views);
      if (out) writeOutput(out);
    } else if (event === 'user-prompt-submit') {
      const views = await claimAndJournal(ctx);
      const out = buildUserPromptSubmitOutput(views);
      if (out) writeOutput(out);
    } else if (event === 'stop') {
      if (input.stop_hook_active === true) return; // HK-005 loop guard
      const views = await claimAndJournal(ctx);
      const out = buildStopOutput(input, views);
      if (out) writeOutput(out);
    }
  } catch {
    // fail open — never block Claude on a broker/journal error (DEL-19).
  }
}
