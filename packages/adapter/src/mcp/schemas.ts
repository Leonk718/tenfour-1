/**
 * tenfour adapter — MCP tool input schemas (CLI-MCP §2). EXACTLY four tools. Each input
 * schema sets `additionalProperties:false`; unknown properties fail locally with a
 * teaching message and never reach the broker. `client_id` is NEVER a tool input — the
 * adapter mints it (JOURNEYS §4).
 *
 * The JSON Schemas below feed `tools/list`; the Zod validators enforce them at call time.
 */

import { z } from 'zod';
import {
  KINDS,
  KindSchema,
  AgentNameSchema,
  UlidSchema,
  RepoSlugSchema,
  ArtifactSchema,
} from '../../../schema/src/protocol.ts';

export const WAIT_TIMEOUT_DEFAULT = 300;
export const WAIT_TIMEOUT_MIN = 10;
export const WAIT_TIMEOUT_MAX = 600;

// ── Zod validators (runtime) ──────────────────────────────────────────────────

export const TenfourSendInputSchema = z
  .object({
    to: AgentNameSchema,
    kind: KindSchema,
    thread_id: UlidSchema.nullable().optional(),
    in_reply_to: UlidSchema.nullable().optional(),
    repo: RepoSlugSchema.nullable().optional(),
    body: z.string(),
    artifacts: z.array(ArtifactSchema).optional(),
  })
  .strict();
export type TenfourSendInput = z.infer<typeof TenfourSendInputSchema>;

export const TenfourAckInputSchema = z
  .object({ message_id: UlidSchema, attempt_id: UlidSchema })
  .strict();
export type TenfourAckInput = z.infer<typeof TenfourAckInputSchema>;

export const TenfourThreadInputSchema = z.object({ thread_id: UlidSchema }).strict();
export type TenfourThreadInput = z.infer<typeof TenfourThreadInputSchema>;

export const TenfourWaitInputSchema = z
  .object({
    thread_id: UlidSchema,
    timeout_s: z
      .number()
      .int()
      .min(WAIT_TIMEOUT_MIN)
      .max(WAIT_TIMEOUT_MAX)
      .default(WAIT_TIMEOUT_DEFAULT),
  })
  .strict();
export type TenfourWaitInput = z.infer<typeof TenfourWaitInputSchema>;

// ── JSON Schemas (tools/list) ─────────────────────────────────────────────────

const ULID_PATTERN = '^[0-7][0-9A-HJKMNP-TV-Z]{25}$';

const ARTIFACT_JSON_SCHEMA = {
  type: 'object',
  description: 'A git_commit, git_branch, or pull_request artifact (ARTIFACTS §1).',
  additionalProperties: true,
} as const;

export const TENFOUR_SEND_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'kind', 'body'],
  properties: {
    to: { type: 'string', description: 'The paired peer agent name (user/agent).' },
    kind: {
      type: 'string',
      enum: [...KINDS],
      description: "One of the ten kinds. 'accepted' is rejected here.",
    },
    thread_id: {
      type: ['string', 'null'],
      pattern: ULID_PATTERN,
      description: 'Thread ULID, or null to open (task/question only).',
    },
    in_reply_to: {
      type: ['string', 'null'],
      pattern: ULID_PATTERN,
      description: 'REQUIRED for kind=answer: the id of the question being answered.',
    },
    repo: { type: ['string', 'null'], description: 'Canonical repo-id; REQUIRED iff kind=task.' },
    body: { type: 'string', description: 'Markdown body, <= 16 KB.' },
    artifacts: {
      type: 'array',
      items: ARTIFACT_JSON_SCHEMA,
      description: 'Optional artifacts (result requires >= 1 sha-pinned).',
    },
  },
} as const;

export const TENFOUR_ACK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message_id', 'attempt_id'],
  properties: {
    message_id: { type: 'string', pattern: ULID_PATTERN, description: 'The delivered message id.' },
    attempt_id: {
      type: 'string',
      pattern: ULID_PATTERN,
      description: 'The delivery attempt id from the wrapper.',
    },
  },
} as const;

export const TENFOUR_THREAD_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thread_id'],
  properties: {
    thread_id: { type: 'string', pattern: ULID_PATTERN, description: 'The thread ULID.' },
  },
} as const;

export const TENFOUR_WAIT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thread_id'],
  properties: {
    thread_id: { type: 'string', pattern: ULID_PATTERN, description: 'The thread to wait on.' },
    timeout_s: {
      type: 'integer',
      minimum: WAIT_TIMEOUT_MIN,
      maximum: WAIT_TIMEOUT_MAX,
      default: WAIT_TIMEOUT_DEFAULT,
      description: 'Block up to this many seconds (default 300).',
    },
  },
} as const;
