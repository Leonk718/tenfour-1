/**
 * tenfour adapter — the four MCP tools (CLI-MCP §2). Tool descriptions are imported
 * verbatim from strings.ts. `tenfour_send` REJECTS kind:accepted locally (MCP-010).
 * There is NO consent/confirm tool (B1). Protocol rejections are returned as structured
 * tool RESULTS (MCP-001), never MCP protocol errors — result content steers the model;
 * transport errors trigger repair loops (JOURNEYS §4).
 *
 * `handleToolCall` is pure over an injected `BrokerClient` + `Journal` so unit tests
 * exercise it without a network or a real MCP transport.
 */

import { contentHash } from '../../../schema/src/protocol.ts';
import type { ErrorObject } from '../../../schema/src/protocol.ts';
import {
  type TenfourErrorCode,
  TOOL_SEND_DESCRIPTION,
  TOOL_ACK_DESCRIPTION,
  TOOL_THREAD_DESCRIPTION,
  TOOL_WAIT_DESCRIPTION,
  SEND_ACCEPTED_REJECTED,
  SEND_DUPLICATE_NOTE,
  WAIT_TIMEOUT_NOTE,
  ERRORS,
  fmt,
  shortThreadId,
  assembleInboundWrapper,
} from '../strings.ts';
import { BrokerClient } from '../client.ts';
import { Journal } from '../journal.ts';
import { ulid, nonceHex } from '../ids.ts';
import {
  TenfourSendInputSchema,
  TenfourAckInputSchema,
  TenfourThreadInputSchema,
  TenfourWaitInputSchema,
  TENFOUR_SEND_JSON_SCHEMA,
  TENFOUR_ACK_JSON_SCHEMA,
  TENFOUR_THREAD_JSON_SCHEMA,
  TENFOUR_WAIT_JSON_SCHEMA,
} from './schemas.ts';
import type { z } from 'zod';

/** The EXACTLY four served tool names (B1/B15). Doctor check 13 asserts this set. */
export const TOOL_NAMES = ['tenfour_send', 'tenfour_ack', 'tenfour_thread', 'tenfour_wait'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list served at `tools/list` — descriptions come verbatim from strings.ts. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'tenfour_send', description: TOOL_SEND_DESCRIPTION, inputSchema: TENFOUR_SEND_JSON_SCHEMA },
  { name: 'tenfour_ack', description: TOOL_ACK_DESCRIPTION, inputSchema: TENFOUR_ACK_JSON_SCHEMA },
  { name: 'tenfour_thread', description: TOOL_THREAD_DESCRIPTION, inputSchema: TENFOUR_THREAD_JSON_SCHEMA },
  { name: 'tenfour_wait', description: TOOL_WAIT_DESCRIPTION, inputSchema: TENFOUR_WAIT_JSON_SCHEMA },
];

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ToolDeps {
  client: BrokerClient;
  agent: string;
  journal?: Journal;
  mintId?: () => string;
  clock?: Clock;
  pollIntervalMs?: number;
}

export type ToolResult = Record<string, unknown> & { status: string };

/** MCP-001: build the structured error result from the strings.ts ERRORS registry. */
export function mcpErrorFromCode(code: TenfourErrorCode, vars: Record<string, string | number> = {}): ToolResult {
  const e = ERRORS[code];
  return {
    status: 'error',
    code: `TENFOUR/${code}`,
    what_happened: fmt(e.what, vars),
    what_is_true_now: fmt(e.now, vars),
    next_action: fmt(e.instead, vars),
    retryable: false,
  };
}

/** MCP-001: map a broker ErrorObject (already-rendered message + human_action) to the result shape. */
export function mcpErrorFromBroker(error: ErrorObject): ToolResult {
  return {
    status: 'error',
    code: error.code,
    what_happened: error.message,
    what_is_true_now: '',
    next_action: error.human_action,
    retryable: false,
  };
}

