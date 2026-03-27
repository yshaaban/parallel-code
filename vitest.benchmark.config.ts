import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      'src/app/terminal-attach-scheduler.benchmark.ts',
      'src/app/terminal-output-scheduler.benchmark.ts',
      'src/components/terminal-view/terminal-output-history.benchmark.ts',
      'src/components/terminal-view/terminal-output-pipeline.benchmark.ts',
      'src/lib/scrollbackRestore.benchmark.ts',
      'src/store/agent-output-activity.benchmark.ts',
    ],
  },
});
