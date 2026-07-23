// @vitest-environment node
/**
 * MCP tool input/output shapes; tenfour_send rejects kind:accepted (MCP-010); ack/thread/
 * wait shapes; duplicate + broker-error mapping. The BrokerClient is mocked — NO network.
 */
import { describe, it, expect } from 'vitest';
import {
  handleToolCall,
  handleSend,
  handleWait,
  TOOL_NAMES,
  TOOL_DEFINITIONS,
  type ToolDeps,
  type Clock,
} from './tools.ts';
import type { BrokerClient } from '../client.ts';
import { SEND_ACCEPTED_REJECTED, ACK_OK_NOTE } from '../strings.ts';

const ULID_A = '01J1PAVH5N40E3D8QT2W9YRKM3';
const ULID_B = '01J1PAVH5N40E3D8QT2W9YRKM4';

function stamped(over: Record<string, unknown> = {}) {
  return {
    protocol: 'tenfour/1',
    id: ULID_A,
    client_id: ULID_A,
    thread_id: ULID_A,
    parent_id: null,
    in_reply_to: null,
    from: 'brian/design',
    to: 'jonathan/web',
    kind: 'task',
    repo: 'github.com/careswift/web',
    body: 'do the thing',
    artifacts: [],
    seq: 1,
    ts: Date.now(),
    round: 1,
    status: 'offered',
    delivery_state: 'queued',
    consent_token: null,
    unfroze: false,
    ...over,
  };
}
function threadSummary(over: Record<string, unknown> = {}) {
  return {
    thread_id: ULID_A,
    root_kind: 'task',
    status: 'offered',
    round: 1,
    max_rounds: 10,
    head_id: ULID_A,
    head_seq: 1,
    repo: 'github.com/careswift/web',
    consent_state: 'none',
    ...over,
  };
}
function fullThread(over: Record<string, unknown> = {}) {
  return {
    thread_id: ULID_A,
    root_kind: 'task',
    initiator: 'brian/design',
    recipient: 'jonathan/web',
    status: 'offered',
    resume_state: null,
    frozen_reason: null,
    frozen_by: null,
    closed_reason: null,
    round: 2,
    max_rounds: 10,
    head_id: ULID_B,
    head_seq: 3,
    repo: 'github.com/careswift/web',
    consent: { state: 'granted', granted_at: 1, granted_via: 'cli_accept', scope: 'whole_thread' },
    created_at: 1,
    updated_at: 2,
    ...over,
  };
}
function mockClient(over: Partial<Record<string, unknown>> = {}): {
  client: BrokerClient;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = { send: [], thread: [], ack: [], inbox: [] };
  const client = {
    async send(p: unknown) {
      calls.send.push(p);
      return (
        (over.send as ((p: unknown) => unknown) | undefined)?.(p) ?? {
          ok: true,
          duplicate: false,
          note: null,
          message: stamped(),
          thread: threadSummary(),
        }
      );
    },
    async thread(p: unknown) {
      calls.thread.push(p);
      return (
        (over.thread as ((p: unknown) => unknown) | undefined)?.(p) ?? {
          ok: true,
          thread: fullThread(),
          messages: [stamped()],
          has_more: false,
        }
      );
    },
    async ack(p: unknown) {
      calls.ack.push(p);
      return (
        (over.ack as ((p: unknown) => unknown) | undefined)?.(p) ?? {
          ok: true,
          message_id: ULID_A,
          delivery_state: 'acked',
          duplicate: false,
          note: ACK_OK_NOTE,
        }
      );
    },
    async inbox(p: unknown) {
      calls.inbox.push(p);
      return (
        (over.inbox as ((p: unknown) => unknown) | undefined)?.(p) ?? {
          ok: true,
          items: [],
          cursor: '0',
          has_more: false,
          server_time: Date.now(),
        }
      );
    },
  } as unknown as BrokerClient;
  return { client, calls };
}
const deps = (client: BrokerClient): ToolDeps => ({ client, agent: 'jonathan/web' });

describe('tool set', () => {
  it('serves exactly four tools', () => {
    expect([...TOOL_NAMES]).toEqual([
      'tenfour_send',
      'tenfour_ack',
      'tenfour_thread',
      'tenfour_wait',
    ]);
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });
  it('every tool input schema is additionalProperties:false', () => {
    for (const t of TOOL_DEFINITIONS) expect(t.inputSchema.additionalProperties).toBe(false);
  });
});

