import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  test: {
    include: ['src/**/*.test.tsx'],
    environment: 'jsdom',
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    // Several Solid harness tests intentionally advance fake timers through 15s watchdog paths.
    // Keep Vitest's own watchdog above that virtual-time ceiling so fake timer advancement cannot
    // fail unrelated later tests.
    testTimeout: 20_000,
  },
});
