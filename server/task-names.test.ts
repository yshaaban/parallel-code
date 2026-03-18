import { describe, expect, it, vi } from 'vitest';
import { createTaskNameRegistry } from './task-names.js';

describe('createTaskNameRegistry', () => {
  it('loads task names from saved state and falls back to formatted ids', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: { id: 'task-123', name: 'Alpha' },
        },
      }),
    );

    expect(registry.getTaskName('task-123')).toBe('Alpha');
    expect(registry.getTaskName('task-999')).toBe('999');
  });

  it('ignores malformed saved state without replacing existing names', () => {
    const registry = createTaskNameRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.setTaskName('task-123', 'Alpha');
    registry.syncFromSavedState('{');

    expect(registry.getTaskName('task-123')).toBe('Alpha');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('supports direct updates and deletion', () => {
    const registry = createTaskNameRegistry();

    registry.setTaskName('task-123', 'Alpha');
    expect(registry.getTaskName('task-123')).toBe('Alpha');

    registry.deleteTaskName('task-123');
    expect(registry.getTaskName('task-123')).toBe('123');
  });

  it('parses task metadata from saved state', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Build Auth',
            branchName: 'feature/auth',
            worktreePath: '/home/user/project/.worktrees/feature-auth',
            directMode: false,
            lastPrompt: 'implement JWT validation',
            savedAgentDef: { id: 'claude-code', name: 'Claude Code' },
          },
        },
      }),
    );

    const meta = registry.getTaskMetadata('task-1');
    expect(meta).toEqual({
      agentDefId: 'claude-code',
      agentDefName: 'Claude Code',
      branchName: 'feature/auth',
      directMode: false,
      folderName: 'feature-auth',
      lastPrompt: 'implement JWT validation',
    });
  });

  it('returns null metadata for unknown task', () => {
    const registry = createTaskNameRegistry();
    expect(registry.getTaskMetadata('task-unknown')).toBeNull();
  });

  it('truncates long lastPrompt to 120 chars', () => {
    const registry = createTaskNameRegistry();
    const longPrompt = 'a'.repeat(200);

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Test',
            lastPrompt: longPrompt,
          },
        },
      }),
    );

    const meta = registry.getTaskMetadata('task-1');
    expect(meta?.lastPrompt).toHaveLength(120);
    expect(meta?.lastPrompt?.endsWith('…')).toBe(true);
  });

  it('handles missing optional metadata fields gracefully', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: { id: 'task-1', name: 'Minimal' },
        },
      }),
    );

    const meta = registry.getTaskMetadata('task-1');
    expect(meta).toEqual({
      agentDefId: null,
      agentDefName: null,
      branchName: null,
      directMode: false,
      folderName: null,
      lastPrompt: null,
    });
  });

  it('registers created tasks through the registry owner helpers', () => {
    const registry = createTaskNameRegistry();

    registry.registerCreatedTask('task-1', {
      branchName: 'feature/auth',
      directMode: true,
      taskName: 'Auth Task',
      worktreePath: '/tmp/project/.worktrees/auth-task',
    });

    expect(registry.getTaskName('task-1')).toBe('Auth Task');
    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: null,
      agentDefName: null,
      branchName: 'feature/auth',
      directMode: true,
      folderName: 'auth-task',
      lastPrompt: null,
    });

    registry.deleteTask('task-1');
    expect(registry.getTaskName('task-1')).toBe('1');
    expect(registry.getTaskMetadata('task-1')).toBeNull();
  });

  it('supports direct metadata updates and deletion', () => {
    const registry = createTaskNameRegistry();

    registry.setTaskMetadata('task-1', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'main',
      directMode: true,
      folderName: 'project',
      lastPrompt: 'fix bug',
    });

    expect(registry.getTaskMetadata('task-1')?.agentDefId).toBe('codex');

    registry.deleteTaskMetadata('task-1');
    expect(registry.getTaskMetadata('task-1')).toBeNull();
  });

  it('treats empty lastPrompt as null', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: { id: 'task-1', name: 'Test', lastPrompt: '   ' },
        },
      }),
    );

    expect(registry.getTaskMetadata('task-1')?.lastPrompt).toBeNull();
  });
});
