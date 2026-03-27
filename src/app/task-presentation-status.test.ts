import { describe, expect, it } from 'vitest';
import { markTaskPromptDispatch } from './task-prompt-dispatch';
import { markAgentOutput } from '../store/taskStatus';
import { noteTerminalFocusedInput } from './terminal-focused-input';
import { setStore } from '../store/core';
import {
  createTestAgent,
  createTestAgentDef,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';
import {
  getTaskActivityStatus,
  getTaskAttentionEntry,
  getTaskDotStatus,
  getTaskPresentationStatus,
} from './task-presentation-status';
import {
  registerTerminalStartupCandidate,
  setTerminalStartupPhase,
} from '../store/terminal-startup';

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

  it('reports recent active output as live task activity', () => {
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
        attentionReason: null,
        isShell: false,
        lastOutputAt: 4_500,
        preview: 'Compiling files...',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 4_500,
      },
    });

    expect(getTaskActivityStatus('task-1', 6_000)).toBe('live');
  });

  it('reports stale active output as idle task activity', () => {
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
        attentionReason: null,
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Compiling files...',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    });

    expect(getTaskActivityStatus('task-1', 3_500)).toBe('idle');
  });

  it('reports startup work as a starting task activity', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'attaching');

    expect(getTaskActivityStatus('task-1')).toBe('starting');
  });

  it('reports a recent prompt dispatch as sending before newer task signals arrive', () => {
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
        updatedAt: 1_000,
      },
    });
    markTaskPromptDispatch('agent-1', 0, 2_000);

    expect(getTaskActivityStatus('task-1', 2_300)).toBe('sending');
  });

  it('uses local terminal output to show live activity before supervision catches up', () => {
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
        attentionReason: null,
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Thinking…',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    });

    markAgentOutput('agent-1', new TextEncoder().encode('streaming output\n'), 'task-1');

    expect(getTaskActivityStatus('task-1', Date.now())).toBe('live');
  });

  it('clears quiet attention when newer local output shows the task is live again', () => {
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
        attentionReason: 'quiet-too-long',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Quiet task',
        state: 'quiet',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    });

    markAgentOutput('agent-1', new TextEncoder().encode('streaming output\n'), 'task-1');

    expect(getTaskActivityStatus('task-1', Date.now())).toBe('live');
    expect(getTaskAttentionEntry('task-1')).toBeNull();
    expect(getTaskDotStatus('task-1')).toBe('busy');
  });

  it('clears sending once newer supervision for the same agent arrives', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    markTaskPromptDispatch('agent-1', 0, 2_000);
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'Proceed? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_100,
      },
    });

    expect(getTaskActivityStatus('task-1', 2_300)).toBe('waiting-input');
  });

  it('clears sending once newer local output for the same agent arrives', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    markTaskPromptDispatch('agent-1', 0, 2_000);

    markAgentOutput('agent-1', new TextEncoder().encode('prompt echoed\n'), 'task-1');

    expect(getTaskActivityStatus('task-1', Date.now())).toBe('live');
  });

  it('uses local terminal output to show live activity before supervision exists', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({ status: 'running' }),
    });

    markAgentOutput('agent-1', new TextEncoder().encode('streaming output\n'), 'task-1');

    expect(getTaskActivityStatus('task-1', Date.now())).toBe('live');
  });

  it('reports prompt-ready supervision as idle and explicit questions as waiting input', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
      'task-2': createTestTask({ id: 'task-2', agentIds: ['agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 2_000,
        preview: 'Ready',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
      'agent-2': {
        agentId: 'agent-2',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 2_500,
        preview: 'Proceed? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-2',
        updatedAt: 2_500,
      },
    });

    expect(getTaskActivityStatus('task-1', 3_000)).toBe('idle');
    expect(getTaskActivityStatus('task-2', 3_000)).toBe('waiting-input');
  });

  it('suppresses waiting-input attention for the agent currently receiving local typing echo', () => {
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
    noteTerminalFocusedInput('task-1', 'agent-1');

    expect(getTaskPresentationStatus('task-1')).toEqual(
      expect.objectContaining({
        attention: null,
        dotStatus: 'busy',
      }),
    );
  });

  it('treats local typing echo as live activity instead of waiting-input for the same agent', () => {
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
    noteTerminalFocusedInput('task-1', 'agent-1');
    markAgentOutput('agent-1', new TextEncoder().encode('y'), 'task-1');

    expect(getTaskActivityStatus('task-1', Date.now())).toBe('live');
  });

  it('suppresses ready attention for the agent currently receiving local typing echo', () => {
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
    noteTerminalFocusedInput('task-1', 'agent-1');

    expect(getTaskPresentationStatus('task-1')).toEqual(
      expect.objectContaining({
        attention: null,
        dotStatus: 'busy',
      }),
    );
  });

  it('does not suppress waiting-input attention for a different agent in the same task', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
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
    noteTerminalFocusedInput('task-1', 'agent-2');

    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        reason: 'waiting-input',
      }),
    );
  });

  it('includes shell supervision when deriving task activity status', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'], shellAgentIds: ['shell-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'shell-1': createTestAgent({ id: 'shell-1' }),
    });
    setStore('agentSupervision', {
      'shell-1': {
        agentId: 'shell-1',
        attentionReason: null,
        isShell: true,
        lastOutputAt: 8_500,
        preview: 'npm run dev',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 8_500,
      },
    });

    expect(getTaskActivityStatus('task-1', 9_500)).toBe('live');
  });

  it('includes shell lifecycle when deriving task presentation status', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'], shellAgentIds: ['shell-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'shell-1': createTestAgent({
        id: 'shell-1',
        status: 'flow-controlled',
      }),
    });

    expect(getTaskDotStatus('task-1')).toBe('flow-controlled');
  });

  it('routes shell attention to the matching shell panel', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'], shellAgentIds: ['shell-1', 'shell-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'shell-1': createTestAgent({ id: 'shell-1' }),
      'shell-2': createTestAgent({ id: 'shell-2' }),
    });
    setStore('agentSupervision', {
      'shell-2': {
        agentId: 'shell-2',
        attentionReason: 'waiting-input',
        isShell: true,
        lastOutputAt: 1_000,
        preview: '$ ',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    });

    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        focusPanel: 'shell:1',
        reason: 'waiting-input',
      }),
    );
  });

  it('prefers live output over a concurrent waiting-input snapshot in the same task', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
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
        updatedAt: 1_000,
      },
      'agent-2': {
        agentId: 'agent-2',
        attentionReason: null,
        isShell: false,
        lastOutputAt: 4_800,
        preview: 'Running task...',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 4_800,
      },
    });

    expect(getTaskActivityStatus('task-1', 5_500)).toBe('live');
  });

  it('prefers live output over unrelated terminal startup in the same task', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1', 'agent-2'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: null,
        isShell: false,
        lastOutputAt: 9_200,
        preview: 'Streaming output',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 9_200,
      },
    });
    registerTerminalStartupCandidate('task-1:agent-2', 'task-1');
    setTerminalStartupPhase('task-1:agent-2', 'binding');

    expect(getTaskActivityStatus('task-1', 10_000)).toBe('live');
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

  it('treats real signal exits as failed before supervision hydrates', () => {
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({
        exitCode: 0,
        id: 'agent-1',
        lastOutput: ['terminated by signal'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    });

    expect(getTaskAttentionEntry('task-1')).toEqual(
      expect.objectContaining({
        dotStatus: 'failed',
        preview: 'terminated by signal',
        reason: 'failed',
        state: 'exited-error',
      }),
    );
    expect(getTaskDotStatus('task-1')).toBe('failed');
    expect(getTaskActivityStatus('task-1')).toBe('failed');
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
