import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'edge-runtime',
    globals: false,
  },
});
