import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';

const external = [
  'zod',
  'convex',
  'convex/browser',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
];
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external,
  logLevel: 'info',
};

await mkdir('packages/cli/dist', { recursive: true });
await build({
  ...common,
  entryPoints: ['packages/cli/src/cli.ts'],
  outfile: 'packages/cli/dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  ...common,
  entryPoints: ['packages/adapter/src/mcp/server.ts'],
  outfile: 'packages/cli/dist/mcp.mjs',
});
await build({
  ...common,
  entryPoints: ['packages/adapter/src/hooks/run.ts'],
  outfile: 'packages/cli/dist/hooks.mjs',
});
await chmod('packages/cli/dist/cli.mjs', 0o755);
console.log('build ok: cli.mjs, mcp.mjs, hooks.mjs');
