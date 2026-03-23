import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';

vi.mock('./client-id', () => ({
  getRemoteClientId: vi.fn(() => 'remote-client-1234'),
}));

import {
  applyRemoteIpcEvent,
  applyRemoteStateBootstrap,
  applyRemoteTaskCommandControllerChanged,
  clearIncomingRemoteTakeoverRequests,
  getIncomingRemoteTakeoverRequests,
  getRemoteTaskCommandController,
  getRemoteControllingTaskIds,
  getRemoteTaskControllerOwnerStatus,
  getRemoteTaskOwnerStatus,
  getRemoteTaskPresenceOwnerStatus,
  replaceRemotePeerPresences,
  resetRemoteCollaborationStateForTests,
  subscribeRemoteTaskCommandControllerChanges,
  upsertIncomingRemoteTakeoverRequest,
} from './remote-collaboration';
import {
  getRemoteAgentSupervision,
  getRemoteTaskPorts,
  getRemoteTaskReview,
} from './remote-task-state';

describe('remote collaboration state', () => {
  beforeEach(() => {
    resetRemoteCollaborationStateForTests();
  });

  afterEach(() => {
    resetRemoteCollaborationStateForTests();
  });

  it('derives controlled task ids from backend task-command controller truth', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      taskId: 'task-1',
      version: 1,
    });

    expect(getRemoteControllingTaskIds()).toEqual(['task-1']);
    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
  });

  it('uses peer presence only for display cues when controller snapshots have not arrived yet', () => {
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'remote-terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toBeNull();
    expect(getRemoteTaskPresenceOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
  });

  it('treats the desktop terminal panel as a typing surface for presence-backed cues', () => {
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
  });

  it('ignores stale controller change events that arrive after a newer snapshot', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-old',
      taskId: 'task-1',
      version: 4,
    });

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      isSelf: false,
      label: 'Another session typing',
    });
  });

  it('applies remote task-command controller ipc-events through the explicit live-event classifier', () => {
    applyRemoteIpcEvent(IPC.TaskCommandControllerChanged, {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 1,
    });

    expect(getRemoteTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 1,
    });
  });

  it('applies agent supervision and task review live events through the explicit classifier', () => {
    applyRemoteIpcEvent(IPC.AgentSupervisionChanged, {
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      kind: 'snapshot',
      lastOutputAt: 10,
      preview: 'Continue?',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 20,
    });
    applyRemoteIpcEvent(IPC.TaskReviewChanged, {
      branchName: 'feature/review',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 30,
      worktreePath: '/tmp/task-1',
    });

    expect(getRemoteAgentSupervision('agent-1')?.state).toBe('awaiting-input');
    expect(getRemoteTaskReview('task-1')?.revisionId).toBe('rev-1');
  });

  it('ignores malformed or forward-incompatible agent supervision payloads', () => {
    applyRemoteIpcEvent(IPC.AgentSupervisionChanged, {
      kind: 'snapshot',
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      lastOutputAt: 10,
      preview: 'Continue?',
      state: 'mystery-state',
      taskId: 'task-1',
      updatedAt: 20,
    });

    expect(getRemoteAgentSupervision('agent-1')).toBeNull();
  });

  it('ignores malformed live payloads that would create impossible remote state', () => {
    applyRemoteIpcEvent(IPC.AgentSupervisionChanged, {
      agentId: 'agent-1',
      removed: true,
      taskId: 'task-1',
    });
    applyRemoteIpcEvent(IPC.TaskReviewChanged, {
      branchName: 'feature/review',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'stale-cache',
      taskId: 'task-1',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 30,
      worktreePath: '/tmp/task-1',
    });

    expect(getRemoteAgentSupervision('agent-1')).toBeNull();
    expect(getRemoteTaskReview('task-1')).toBeNull();
  });

  it('ignores malformed task review files with impossible statuses or non-finite counts', () => {
    applyRemoteIpcEvent(IPC.TaskReviewChanged, {
      branchName: 'feature/review',
      files: [
        {
          committed: false,
          lines_added: 1,
          lines_removed: 0,
          path: 'src/valid.ts',
          status: 'stale-cache',
        },
      ],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 1,
      totalRemoved: 0,
      updatedAt: 30,
      worktreePath: '/tmp/task-1',
    });
    applyRemoteIpcEvent(IPC.TaskReviewChanged, {
      branchName: 'feature/review',
      files: [
        {
          committed: false,
          lines_added: Number.NaN,
          lines_removed: 0,
          path: 'src/valid.ts',
          status: 'M',
        },
      ],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-2',
      totalAdded: 1,
      totalRemoved: 0,
      updatedAt: 31,
      worktreePath: '/tmp/task-2',
    });

    expect(getRemoteTaskReview('task-1')).toBeNull();
    expect(getRemoteTaskReview('task-2')).toBeNull();
  });

  it('ignores non-finite numeric live payloads that would poison ordering state', () => {
    applyRemoteIpcEvent(IPC.AgentSupervisionChanged, {
      kind: 'snapshot',
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      lastOutputAt: 10,
      preview: 'Continue?',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: Number.NaN,
    });
    applyRemoteIpcEvent(IPC.TaskCommandControllerChanged, {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: Number.NaN,
    });

    expect(getRemoteAgentSupervision('agent-1')).toBeNull();
    expect(getRemoteTaskCommandController('task-1')).toBeNull();
  });

  it('explicitly ignores live ipc-event channels that the remote UI does not consume yet', () => {
    const listener = vi.fn();
    const cleanup = subscribeRemoteTaskCommandControllerChanges(listener);
    const ignoredChannels = [IPC.GitStatusChanged, IPC.TaskConvergenceChanged] as const;

    for (const channel of ignoredChannels) {
      applyRemoteIpcEvent(channel, {});
    }

    expect(getRemoteTaskCommandController('task-1')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    cleanup();
  });

  it('ignores malformed task-command controller ipc-event payloads', () => {
    applyRemoteIpcEvent(IPC.TaskCommandControllerChanged, {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: '1',
    });

    expect(getRemoteTaskCommandController('task-1')).toBeNull();
  });

  it('ignores stale task-controller bootstrap payloads', () => {
    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-new',
            taskId: 'task-1',
            version: 5,
          },
        ],
        version: 5,
      },
    ]);
    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-old',
            taskId: 'task-1',
            version: 4,
          },
        ],
        version: 4,
      },
    ]);

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      isSelf: false,
      label: 'Another session typing',
    });
  });

  it('hydrates agent supervision, task review, and task ports from remote bootstrap state', () => {
    applyRemoteStateBootstrap([
      {
        category: 'agent-supervision',
        mode: 'replace',
        payload: [
          {
            agentId: 'agent-1',
            attentionReason: 'ready-for-next-step',
            isShell: false,
            lastOutputAt: 10,
            preview: 'Ready',
            state: 'idle-at-prompt',
            taskId: 'task-1',
            updatedAt: 20,
          },
        ],
        version: 1,
      },
      {
        category: 'task-review',
        mode: 'replace',
        payload: [
          {
            branchName: 'feature/review',
            files: [],
            projectId: 'project-1',
            revisionId: 'rev-1',
            source: 'worktree',
            taskId: 'task-1',
            totalAdded: 0,
            totalRemoved: 0,
            updatedAt: 20,
            worktreePath: '/tmp/task-1',
          },
        ],
        version: 1,
      },
      {
        category: 'task-ports',
        mode: 'replace',
        payload: [
          {
            exposed: [],
            observed: [],
            taskId: 'task-1',
            updatedAt: 20,
          },
        ],
        version: 1,
      },
    ]);

    expect(getRemoteAgentSupervision('agent-1')?.state).toBe('idle-at-prompt');
    expect(getRemoteTaskReview('task-1')?.revisionId).toBe('rev-1');
    expect(getRemoteTaskPorts('task-1')?.updatedAt).toBe(20);
  });

  it('filters malformed remote bootstrap entries instead of hydrating impossible state', () => {
    const snapshots = [
      {
        category: 'agent-supervision',
        mode: 'replace',
        payload: [
          {
            agentId: 'agent-good',
            attentionReason: 'ready-for-next-step',
            isShell: false,
            lastOutputAt: 10,
            preview: 'Ready',
            state: 'idle-at-prompt',
            taskId: 'task-good',
            updatedAt: 20,
          },
          {
            agentId: 'agent-bad',
            attentionReason: 'ready-for-next-step',
            isShell: false,
            lastOutputAt: 10,
            preview: 'Ready',
            state: 'idle-at-prompt',
            taskId: 'task-bad',
            updatedAt: Number.NaN,
          },
        ],
        version: 1,
      },
      {
        category: 'task-review',
        mode: 'replace',
        payload: [
          {
            branchName: 'feature/review',
            files: [],
            projectId: 'project-1',
            revisionId: 'rev-good',
            source: 'worktree',
            taskId: 'task-good',
            totalAdded: 0,
            totalRemoved: 0,
            updatedAt: 20,
            worktreePath: '/tmp/task-good',
          },
          {
            branchName: 'feature/review',
            files: [
              {
                committed: false,
                lines_added: 1,
                lines_removed: 0,
                path: 'src/bad.ts',
                status: 'stale-cache',
              },
            ],
            projectId: 'project-1',
            revisionId: 'rev-bad',
            source: 'worktree',
            taskId: 'task-bad',
            totalAdded: 1,
            totalRemoved: 0,
            updatedAt: 21,
            worktreePath: '/tmp/task-bad',
          },
        ],
        version: 1,
      },
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-good',
            taskId: 'task-good',
            version: 2,
          },
          {
            action: 'type in the terminal',
            controllerId: 'peer-bad',
            taskId: 'task-bad',
            version: Number.NaN,
          },
        ],
        version: 2,
      },
    ] as unknown as ReadonlyArray<AnyServerStateBootstrapSnapshot>;

    applyRemoteStateBootstrap(snapshots);

    expect(getRemoteAgentSupervision('agent-good')?.taskId).toBe('task-good');
    expect(getRemoteAgentSupervision('agent-bad')).toBeNull();
    expect(getRemoteTaskReview('task-good')?.revisionId).toBe('rev-good');
    expect(getRemoteTaskReview('task-bad')).toBeNull();
    expect(getRemoteTaskCommandController('task-good')?.controllerId).toBe('peer-good');
    expect(getRemoteTaskCommandController('task-bad')).toBeNull();
  });

  it('notifies listeners when bootstrap replacement changes or clears controllers', () => {
    const listener = vi.fn();
    const cleanup = subscribeRemoteTaskCommandControllerChanges(listener);

    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-new',
            taskId: 'task-1',
            version: 5,
          },
        ],
        version: 5,
      },
    ]);

    expect(listener).toHaveBeenCalledWith({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });

    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [],
        version: 6,
      },
    ]);

    expect(listener).toHaveBeenLastCalledWith({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 6,
    });

    cleanup();
  });

  it('keeps the controller cleared when a stale controller event arrives after removal', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });
    applyRemoteTaskCommandControllerChanged({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 6,
    });
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'remote-client-1234',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Mobile Self',
        focusedSurface: 'terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-stale',
      taskId: 'task-1',
      version: 5,
    });

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toBeNull();
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
  });

  it('can clear incoming takeover requests on transport loss', () => {
    upsertIncomingRemoteTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: Date.now() + 10_000,
      requestId: 'request-1',
      requesterClientId: 'peer-1',
      requesterDisplayName: 'Ivan',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });

    clearIncomingRemoteTakeoverRequests();

    expect(getIncomingRemoteTakeoverRequests()).toEqual([]);
  });
});