describe('tenfour_send', () => {
  it('sends an opening task and returns {status:"sent", envelope, round, client_id}', async () => {
    const { client, calls } = mockClient();
    const res = await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'task',
      repo: 'github.com/careswift/web',
      body: 'hi',
    });
    expect(res.status).toBe('sent');
    expect(res.envelope).toBeDefined();
    expect(res.round).toEqual({ n: 1, max: 10 });
    expect(typeof res.client_id).toBe('string');
    expect((calls.send[0] as { thread_id: unknown }).thread_id).toBeNull();
    expect((calls.send[0] as { parent_id: unknown }).parent_id).toBeNull();
  });

  it('REJECTS kind:accepted locally with SEND_ACCEPTED_REJECTED and never calls the broker (MCP-010)', async () => {
    const { client, calls } = mockClient();
    const res = await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'accepted',
      thread_id: ULID_A,
      body: '',
    });
    expect(res.status).toBe('error');
    expect(res.code).toBe('TENFOUR/CONSENT_REQUIRED');
    expect(res.what_happened).toContain(SEND_ACCEPTED_REJECTED.slice(0, 30));
    expect(calls.send.length).toBe(0);
  });

  it('fills parent_id from the thread head on a reply', async () => {
    const { client, calls } = mockClient();
    await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'question',
      thread_id: ULID_A,
      body: 'q?',
    });
    expect(calls.thread.length).toBe(1);
    expect((calls.send[0] as { parent_id: unknown }).parent_id).toBe(ULID_B);
  });

  it('maps a duplicate send to a success-shaped {status:"duplicate"} (R7)', async () => {
    const { client } = mockClient({
      send: () => ({
        ok: true,
        duplicate: true,
        note: 'already recorded',
        message: stamped({ delivery_state: 'acked' }),
        thread: threadSummary(),
      }),
    });
    const res = await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'task',
      repo: 'github.com/careswift/web',
      body: 'hi',
    });
    expect(res.status).toBe('duplicate');
    expect(res.delivery_state).toBe('acked');
  });

  it('maps a broker rejection to {status:"error"} with the code + human_action', async () => {
    const { client } = mockClient({
      send: () => ({
        ok: false,
        error: {
          code: 'TENFOUR/STALE_HEAD',
          message: 'head moved',
          human_action: 'read the thread',
          retryable: false,
        },
      }),
    });
    const res = await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'task',
      repo: 'github.com/careswift/web',
      body: 'hi',
    });
    expect(res.status).toBe('error');
    expect(res.code).toBe('TENFOUR/STALE_HEAD');
    expect(res.next_action).toBe('read the thread');
  });

  it('rejects unknown input properties locally (teaching error)', async () => {
    const { client, calls } = mockClient();
    const res = await handleSend(deps(client), {
      to: 'brian/design',
      kind: 'task',
      repo: 'github.com/careswift/web',
      body: 'hi',
      bogus: 1,
    });
    expect(res.status).toBe('error');
    expect(res.code).toBe('INPUT_INVALID');
    expect(calls.send.length).toBe(0);
  });
});

describe('tenfour_ack', () => {
  it('returns {status:"acked"} then {status:"already_acked"}', async () => {
    const { client } = mockClient();
    const r1 = await handleToolCall(deps(client), 'tenfour_ack', {
      message_id: ULID_A,
      attempt_id: ULID_B,
    });
    expect(r1.status).toBe('acked');
    const { client: c2 } = mockClient({
      ack: () => ({
        ok: true,
        message_id: ULID_A,
        delivery_state: 'acked',
        duplicate: true,
        note: 'noted',
      }),
    });
    const r2 = await handleToolCall(deps(c2), 'tenfour_ack', {
      message_id: ULID_A,
      attempt_id: ULID_B,
    });
    expect(r2.status).toBe('already_acked');
  });
});

describe('tenfour_thread', () => {
  it('returns the compaction-proof thread shape', async () => {
    const { client } = mockClient();
    const res = await handleToolCall(deps(client), 'tenfour_thread', { thread_id: ULID_A });
    expect(res.thread_id).toBe(ULID_A);
    expect(res.frozen).toBe(false);
    expect(res.round).toEqual({ n: 2, max: 10 });
    expect(res.consent).toEqual({ present: true, scope: 'whole_thread' });
    expect(Array.isArray(res.messages)).toBe(true);
  });
});

describe('tenfour_wait', () => {
  const fastClock = (): Clock => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
  };
  it('returns {status:"message"} when a message for the thread arrives', async () => {
    const item = {
      message: stamped(),
      attempt_id: ULID_B,
      delivery_state: 'claimed',
      prior_attempts: 0,
      thread: {
        thread_id: ULID_A,
        root_kind: 'task',
        status: 'offered',
        round: 1,
        max_rounds: 10,
        repo: 'github.com/careswift/web',
      },
    };
    const { client } = mockClient({
      inbox: () => ({ ok: true, items: [item], cursor: '1', has_more: false, server_time: 0 }),
    });
    const res = await handleWait(
      { client, agent: 'jonathan/web', clock: fastClock(), pollIntervalMs: 1000 },
      { thread_id: ULID_A, timeout_s: 10 },
    );
    expect(res.status).toBe('message');
    expect(res.attempt_id).toBe(ULID_B);
    expect(res.envelope).toBeDefined();
    expect(typeof res.wrapped).toBe('string');
  });
  it('returns {status:"timeout"} when nothing arrives before the deadline', async () => {
    const { client } = mockClient({
      inbox: () => ({ ok: true, items: [], cursor: '0', has_more: false, server_time: 0 }),
    });
    const res = await handleWait(
      { client, agent: 'jonathan/web', clock: fastClock(), pollIntervalMs: 1000 },
      { thread_id: ULID_A, timeout_s: 10 },
    );
    expect(res.status).toBe('timeout');
    expect(String(res.note)).toContain('mailbox');
  });
});