/** Local input-validation teaching result (never reaches the broker). */
function teachingError(err: z.ZodError): ToolResult {
  const issue = err.issues[0];
  const where = issue?.path.join('.') || '(root)';
  return {
    status: 'error',
    code: 'INPUT_INVALID',
    what_happened: `Tool input rejected at ${where}: ${issue?.message ?? 'invalid'}.`,
    what_is_true_now: '',
    next_action: 'Fix the field and call the tool again with only the documented properties.',
    retryable: false,
  };
}

export async function handleSend(deps: ToolDeps, args: unknown): Promise<ToolResult> {
  const parsed = TenfourSendInputSchema.safeParse(args);
  if (!parsed.success) return teachingError(parsed.error);
  const input = parsed.data;
  const threadShort = input.thread_id ? shortThreadId(input.thread_id) : 'new';

  // MCP-010: reject kind:accepted locally with the strings.ts message (CONSENT_REQUIRED).
  if (input.kind === 'accepted') {
    return {
      status: 'error',
      code: 'TENFOUR/CONSENT_REQUIRED',
      what_happened: fmt(SEND_ACCEPTED_REJECTED, { thread_short: threadShort }),
      what_is_true_now: '',
      next_action: '',
      retryable: false,
    };
  }

  // Adapter fills parent_id from the thread head (never the model).
  let parentId: string | null = null;
  if (input.thread_id) {
    const tr = await deps.client.thread({ thread_id: input.thread_id });
    if (!tr.ok) return mcpErrorFromBroker(tr.error);
    parentId = tr.thread.head_id;
  }

  const clientId = (deps.mintId ?? ulid)();
  const body = input.body.normalize('NFC');
  const artifacts = input.artifacts ?? [];

  // MCP-011: persist prepared(client_id, content_hash) → sending → confirmed|failed.
  let hash = 'sha256:unhashable';
  try {
    hash = await contentHash({
      protocol: 'tenfour/1',
      to: input.to,
      kind: input.kind,
      body,
      thread_id: input.thread_id ?? null,
      parent_id: parentId,
      in_reply_to: input.in_reply_to ?? null,
      repo: input.repo ?? null,
      artifacts,
    });
  } catch {
    /* hashing best-effort; broker computes its own */
  }
  deps.journal?.recordPrepared(clientId, hash);
  deps.journal?.recordSending(clientId);

  const resp = await deps.client.send({
    client_id: clientId,
    to: input.to,
    kind: input.kind,
    thread_id: input.thread_id ?? null,
    parent_id: parentId,
    in_reply_to: input.in_reply_to ?? null,
    repo: input.repo ?? null,
    body,
    artifacts,
  });

  if (!resp.ok) {
    deps.journal?.recordFailed(clientId, resp.error.code);
    return mcpErrorFromBroker(resp.error);
  }
  deps.journal?.recordConfirmed(clientId, resp.message.id, resp.message.seq);

  if (resp.duplicate) {
    return {
      status: 'duplicate',
      note: resp.note ?? fmt(SEND_DUPLICATE_NOTE, { id: resp.message.id, delivery_state: resp.message.delivery_state }),
      envelope: resp.message,
      delivery_state: resp.message.delivery_state,
    };
  }
  return {
    status: 'sent',
    envelope: resp.message,
    round: { n: resp.thread.round, max: resp.thread.max_rounds },
    client_id: clientId,
  };
}

export async function handleAck(deps: ToolDeps, args: unknown): Promise<ToolResult> {
  const parsed = TenfourAckInputSchema.safeParse(args);
  if (!parsed.success) return teachingError(parsed.error);
  const resp = await deps.client.ack({ message_id: parsed.data.message_id, attempt_id: parsed.data.attempt_id });
  if (!resp.ok) return mcpErrorFromBroker(resp.error);
  return { status: resp.duplicate ? 'already_acked' : 'acked', note: resp.note };
}

