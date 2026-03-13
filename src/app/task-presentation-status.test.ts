import { describe, expect, it } from 'vitest';
import { setStore } from '../store/core';
import {
  createTestAgent,
  createTestAgentDef,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';
import {
  getTaskAttentionEntry,
  getTaskDotStatus,
  getTaskPresentationStatus,
} from './task-presentation-status';

describe('task presentation status', () => {
  it('maps waiting-input supervision to a waiting dot and terminal focus', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Proceed? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    });

    expect(getTaskDotStatus('task-1')).toBe('waiting');
    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        dotStatus: 'waiting',
        focusPanel: 'ai-terminal',
        group: 'needs-action',
        reason: 'waiting-input',
      }),
    );
  });

  it('maps idle-at-prompt supervision to a ready dot and prompt focus for non-Hydra agents', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Ready',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    });

    expect(getTaskPresentationStatus('task-1')).toEqual(
      expect.objectContaining({
        attention: expect.objectContaining({
          focusPanel: 'prompt',
          reason: 'ready-for-next-step',
        }),
        dotStatus: 'ready',
      }),
    );
  });

  it('keeps Hydra ready prompts focused on the AI terminal', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({
        def: createTestAgentDef({ id: 'hydra', adapter: 'hydra', name: 'Hydra' }),
      }),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'hydra>',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    });

    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        focusPanel: 'ai-terminal',
        reason: 'ready-for-next-step',
      }),
    );
  });

  it('maps exited-error supervision to a failed dot and failed attention state', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({
        exitCode: 1,
        status: 'exited',
      }),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'failed',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Command failed',
        state: 'exited-error',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    });

    expect(getTaskPresentationStatus('task-1')).toEqual(
      expect.objectContaining({
        attention: expect.objectContaining({
          dotStatus: 'failed',
          reason: 'failed',
        }),
        dotStatus: 'failed',
      }),
    );
  });

  it('falls back to lifecycle and git state when supervision is not yet hydrated', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
      'task-2': createTestTask({
        id: 'task-2',
        agentIds: ['agent-2'],
        worktreePath: '/tmp/project/task-2',
      }),
      'task-3': createTestTask({
        id: 'task-3',
        agentIds: ['agent-3'],
        worktreePath: '/tmp/project/task-3',
      }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({ status: 'running' }),
      'agent-2': createTestAgent({
        id: 'agent-2',
        taskId: 'task-2',
        status: 'paused',
      }),
      'agent-3': createTestAgent({
        id: 'agent-3',
        taskId: 'task-3',
        status: 'exited',
        exitCode: 0,
      }),
    });
    setStore('taskGitStatus', {
      'task-3': {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    expect(getTaskDotStatus('task-1')).toBe('busy');
    expect(getTaskDotStatus('task-2')).toBe('paused');
    expect(getTaskDotStatus('task-3')).toBe('ready');
  });

  it('derives paused and failed attention from backend lifecycle before supervision hydrates', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
      'task-2': createTestTask({
        id: 'task-2',
        agentIds: ['agent-2'],
        worktreePath: '/tmp/project/task-2',
      }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({
        status: 'paused',
      }),
      'agent-2': createTestAgent({
        id: 'agent-2',
        lastOutput: ['spawn failed'],
        signal: 'spawn_failed',
        status: 'exited',
        taskId: 'task-2',
      }),
    });

    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        dotStatus: 'paused',
        reason: 'paused',
        state: 'paused',
      }),
    );
    expect(getTaskAttentionEntry('task-2')).toEqual(
      expect.objectContaining({
        dotStatus: 'failed',
        preview: 'spawn failed',
        reason: 'failed',
        state: 'exited-error',
      }),
    );
  });

  it('lets attention-requiring supervision win over a busy secondary agent', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({
        id: 'agent-2',
      }),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: null,
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Working...',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
      'agent-2': {
        agentId: 'agent-2',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 1_500,
        preview: 'Continue? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 1_500,
      },
    });

    expect(getTaskDotStatus('task-1')).toBe('waiting');
    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        agentId: 'agent-2',
        reason: 'waiting-input',
      }),
    );
  });
});
