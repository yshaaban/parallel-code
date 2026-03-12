import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'electron/**/*.test.ts',
      'server/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
