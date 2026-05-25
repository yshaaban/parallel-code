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

  it('ignores malformed saved task containers without replacing existing names', () => {
    const registry = createTaskNameRegistry();

    registry.setTaskName('task-123', 'Alpha');
    registry.syncFromSavedState(JSON.stringify({ tasks: null }));
    registry.syncFromSavedState(JSON.stringify({ tasks: [null] }));
    registry.syncFromSavedState(JSON.stringify({ tasks: { one: null } }));

    expect(registry.getTaskName('task-123')).toBe('Alpha');
  });

  it('skips malformed saved task entries while loading valid neighbors', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          broken: null,
          one: { id: 'task-123', name: 'Alpha' },
          two: [],
        },
      }),
    );

    expect(registry.getTaskName('task-123')).toBe('Alpha');
    expect(registry.getTaskName('task-broken')).toBe('broken');
  });

  it('supports direct updates and deletion', () => {
    const registry = createTaskNameRegistry();

    registry.setTaskName('task-123', 'Alpha');
    expect(registry.getTaskName('task-123')).toBe('Alpha');

    registry.deleteTaskName('task-123');
    expect(registry.getTaskName('task-123')).toBe('123');
  });

  it('parses task metadata from the current persisted agentDef shape', () => {
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
            worktreeOwnership: 'external',
            agentDef: { id: 'claude-code', name: 'Claude Code' },
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
      worktreeOwnership: 'external',
    });
  });

  it('supports the legacy savedAgentDef persisted shape', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Build Auth',
            savedAgentDef: { id: 'claude-code', name: 'Claude Code' },
          },
        },
      }),
    );

    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: 'claude-code',
      agentDefName: 'Claude Code',
      branchName: null,
      directMode: false,
      folderName: null,
      lastPrompt: null,
    });
  });

  it('overlays saved per-agent definitions for mixed-agent tasks', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Build Auth',
            agentIds: ['agent-codex', 'agent-gemini'],
            agentDefs: [
              { id: 'codex', name: 'Codex CLI' },
              { id: 'gemini', name: 'Gemini CLI' },
            ],
            branchName: 'feature/auth',
            worktreePath: '/home/user/project/.worktrees/feature-auth',
            savedAgentDef: { id: 'codex', name: 'Codex CLI' },
          },
        },
      }),
    );

    expect(registry.getTaskMetadata('task-1', 'agent-codex')).toMatchObject({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'feature/auth',
      folderName: 'feature-auth',
    });
    expect(registry.getTaskMetadata('task-1', 'agent-gemini')).toMatchObject({
      agentDefId: 'gemini',
      agentDefName: 'Gemini CLI',
      branchName: 'feature/auth',
      folderName: 'feature-auth',
    });
  });

  it('keeps per-agent metadata aligned when saved agent id entries are malformed', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Build Auth',
            agentIds: ['agent-codex', null, 'agent-gemini'],
            agentDefs: [
              { id: 'codex', name: 'Codex CLI' },
              { id: 'invalid', name: 'Invalid CLI' },
              { id: 'gemini', name: 'Gemini CLI' },
            ],
            branchName: 'feature/auth',
            worktreePath: '/home/user/project/.worktrees/feature-auth',
            savedAgentDef: { id: 'codex', name: 'Codex CLI' },
          },
        },
      }),
    );

    expect(registry.getTaskMetadata('task-1', 'agent-codex')?.agentDefId).toBe('codex');
    expect(registry.getTaskMetadata('task-1', 'agent-gemini')?.agentDefId).toBe('gemini');
  });

  it('prefers explicit git isolation metadata when it is available', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: {
            id: 'task-1',
            name: 'Direct Task',
            branchName: 'main',
            directMode: false,
            gitIsolation: 'current-branch',
            worktreePath: '/home/user/project',
          },
        },
      }),
    );

    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: null,
      agentDefName: null,
      branchName: 'main',
      directMode: true,
      folderName: 'project',
      gitIsolation: 'current-branch',
      lastPrompt: null,
    });
  });

  it('registers explicit git isolation for newly created remote tasks', () => {
    const registry = createTaskNameRegistry();

    registry.registerCreatedTask('task-1', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'task/imported',
      directMode: false,
      gitIsolation: 'existing-worktree',
      taskName: 'Imported Task',
      worktreePath: '/tmp/imported',
      worktreeOwnership: 'external',
    });

    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'task/imported',
      directMode: false,
      folderName: 'imported',
      gitIsolation: 'existing-worktree',
      lastPrompt: null,
      worktreeOwnership: 'external',
    });
  });

  it('registers non-git project metadata explicitly', () => {
    const registry = createTaskNameRegistry();

    registry.registerCreatedTask('task-1', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: '',
      directMode: false,
      projectMode: 'non-git',
      taskName: 'Folder Task',
      worktreePath: '/tmp/folder',
      worktreeOwnership: null,
    });

    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: '',
      directMode: false,
      folderName: 'folder',
      lastPrompt: null,
      projectMode: 'non-git',
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
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'feature/auth',
      directMode: true,
      taskName: 'Auth Task',
      worktreePath: '/tmp/project/.worktrees/auth-task',
    });

    expect(registry.getTaskName('task-1')).toBe('Auth Task');
    expect(registry.getTaskMetadata('task-1')).toEqual({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
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
      worktreeOwnership: 'external',
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
