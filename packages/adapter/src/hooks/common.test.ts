// @vitest-environment node
/**
 * Hook JSON output shapes (SessionStart / UserPromptSubmit / PostToolUse / Stop) and the
 * Stop loop-guard (HK-005). Pure builders — no IO, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSessionStartOutput,
  buildUserPromptSubmitOutput,
  buildPostToolUseOutput,
  buildStopOutput,
  type ItemView,
} from './common.ts';

const ULID = '01J1PAVH5N40E3D8QT2W9YRKM3';
function item(over: Record<string, unknown> = {}, threadOver: Record<string, unknown> = {}): ItemView {
  return {
    message: {
      protocol: 'tenfour/1', id: ULID, client_id: ULID, thread_id: ULID, parent_id: null, in_reply_to: null,
      from: 'brian/design', to: 'jonathan/web', kind: 'task', repo: 'github.com/careswift/web',
      body: 'Implement the route header', artifacts: [], seq: 1, ts: Date.now(), round: 1, status: 'offered',
      delivery_state: 'queued', consent_token: null, unfroze: false, ...over,
    },
    thread: { thread_id: ULID, root_kind: 'task', status: 'offered', round: 1, max_rounds: 10, repo: 'github.com/careswift/web', ...threadOver },
  } as ItemView;
}

describe('SessionStart digest', () => {
  it('returns null when nothing pends', () => {
    expect(buildSessionStartOutput([])).toBeNull();
  });
  it('injects the full wrapper for exactly one message', () => {
    const out = buildSessionStartOutput([item()])!;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('<<<tenfour:');
    expect(out.hookSpecificOutput.additionalContext).toContain('Implement the route header');
  });
  it('digests 2+ messages surface-first, capped at 5 with an overflow line', () => {
    const items = Array.from({ length: 7 }, (_v, i) => item({ id: ULID.slice(0, 25) + String(i), body: `task ${i}` }));
    const ctx = buildSessionStartOutput(items)!.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('await triage');
    expect(ctx).toContain('and 2 more');
    expect(ctx.split('\n').filter((l) => /^\d+\. \[/.test(l))).toHaveLength(5); // 5 numbered lines
  });
});

describe('UserPromptSubmit', () => {
  it('prepends a count prefix and full wrappers', () => {
    const out = buildUserPromptSubmitOutput([item(), item()])!;
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('arrived while this session was idle');
    expect(out.hookSpecificOutput.additionalContext.match(/<<<tenfour:/g)).toHaveLength(2);
  });
  it('returns null when empty', () => {
    expect(buildUserPromptSubmitOutput([])).toBeNull();
  });
});

describe('PostToolUse', () => {
  it('emits the mid-turn preamble + wrapper', () => {
    const out = buildPostToolUseOutput([item()])!;
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('arrived mid-task');
  });
  it('returns null when empty (exit 0, no output)', () => {
    expect(buildPostToolUseOutput([])).toBeNull();
  });
});

describe('Stop', () => {
  it('does NOT block when stop_hook_active is true (HK-005 loop guard)', () => {
    expect(buildStopOutput({ stop_hook_active: true }, [item()])).toBeNull();
  });
  it('blocks-with-reason, surface-first, when arrivals exist', () => {
    const out = buildStopOutput({ stop_hook_active: false }, [item()])!;
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('New tenfour message arrived while you worked');
    expect(out.reason).toContain('Tell your human');
  });
  it('returns null when no arrivals', () => {
    expect(buildStopOutput({}, [])).toBeNull();
  });
});
