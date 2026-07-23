#!/usr/bin/env node
/**
 * tenfour CLI entry. Delegates to src/cli.ts (loaded via Node's native TypeScript type
 * stripping, Node ≥ 22.6 / ≥ 20 with --experimental-strip-types). Maps the command's
 * numeric result to the process exit code (CLI-MCP §0 CLI-001).
 */
import { main } from '../src/cli.ts';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`tenfour: ${e?.message ?? e}\n`);
    process.exit(2);
  });
