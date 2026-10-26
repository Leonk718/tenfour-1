/**
 * tenfour adapter — hook output builders (CLI-MCP §3; DELIVERY §4). Pure functions that
 * turn already-fetched inbox items + journal state into the exact hook JSON output
 * shapes. All model-facing bytes come from strings.ts. IO (stdin/stdout/broker/journal)
 * lives in the per-event run modules; these builders are unit-tested directly.
 */

import type { InboxItem, StampedEnvelope, InboxThreadInfo } from '../../../schema/src/protocol.ts';
import {
  assembleInboundWrapper,
  fmt,
  pluralS,
  shortThreadId,
  DIGEST_MAX_ITEMS,
  SESSION_START_DIGEST_HEADER,
  SESSION_START_DIGEST_FOOTER,
  DIGEST_LINE,
  DIGEST_OVERFLOW_LINE,
  STOP_HOOK_MESSAGE,
  STOP_HOOK_ACK_SUFFIX,
  USER_PROMPT_SUBMIT_PREFIX,
  POST_TOOL_USE_MIDTURN_PREAMBLE,
} from '../strings.ts';
import { nonceHex } from '../ids.ts';

/** Minimal item view a builder needs — an InboxItem or an equivalent journal-backed row. */
export interface ItemView {
  message: StampedEnvelope;
  thread: InboxThreadInfo;
  prior_attempts?: number;
  redelivery?: boolean;
  /** Delivery attempt to ack; null/absent when the broker gave none. */
  attempt_id?: string | null;
}

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string };
}
export interface UserPromptSubmitOutput {
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit'; additionalContext: string };
}
export interface PostToolUseOutput {
  hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string };
}
export interface StopBlockOutput {
  decision: 'block';
  reason: string;
}

/** Human-friendly age from a ms timestamp — display formatting, not model doctrine. */
export function ageString(tsMs: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - tsMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** One-line summary of a body (first non-empty line, truncated). */
export function summarize(body: string, max = 100): string {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const consentStateFor = (info: InboxThreadInfo): string =>
  info.root_kind === 'question' ? 'not_required' : 'none';

/** Assemble the full inbound wrapper for one item (the shared per-message rendering). */
export function wrapItem(item: ItemView, now: number = Date.now()): string {
  void now;
  return assembleInboundWrapper({
    nonce: nonceHex(),
    from: item.message.from,
    thread_short: shortThreadId(item.message.thread_id),
    kind: item.message.kind,
    round: item.thread.round,
    max_rounds: item.thread.max_rounds,
    state: item.thread.status,
    consent_state: consentStateFor(item.thread),
    body: item.message.body,
    redelivery: item.redelivery ?? (item.prior_attempts ?? 0) > 0,
    repo: item.message.repo ?? undefined,
    consent_token: item.message.consent_token ?? undefined,
    ack: item.attempt_id ? { message_id: item.message.id, attempt_id: item.attempt_id } : undefined,
  });
}

/**
 * SessionStart digest (I1): surface-first, cap 5 (DIGEST_MAX_ITEMS). Exactly one pending
 * message injects the full wrapper instead of a digest (JOURNEYS §4). Returns null when
 * nothing pends.
 */
export function buildSessionStartOutput(
  items: readonly ItemView[],
  now: number = Date.now(),
): SessionStartOutput | null {
  if (items.length === 0) return null;
  if (items.length === 1) {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: wrapItem(items[0], now),
      },
    };
  }
  const header = fmt(SESSION_START_DIGEST_HEADER, {
    count: items.length,
    plural_s: pluralS(items.length),
  });
  const shown = items.slice(0, DIGEST_MAX_ITEMS);
  const lines = shown.map((item, i) =>
    fmt(DIGEST_LINE, {
      n: i + 1,
      kind: item.message.kind,
      from: item.message.from,
      thread_short: shortThreadId(item.message.thread_id),
      round: item.thread.round,
      max_rounds: item.thread.max_rounds,
      age: ageString(item.message.ts, now),
      summary: summarize(item.message.body),
    }),
  );
  const parts = [header, ...lines];
  if (items.length > DIGEST_MAX_ITEMS) {
    parts.push(fmt(DIGEST_OVERFLOW_LINE, { overflow_count: items.length - DIGEST_MAX_ITEMS }));
  }
  parts.push(SESSION_START_DIGEST_FOOTER);
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') },
  };
}

/** UserPromptSubmit (I2): prepend a count prefix then each full wrapper. Null when empty. */
export function buildUserPromptSubmitOutput(
  items: readonly ItemView[],
  now: number = Date.now(),
): UserPromptSubmitOutput | null {
  if (items.length === 0) return null;
  const prefix = fmt(USER_PROMPT_SUBMIT_PREFIX, {
    count: items.length,
    plural_s: pluralS(items.length),
  });
  const body = [prefix, ...items.map((i) => wrapItem(i, now))].join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body } };
}

/** PostToolUse (I4): mid-turn preamble + up to 5 wrapped messages. Null when empty. */
export function buildPostToolUseOutput(
  items: readonly ItemView[],
  now: number = Date.now(),
): PostToolUseOutput | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, DIGEST_MAX_ITEMS);
  const body = [POST_TOOL_USE_MIDTURN_PREAMBLE, ...shown.map((i) => wrapItem(i, now))].join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body } };
}

/**
 * Stop (I3): block-with-reason surface-first when new arrivals exist. MUST NOT block when
 * stop_hook_active is true (HK-005 loop guard). Returns null to allow the stop.
 */
export function buildStopOutput(
  input: { stop_hook_active?: boolean },
  arrivals: readonly ItemView[],
): StopBlockOutput | null {
  if (input.stop_hook_active === true) return null;
  if (arrivals.length === 0) return null;
  const a = arrivals[0];
  return {
    decision: 'block',
    reason: fmt(STOP_HOOK_MESSAGE, {
      kind: a.message.kind,
      from: a.message.from,
      thread_short: shortThreadId(a.message.thread_id),
      summary: summarize(a.message.body),
      ack: a.attempt_id
        ? fmt(STOP_HOOK_ACK_SUFFIX, { message_id: a.message.id, attempt_id: a.attempt_id })
        : '',
    }),
  };
}

/** Convert an InboxItem (wire) to the builder's ItemView. */
export function itemViewOf(item: InboxItem): ItemView {
  return {
    message: item.message,
    thread: item.thread,
    prior_attempts: item.prior_attempts,
    attempt_id: item.attempt_id,
  };
}
