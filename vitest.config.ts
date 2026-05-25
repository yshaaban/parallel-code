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
    setupFiles: ['./vitest.node.setup.ts'],
    // Node tests intentionally advance fake timers through retry and watchdog paths up to 30s.
    // Keep Vitest's own watchdog above that virtual-time ceiling so fake timer advancement cannot
    // fail unrelated later tests.
    testTimeout: 35_000,
  },
});
