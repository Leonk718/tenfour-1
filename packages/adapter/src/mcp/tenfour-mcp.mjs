#!/usr/bin/env node
/**
 * tenfour — the MCP server entry (CLI-MCP §0). `init` copies this to
 * TENFOUR_HOME/bin/tenfour-mcp.mjs and registers it at user scope:
 *   claude mcp add tenfour --scope user -- node "<abs>/bin/tenfour-mcp.mjs"
 * Delegates to server.ts main() (loaded via Node type-stripping). stdout is reserved for
 * the JSON-RPC transport; startup diagnostics go to stderr.
 */
import { main } from './server.ts';

main().catch((e) => {
  process.stderr.write(`tenfour-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
