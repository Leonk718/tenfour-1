/**
 * tenfour adapter — broker client. Wraps ConvexHttpClient (from "convex/browser"),
 * calls the 7 deployed broker functions, and validates every response against the
 * protocol.ts Zod authority. The transport is an injectable interface so unit tests
 * mock it and NEVER hit the network.
 *
 * The broker functions each take `{ request: <wire request> }` and return `v.any()`;
 * this module assembles the wire request (protocol version + auth) from domain params
 * and parses the raw response with the METHOD_SCHEMAS response schema.
 */

import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import {
  PROTOCOL_VERSION,
  SendResponseSchema,
  InboxResponseSchema,
  AckResponseSchema,
  ThreadResponseSchema,
  DiagPingResponseSchema,
  AdminIssueInviteResponseSchema,
  InviteRedeemResponseSchema,
  type SendResponse,
  type InboxResponse,
  type AckResponse,
  type ThreadResponse,
  type DiagPingResponse,
  type AdminIssueInviteResponse,
  type InviteRedeemResponse,
  type Kind,
  type Artifact,
  type GrantedVia,
  type Platform,
} from '../../schema/src/protocol.ts';

/** Convex function-reference names (`<module>:<export>`) of the 7 deployed broker functions. */
export const BROKER_FUNCTIONS = {
  send: 'send:send',
  inbox: 'inbox:inbox',
  ack: 'ack:ack',
  thread: 'thread:thread',
  ping: 'diag:ping',
  issueInvite: 'admin:issueInvite',
  redeem: 'invite:redeem',
} as const;

/** Minimal transport surface — implemented by ConvexHttpClient in prod, faked in tests. */
export interface BrokerTransport {
  mutation(name: string, args: unknown): Promise<unknown>;
  query(name: string, args: unknown): Promise<unknown>;
}

/** ConvexHttpClient-backed transport (production). */
export class ConvexTransport implements BrokerTransport {
  private readonly http: ConvexHttpClient;
  constructor(url: string) {
    this.http = new ConvexHttpClient(url);
  }
  mutation(name: string, args: unknown): Promise<unknown> {
    return this.http.mutation(makeFunctionReference<'mutation'>(name), args as never);
  }
  query(name: string, args: unknown): Promise<unknown> {
    return this.http.query(makeFunctionReference<'query'>(name), args as never);
  }
}

export interface SendParams {
  client_id: string;
  to: string;
  kind: Kind;
  thread_id?: string | null;
  parent_id?: string | null;
  in_reply_to?: string | null;
  repo?: string | null;
  body: string;
  artifacts?: readonly Artifact[];
  consent?: { token: string; granted_via: GrantedVia };
  unfreeze?: boolean;
}

export interface ClientInfo {
  platform: Platform;
  hostname?: string;
  adapter_version: string;
}

export interface BrokerClientOptions {
  url: string;
  token?: string;
  transport?: BrokerTransport;
}

export class BrokerClient {
  readonly url: string;
  private readonly token: string | undefined;
  private readonly transport: BrokerTransport;

  constructor(opts: BrokerClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.transport = opts.transport ?? new ConvexTransport(opts.url);
  }

  private auth(): { token: string } {
    if (!this.token)
      throw new Error('broker client has no agent token (run tenfour join / doctor)');
    return { token: this.token };
  }

  async send(p: SendParams): Promise<SendResponse> {
    const envelope: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      client_id: p.client_id,
      thread_id: p.thread_id ?? null,
      parent_id: p.parent_id ?? null,
      in_reply_to: p.in_reply_to ?? null,
      to: p.to,
      kind: p.kind,
      repo: p.repo ?? null,
      body: p.body,
      artifacts: p.artifacts ?? [],
    };
    const request: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      auth: this.auth(),
      envelope,
    };
    if (p.consent) request.consent = p.consent;
    if (p.unfreeze) request.unfreeze = true;
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.send, { request });
    return SendResponseSchema.parse(raw);
  }

  async inbox(params: {
    cursor?: string | null;
    limit?: number;
    mode?: 'claim' | 'peek';
    holder?: string;
  }): Promise<InboxResponse> {
    const request: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      auth: this.auth(),
      cursor: params.cursor ?? null,
      mode: params.mode ?? 'claim',
    };
    if (params.limit !== undefined) request.limit = params.limit;
    if (params.holder !== undefined) request.holder = params.holder;
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.inbox, { request });
    return InboxResponseSchema.parse(raw);
  }

  async ack(params: {
    message_id: string;
    attempt_id: string;
    state?: 'injected' | 'acked';
  }): Promise<AckResponse> {
    const request = {
      protocol: PROTOCOL_VERSION,
      auth: this.auth(),
      message_id: params.message_id,
      attempt_id: params.attempt_id,
      state: params.state ?? 'acked',
    };
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.ack, { request });
    return AckResponseSchema.parse(raw);
  }

  async thread(params: {
    thread_id: string;
    after_seq?: number;
    limit?: number;
  }): Promise<ThreadResponse> {
    const request: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      auth: this.auth(),
      thread_id: params.thread_id,
    };
    if (params.after_seq !== undefined) request.after_seq = params.after_seq;
    if (params.limit !== undefined) request.limit = params.limit;
    const raw = await this.transport.query(BROKER_FUNCTIONS.thread, { request });
    return ThreadResponseSchema.parse(raw);
  }

  async ping(params: { nonce?: string; mark?: string } = {}): Promise<DiagPingResponse> {
    const request: Record<string, unknown> = { protocol: PROTOCOL_VERSION, auth: this.auth() };
    if (params.nonce !== undefined) request.nonce = params.nonce;
    if (params.mark !== undefined) request.mark = params.mark;
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.ping, { request });
    return DiagPingResponseSchema.parse(raw);
  }

  async issueInvite(params: {
    admin_key: string;
    agent: string;
    ttl_s?: number;
    max_rounds?: number;
    repo_allowlist?: string[];
    note?: string;
  }): Promise<AdminIssueInviteResponse> {
    const request: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      admin_key: params.admin_key,
      agent: params.agent,
    };
    if (params.ttl_s !== undefined) request.ttl_s = params.ttl_s;
    if (params.max_rounds !== undefined) request.max_rounds = params.max_rounds;
    if (params.repo_allowlist !== undefined) request.repo_allowlist = params.repo_allowlist;
    if (params.note !== undefined) request.note = params.note;
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.issueInvite, { request });
    return AdminIssueInviteResponseSchema.parse(raw);
  }

  async redeem(params: { code: string; client_info: ClientInfo }): Promise<InviteRedeemResponse> {
    const request = {
      protocol: PROTOCOL_VERSION,
      code: params.code,
      client_info: params.client_info,
    };
    const raw = await this.transport.mutation(BROKER_FUNCTIONS.redeem, { request });
    return InviteRedeemResponseSchema.parse(raw);
  }
}
