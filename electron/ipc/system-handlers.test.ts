import { describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import { createSystemIpcHandlers } from './system-handlers.js';
import type { HandlerContext } from './handler-context.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

function buildOptions(): {
  getTaskName: (taskId: string) => string;
  syncProjectBaseBranchesFromJson: (json: string) => void;
  syncTaskConvergenceFromJson: (json: string) => void;
  syncTaskNamesFromJson: (json: string) => void;
} {
  return {
    getTaskName: (taskId: string) => taskId,
    syncProjectBaseBranchesFromJson: vi.fn(),
    syncTaskConvergenceFromJson: vi.fn(),
    syncTaskNamesFromJson: vi.fn(),
  };
}

describe('CheckPathsExist', () => {
  it('marks invalid paths false instead of failing the entire batch', () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const validPath = process.cwd();

    const result = handlers[IPC.CheckPathsExist]?.({
      paths: [validPath, 'relative/path', '/tmp/../bad'],
    }) as Record<string, boolean>;

    expect(result).toEqual({
      [validPath]: true,
      'relative/path': false,
      '/tmp/../bad': false,
    });
  });
});
