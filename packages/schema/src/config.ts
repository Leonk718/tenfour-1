/**
 * tenfour — canonical Zod schema for the local config file
 * `~/.tenfour/config.json` (`%USERPROFILE%\.tenfour\config.json` on Windows;
 * `$TENFOUR_HOME/config.json` when set).
 *
 * THE single source of truth for config keys. CONSENT.md §8, ARTIFACTS.md §8/§10,
 * DELIVERY.md §12, and CLI-MCP-MANIFEST.md §0 reference this file; if their prose
 * and this file disagree, this file wins.
 *
 * File-permission doctrine: 0600 (POSIX) / icacls inheritance-strip + sole-user
 * grant (Windows) — the SAME doctrine as credentials.json. `tenfour doctor`
 * fails on wider permissions.
 */

import { z } from 'zod';
import { AgentNameSchema, RepoSlugSchema } from './protocol.js';

/** Array elements must be unique (byte equality). */
const isUnique = <T>(arr: readonly T[]): boolean => new Set(arr).size === arr.length;

/** Absolute filesystem path (POSIX `/…` or Windows drive/UNC form). */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, 'workspaces[] entries must be absolute paths');

/**
 * Standing rules — the ONLY form of pre-declared consent (R9; CONSENT.md §8).
 * Exact values only: no globs, no wildcards in tenfour/1.
 */
export const StandingRulesSchema = z
  .object({
    /**
     * Permit the adapter (standby duty-officer per R1c, and mid-turn per R1a) to
     * answer inbound `kind: question` messages without surfacing first.
     * Questions only — never tasks, never any other kind.
     */
    auto_answer_questions: z.boolean().default(false),
    /**
     * Senders whose tasks may be auto-accepted (full agent names, e.g.
     * "brian/design"). Exact full-name matches only. Auto-acceptance
     * additionally requires the task repo ∈ allowed_repos AND a tagged
     * workspace (CONSENT.md §8.2), and records granted_via "standing_rule".
     */
    auto_accept_from: z
      .array(AgentNameSchema)
      .refine(isUnique, 'auto_accept_from entries must be unique')
      .default([]),
  })
  .strict();

export const TenfourConfigSchema = z
  .object({
    /** Broker base URL (https). */
    broker_url: z.string().max(300).regex(/^https:\/\//, 'broker_url must be https'),
    /** This machine's agent name (e.g. "jonathan/web"). */
    agent: AgentNameSchema,
    /** The paired peer's agent name. */
    peer: AgentNameSchema,
    /**
     * Absolute paths of repos designated as tenfour workspaces
     * (`tenfour init --workspace`). The adapter derives each workspace's
     * canonical repo-id (host/owner/name) from its `origin` remote; the
     * ancestor check (ARTIFACTS §8) resolves artifact repos against this list.
     */
    workspaces: z
      .array(AbsolutePathSchema)
      .refine(isUnique, 'workspaces entries must be unique')
      .default([]),
    /**
     * Receive allowlist: canonical three-segment repo slugs
     * (host/owner/name, lowercase — protocol.ts RepoSlugSchema). Evaluated at
     * surface time by the receiving adapter (ARTIFACTS §10). Exact byte
     * equality; no wildcards in tenfour/1.
     */
    allowed_repos: z
      .array(RepoSlugSchema)
      .refine(isUnique, 'allowed_repos entries must be unique')
      .default([]),
    standing_rules: StandingRulesSchema.default({
      auto_answer_questions: false,
      auto_accept_from: [],
    }),
  })
  .strict();

export type StandingRules = z.infer<typeof StandingRulesSchema>;
export type TenfourConfig = z.infer<typeof TenfourConfigSchema>;
export type TenfourConfigInput = z.input<typeof TenfourConfigSchema>;
