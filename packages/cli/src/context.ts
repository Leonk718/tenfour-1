/**
 * tenfour CLI — shared command context: resolves TENFOUR_HOME, loads config/credentials,
 * and constructs a BrokerClient. Commands that need the network call `requireClient`.
 */

import * as fs from 'node:fs';
import { BrokerClient, type ClientInfo } from '../../adapter/src/client.ts';
import {
  loadConfig,
  loadCredentials,
  loadAdmin,
  type Credentials,
  type Admin,
} from '../../adapter/src/local-config.ts';
import { tenfourPaths, type TenfourPaths } from '../../adapter/src/paths.ts';
import type { TenfourConfig } from '../../schema/src/config.ts';
import type { Platform } from '../../schema/src/protocol.ts';

export const ADAPTER_VERSION = '0.1.0';

export interface CliContext {
  home: string;
  paths: TenfourPaths;
  config?: TenfourConfig;
  credentials?: Credentials;
  admin?: Admin;
}

export function loadCliContext(home?: string, env: NodeJS.ProcessEnv = process.env): CliContext {
  const paths = tenfourPaths(home, env);
  const cfg = loadConfig(home, env);
  const creds = loadCredentials(home, env);
  const admin = loadAdmin(home, env);
  return {
    home: paths.home,
    paths,
    config: cfg.ok ? cfg.value : undefined,
    credentials: creds.ok ? creds.value : undefined,
    admin: admin.ok ? admin.value : undefined,
  };
}

/** Build an authenticated BrokerClient, or throw a local error if config/creds are missing. */
export function requireClient(ctx: CliContext): BrokerClient {
  if (!ctx.config) throw new LocalError('no config.json — run tenfour init or tenfour join first');
  if (!ctx.credentials) throw new LocalError('no credentials.json — run tenfour join first');
  return new BrokerClient({ url: ctx.config.broker_url, token: ctx.credentials.token });
}

/** A recoverable local (non-broker) error → CLI exit 2. */
export class LocalError extends Error {}
/** User aborted at a confirmation → CLI exit 3. */
export class AbortError extends Error {}

export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') {
    try {
      if (fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'))
        return 'wsl';
    } catch {
      /* not WSL */
    }
    if (env.WSL_DISTRO_NAME) return 'wsl';
    return 'linux';
  }
  return 'linux';
}

export function clientInfo(env: NodeJS.ProcessEnv = process.env): ClientInfo {
  return { platform: detectPlatform(env), adapter_version: ADAPTER_VERSION };
}
