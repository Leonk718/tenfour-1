/**
 * tenfour adapter — MCP stdio server. Exposes EXACTLY the four tools (B1/B15) over a
 * stdio transport, delegating every call to the pure `handleToolCall`. Standby profile
 * (env TENFOUR_STANDBY=1) additionally restricts tenfour_send to answer/needs_human
 * (DELIVERY DEL-48). All model-facing bytes come from strings.ts / tools.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrokerClient } from '../client.ts';
import { Journal } from '../journal.ts';
import { loadConfig, loadCredentials } from '../local-config.ts';
import { tenfourPaths } from '../paths.ts';
import { STANDBY_KIND_REFUSAL, fmt } from '../strings.ts';
import { TOOL_DEFINITIONS, handleToolCall, type ToolDeps, type ToolResult } from './tools.ts';

const SERVER_NAME = 'tenfour';
const SERVER_VERSION = '0.1.0';

/** Build tool deps from the local config + credentials + journal. Throws on missing setup. */
export function buildDeps(home?: string, env: NodeJS.ProcessEnv = process.env): ToolDeps {
  const cfg = loadConfig(home, env);
  const creds = loadCredentials(home, env);
  if (!cfg.ok) throw new Error(`config unavailable: ${cfg.detail}`);
  if (!creds.ok) throw new Error(`credentials unavailable: ${creds.detail}`);
  const journal = new Journal(tenfourPaths(home, env).journalDir);
  journal.ensure();
  return {
    client: new BrokerClient({ url: cfg.value.broker_url, token: creds.value.token }),
    agent: creds.value.agent,
    journal,
  };
}

/** DELIVERY DEL-48: in standby profile, tenfour_send is limited to answer/needs_human. */
const STANDBY_SEND_KINDS = new Set(['answer', 'needs_human']);

export function createServer(deps: ToolDeps, opts: { standby?: boolean } = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: ToolResult;
    try {
      if (opts.standby && name === 'tenfour_send' && !STANDBY_SEND_KINDS.has(String(args.kind))) {
        result = {
          status: 'error',
          code: 'STANDBY_RESTRICTED',
          what_happened: fmt(STANDBY_KIND_REFUSAL, { kind: String(args.kind) }),
          what_is_true_now: '',
          next_action: '',
          retryable: false,
        };
      } else {
        result = await handleToolCall(deps, name, args);
      }
    } catch (e) {
      result = {
        status: 'error',
        code: 'ADAPTER_FAULT',
        what_happened: `The tenfour adapter hit a local fault: ${(e as Error).message}`,
        what_is_true_now: '',
        next_action: "Tell your human to run 'tenfour doctor'.",
        retryable: false,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

export async function main(home?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deps = buildDeps(home, env);
  const server = createServer(deps, { standby: env.TENFOUR_STANDBY === '1' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
