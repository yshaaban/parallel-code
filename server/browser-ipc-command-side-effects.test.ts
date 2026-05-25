import { describe, expect, it, vi } from 'vitest';

import { IPC } from '../electron/ipc/channels.js';
import {
  runBrowserIpcCommandSideEffects,
  type BrowserIpcCommandSideEffectContext,
} from './browser-ipc-command-side-effects.js';
import { createTaskNameRegistry } from './task-names.js';

function createContext(): BrowserIpcCommandSideEffectContext {
  return {
    broadcastControl: vi.fn(),
    emitGitStatusChanged: vi.fn(),
    removeGitStatus: vi.fn(),
    taskNames: createTaskNameRegistry(),
  };
}

describe('browser IPC command side effects', () => {
  it('syncs saved task names only from string app-state payloads', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.SaveAppState,
      {
        json: JSON.stringify({
          tasks: {
            'task-1': {
              id: 'task-1',
              name: 'Saved task',
            },
          },
        }),
      },
      undefined,
    );
    runBrowserIpcCommandSideEffects(context, IPC.SaveAppState, { json: null }, undefined);

    expect(context.taskNames.getTaskName('task-1')).toBe('Saved task');
  });

  it('emits branch-scoped git refreshes for merge, arena merge, and push commands', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.MergeTask,
      {
        branchName: 'feature/task-1',
        projectRoot: '/repo',
      },
      undefined,
    );
    runBrowserIpcCommandSideEffects(
      context,
      IPC.MergeArenaWorktree,
      {
        branchName: 'arena/run-1',
        projectRoot: '/repo',
      },
      undefined,
    );
    runBrowserIpcCommandSideEffects(
      context,
      IPC.PushTask,
      {
        branchName: 'feature/task-2',
        projectRoot: '/repo',
      },
      undefined,
    );

    expect(context.emitGitStatusChanged).toHaveBeenCalledWith({
      branchName: 'feature/task-1',
      projectRoot: '/repo',
    });
    expect(context.emitGitStatusChanged).toHaveBeenCalledWith({
      branchName: 'arena/run-1',
      projectRoot: '/repo',
    });
    expect(context.emitGitStatusChanged).toHaveBeenCalledWith({
      branchName: 'feature/task-2',
      projectRoot: '/repo',
    });
  });

  it('broadcasts task removal when cleanup_task_runtime removes task state', () => {
    const context = createContext();
    context.taskNames.registerCreatedTask('task-1', {
      branchName: 'main',
      taskName: 'Current branch task',
      worktreePath: '/repo',
      worktreeOwnership: 'managed',
    });

    runBrowserIpcCommandSideEffects(
      context,
      IPC.CleanupTaskRuntime,
      {
        removeTaskState: true,
        taskId: 'task-1',
        worktreePath: '/repo',
      },
      undefined,
    );

    expect(context.taskNames.getTaskMetadata('task-1')).toBeNull();
    expect(context.broadcastControl).toHaveBeenCalledWith({
      type: 'task-event',
      event: 'deleted',
      taskId: 'task-1',
      worktreePath: '/repo',
    });
    expect(context.emitGitStatusChanged).toHaveBeenCalledWith({
      worktreePath: '/repo',
    });
    expect(context.removeGitStatus).toHaveBeenCalledWith('/repo');
  });

  it('does not emit git-status refreshes for non-git cleanup removal', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.CleanupTaskRuntime,
      {
        projectMode: 'non-git',
        removeTaskState: true,
        taskId: 'task-1',
        worktreePath: '/tmp/folder',
      },
      undefined,
    );

    expect(context.broadcastControl).toHaveBeenCalledWith({
      type: 'task-event',
      event: 'deleted',
      taskId: 'task-1',
      worktreePath: '/tmp/folder',
    });
    expect(context.emitGitStatusChanged).not.toHaveBeenCalled();
    expect(context.removeGitStatus).not.toHaveBeenCalled();
  });

  it('falls back to requested git isolation when created task results omit optional metadata', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.CreateTask,
      {
        gitIsolation: 'existing-worktree',
        name: 'Import worktree',
      },
      {
        branch_name: 'feature/imported',
        id: 'task-1',
        worktree_path: '/repo/existing',
      },
    );

    expect(context.taskNames.getTaskMetadata('task-1')).toMatchObject({
      branchName: 'feature/imported',
      directMode: false,
      folderName: 'existing',
      gitIsolation: 'existing-worktree',
      worktreeOwnership: 'external',
    });
  });

  it('marks current-branch tasks as externally owned direct-mode worktrees', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.CreateTask,
      {
        gitIsolation: 'current-branch',
        name: 'Direct task',
      },
      {
        branch_name: 'main',
        git_isolation: 'current-branch',
        id: 'task-1',
        worktree_path: '/repo',
      },
    );

    expect(context.taskNames.getTaskMetadata('task-1')).toMatchObject({
      directMode: true,
      gitIsolation: 'current-branch',
      worktreeOwnership: 'external',
    });
  });

  it('does not broadcast task removal for cleanup_task_runtime best-effort cleanup', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(
      context,
      IPC.CleanupTaskRuntime,
      {
        removeTaskState: false,
        taskId: 'task-1',
      },
      undefined,
    );

    expect(context.broadcastControl).not.toHaveBeenCalled();
    expect(context.emitGitStatusChanged).not.toHaveBeenCalled();
    expect(context.removeGitStatus).not.toHaveBeenCalled();
  });

  it('ignores unrelated channels', () => {
    const context = createContext();

    runBrowserIpcCommandSideEffects(context, IPC.LoadAppState, {}, { ok: true });

    expect(context.broadcastControl).not.toHaveBeenCalled();
    expect(context.emitGitStatusChanged).not.toHaveBeenCalled();
    expect(context.removeGitStatus).not.toHaveBeenCalled();
  });
});
