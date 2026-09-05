import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      'src/app/terminal-attach-scheduler.benchmark.ts',
      'src/app/terminal-output-scheduler.benchmark.ts',
      'src/app/task-git-action-capability.benchmark.ts',
      'src/components/terminal-view/terminal-output-history.benchmark.ts',
      'src/components/terminal-view/terminal-output-pipeline.benchmark.ts',
      'src/components/new-task-dialog/new-task-draft.benchmark.ts',
      'src/components/task-notes/task-notes-controller.benchmark.ts',
      'src/domain/new-task-defaults.benchmark.ts',
      'src/lib/scrollbackRestore.benchmark.ts',
      'src/lib/terminal-links.benchmark.ts',
      'src/lib/webglPool.benchmark.ts',
      'src/store/agent-output-activity.benchmark.ts',
      'server/task-content-authority-coordinator.benchmark.ts',
    ],
  },
});