export async function handleThread(deps: ToolDeps, args: unknown): Promise<ToolResult> {
  const parsed = TenfourThreadInputSchema.safeParse(args);
  if (!parsed.success) return teachingError(parsed.error);
  const resp = await deps.client.thread({ thread_id: parsed.data.thread_id });
  if (!resp.ok) return mcpErrorFromBroker(resp.error);
  const t = resp.thread;
  return {
    status: 'ok',
    thread_id: t.thread_id,
    state: t.status,
    frozen: t.status === 'frozen',
    head: t.head_id,
    round: { n: t.round, max: t.max_rounds },
    consent: { present: t.consent.state === 'granted', scope: t.consent.scope },
    repo: t.repo,
    messages: resp.messages,
  };
}

export async function handleWait(deps: ToolDeps, args: unknown): Promise<ToolResult> {
  const parsed = TenfourWaitInputSchema.safeParse(args);
  if (!parsed.success) return teachingError(parsed.error);
  const { thread_id, timeout_s } = parsed.data;
  const clock = deps.clock ?? REAL_CLOCK;
  const pollMs = deps.pollIntervalMs ?? 2_000;
  const deadline = clock.now() + timeout_s * 1000;
  const holder = deps.journal ? deps.journal.holderId() : ulid();

  for (;;) {
    const inbox = await deps.client.inbox({ mode: 'claim', holder });
    if (!inbox.ok) return mcpErrorFromBroker(inbox.error);
    const item = inbox.items.find((i) => i.message.thread_id === thread_id && i.attempt_id !== null);
    if (item && item.attempt_id) {
      const attemptId = item.attempt_id;
      const messageId = item.message.id;
      // Journal received → injected → ack_pending → acked (tool-result auto-ack, DEL-25).
      try {
        deps.journal?.recordReceived(messageId, attemptId);
        deps.journal?.recordInjected(messageId, attemptId);
        deps.journal?.recordAckPending(messageId, attemptId);
      } catch {
        /* journal best-effort */
      }
      const ackResp = await deps.client.ack({ message_id: messageId, attempt_id: attemptId, state: 'acked' });
      if (ackResp.ok) deps.journal?.recordAcked(messageId, attemptId);
      const wrapped = assembleInboundWrapper({
        nonce: nonceHex(),
        from: item.message.from,
        thread_short: shortThreadId(item.message.thread_id),
        kind: item.message.kind,
        round: item.thread.round,
        max_rounds: item.thread.max_rounds,
        state: item.thread.status,
        consent_state: item.thread.root_kind === 'question' ? 'not_required' : 'none',
        body: item.message.body,
        redelivery: item.prior_attempts > 0,
        repo: item.message.repo ?? undefined,
      });
      return { status: 'message', envelope: item.message, wrapped, attempt_id: attemptId };
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(pollMs, Math.max(0, deadline - clock.now())));
  }
  return { status: 'timeout', note: fmt(WAIT_TIMEOUT_NOTE, { seconds: timeout_s }) };
}

const HANDLERS: Record<ToolName, (deps: ToolDeps, args: unknown) => Promise<ToolResult>> = {
  tenfour_send: handleSend,
  tenfour_ack: handleAck,
  tenfour_thread: handleThread,
  tenfour_wait: handleWait,
};

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch a tool call to its handler. Unknown tool name → teaching result. */
export async function handleToolCall(deps: ToolDeps, name: string, args: unknown): Promise<ToolResult> {
  if (!isToolName(name)) {
    return {
      status: 'error',
      code: 'INPUT_INVALID',
      what_happened: `Unknown tool '${name}'. tenfour serves exactly: ${TOOL_NAMES.join(', ')}.`,
      what_is_true_now: '',
      next_action: 'Call one of the four documented tenfour tools.',
      retryable: false,
    };
  }
  return HANDLERS[name](deps, args);
}
