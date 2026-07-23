/**
 * tenfour — local config / credentials / admin-key file schemas and loaders
 * (CLI-MCP §0 CLI-003). `config.json` is owned by `packages/schema/src/config.ts`
 * (`TenfourConfigSchema`); this module adds the credential and admin-key file shapes
 * and typed load/save helpers layered on `secure-file.ts`.
 */

import * as fs from 'node:fs';
import { z } from 'zod';
import {
  AgentNameSchema,
  UlidSchema,
  BEARER_TOKEN_REGEX,
  ADMIN_KEY_REGEX,
} from '../../schema/src/protocol.ts';
import { TenfourConfigSchema, type TenfourConfig } from '../../schema/src/config.ts';
import { writeSecureFile } from './secure-file.ts';
import { tenfourPaths } from './paths.ts';

/** `credentials.json` — the agent bearer token (plaintext locally; hashed at rest on broker). */
export const CredentialsSchema = z
  .object({
    agent: AgentNameSchema,
    token: z.string().regex(BEARER_TOKEN_REGEX, 'agent bearer token (tf1_…)'),
    token_id: UlidSchema.optional(),
    peer: AgentNameSchema.optional(),
    /** Prior token during the AUTH ROT-1 rotation overlap window (10 min / first new-token call). */
    prev_token: z.string().regex(BEARER_TOKEN_REGEX).optional(),
    rotation_deadline: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Credentials = z.infer<typeof CredentialsSchema>;

/** `admin.json` — the broker admin key (owner machine only, `--create-broker`). */
export const AdminSchema = z
  .object({
    admin_key: z.string().regex(ADMIN_KEY_REGEX, 'admin key (tfadmin_…)'),
    broker_url: z.string().regex(/^https:\/\//, 'broker_url must be https'),
  })
  .strict();
export type Admin = z.infer<typeof AdminSchema>;

export type LoadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'unparseable' | 'invalid'; detail: string };

function loadJson<T>(file: string, schema: z.ZodType<T>): LoadResult<T> {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', detail: `not found: ${file}` };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'unparseable', detail: `${file}: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', detail: `${file}: ${parsed.error.issues[0]?.message ?? 'schema error'}` };
  }
  return { ok: true, value: parsed.data };
}

export function loadConfig(home?: string, env: NodeJS.ProcessEnv = process.env): LoadResult<TenfourConfig> {
  return loadJson(tenfourPaths(home, env).configJson, TenfourConfigSchema);
}

export function loadCredentials(home?: string, env: NodeJS.ProcessEnv = process.env): LoadResult<Credentials> {
  return loadJson(tenfourPaths(home, env).credentialsJson, CredentialsSchema);
}

export function loadAdmin(home?: string, env: NodeJS.ProcessEnv = process.env): LoadResult<Admin> {
  return loadJson(tenfourPaths(home, env).adminJson, AdminSchema);
}

export function saveConfig(config: TenfourConfig, home?: string, env: NodeJS.ProcessEnv = process.env): void {
  writeSecureFile(tenfourPaths(home, env).configJson, JSON.stringify(config, null, 2) + '\n');
}

export function saveCredentials(creds: Credentials, home?: string, env: NodeJS.ProcessEnv = process.env): void {
  writeSecureFile(tenfourPaths(home, env).credentialsJson, JSON.stringify(creds, null, 2) + '\n');
}

export function saveAdmin(admin: Admin, home?: string, env: NodeJS.ProcessEnv = process.env): void {
  writeSecureFile(tenfourPaths(home, env).adminJson, JSON.stringify(admin, null, 2) + '\n');
}
