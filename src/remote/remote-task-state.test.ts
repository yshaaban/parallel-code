import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentSupervisionSnapshotEvent,
  createRemovedAgentSupervisionEvent,
  createRemovedTaskPortsEvent,
  createTaskPortsSnapshotEvent,
} from '../domain/server-state';
import {
  applyRemoteAgentSupervisionChanged,
  applyRemoteTaskPortsChanged,
  applyRemoteTaskReviewChanged,
  getRemoteAgentSupervision,
  getRemoteTaskPorts,
  getRemoteTaskReview,
  replaceRemoteAgentSupervisionSnapshots,
  replaceRemoteTaskPortsSnapshots,
  replaceRemoteTaskReviewSnapshots,
  resetRemoteTaskStateForTests,
} from './remote-task-state';

describe('remote task state', () => {
  beforeEach(() => {
    resetRemoteTaskStateForTests();
  });

  afterEach(() => {
    resetRemoteTaskStateForTests();
  });

  it('replaces and updates agent supervision snapshots', () => {
    replaceRemoteAgentSupervisionSnapshots([
      {
        agentId: 'agent-1',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 10,
        preview: 'Continue?',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 20,
      },
    ]);

    expect(getRemoteAgentSupervision('agent-1')?.state).toBe('awaiting-input');

    applyRemoteAgentSupervisionChanged(
      createAgentSupervisionSnapshotEvent({
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 30,
        preview: 'Ready for the next instruction',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 40,
      }),
    );

    expect(getRemoteAgentSupervision('agent-1')?.state).toBe('idle-at-prompt');

    applyRemoteAgentSupervisionChanged(
      createAgentSupervisionSnapshotEvent({
        agentId: 'agent-1',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: 20,
        preview: 'Stale',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 30,
      }),
    );

    expect(getRemoteAgentSupervision('agent-1')?.state).toBe('idle-at-prompt');

    applyRemoteAgentSupervisionChanged(createRemovedAgentSupervisionEvent('agent-1', 'task-1'));

    expect(getRemoteAgentSupervision('agent-1')).toBeNull();
  });

  it('replaces and updates task review snapshots', () => {
    replaceRemoteTaskReviewSnapshots([
      {
        branchName: 'feature/review',
        files: [],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 0,
        totalRemoved: 0,
        updatedAt: 10,
        worktreePath: '/tmp/task-1',
      },
    ]);

    expect(getRemoteTaskReview('task-1')?.revisionId).toBe('rev-1');

    applyRemoteTaskReviewChanged({
      branchName: 'feature/review',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'branch-fallback',
      taskId: 'task-1',
      totalAdded: 1,
      totalRemoved: 0,
      updatedAt: 20,
      worktreePath: '/tmp/task-1',
    });

    expect(getRemoteTaskReview('task-1')?.source).toBe('branch-fallback');

    applyRemoteTaskReviewChanged({
      branchName: 'feature/review',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-older',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 15,
      worktreePath: '/tmp/task-1',
    });

    expect(getRemoteTaskReview('task-1')?.revisionId).toBe('rev-2');

    applyRemoteTaskReviewChanged({
      removed: true,
      taskId: 'task-1',
    });

    expect(getRemoteTaskReview('task-1')).toBeNull();
  });

  it('replaces and updates task port snapshots', () => {
    replaceRemoteTaskPortsSnapshots([
      {
        exposed: [],
        observed: [],
        taskId: 'task-1',
        updatedAt: 10,
      },
    ]);

    expect(getRemoteTaskPorts('task-1')?.updatedAt).toBe(10);

    applyRemoteTaskPortsChanged(
      createTaskPortsSnapshotEvent({
        exposed: [
          {
            availability: 'available',
            host: '127.0.0.1',
            label: 'Preview',
            lastVerifiedAt: 15,
            port: 3000,
            protocol: 'http',
            source: 'manual',
            statusMessage: null,
            updatedAt: 20,
            verifiedHost: '127.0.0.1',
          },
        ],
        observed: [],
        taskId: 'task-1',
        updatedAt: 20,
      }),
    );

    expect(getRemoteTaskPorts('task-1')?.exposed[0]?.port).toBe(3000);

    applyRemoteTaskPortsChanged(
      createTaskPortsSnapshotEvent({
        exposed: [],
        observed: [],
        taskId: 'task-1',
        updatedAt: 15,
      }),
    );

    expect(getRemoteTaskPorts('task-1')?.exposed[0]?.port).toBe(3000);

    applyRemoteTaskPortsChanged(createRemovedTaskPortsEvent('task-1'));

    expect(getRemoteTaskPorts('task-1')).toBeNull();
  });

  it('ignores stale bootstrap replacements for review and port state', () => {
    replaceRemoteTaskReviewSnapshots(
      [
        {
          branchName: 'feature/review',
          files: [],
          projectId: 'project-1',
          revisionId: 'rev-new',
          source: 'worktree',
          taskId: 'task-1',
          totalAdded: 0,
          totalRemoved: 0,
          updatedAt: 30,
          worktreePath: '/tmp/task-1',
        },
      ],
      5,
    );
    replaceRemoteTaskReviewSnapshots(
      [
        {
          branchName: 'feature/review',
          files: [],
          projectId: 'project-1',
          revisionId: 'rev-old',
          source: 'branch-fallback',
          taskId: 'task-1',
          totalAdded: 0,
          totalRemoved: 0,
          updatedAt: 10,
          worktreePath: '/tmp/task-1',
        },
      ],
      4,
    );

    replaceRemoteTaskPortsSnapshots(
      [
        {
          exposed: [],
          observed: [],
          taskId: 'task-1',
          updatedAt: 30,
        },
      ],
      5,
    );
    replaceRemoteTaskPortsSnapshots(
      [
        {
          exposed: [
            {
              availability: 'available',
              host: '127.0.0.1',
              label: 'Old',
              lastVerifiedAt: 10,
              port: 8080,
              protocol: 'http',
              source: 'manual',
              statusMessage: null,
              updatedAt: 10,
              verifiedHost: '127.0.0.1',
            },
          ],
          observed: [],
          taskId: 'task-1',
          updatedAt: 10,
        },
      ],
      4,
    );

    expect(getRemoteTaskReview('task-1')?.revisionId).toBe('rev-new');
    expect(getRemoteTaskPorts('task-1')?.exposed).toEqual([]);
  });

  it('ignores non-finite replace versions so stale-order tracking stays usable', () => {
    replaceRemoteAgentSupervisionSnapshots(
      [
        {
          agentId: 'agent-1',
          attentionReason: 'waiting-input',
          isShell: false,
          lastOutputAt: 10,
          preview: 'Continue?',
          state: 'awaiting-input',
          taskId: 'task-1',
          updatedAt: 20,
        },
      ],
      2,
    );
    replaceRemoteAgentSupervisionSnapshots(
      [
        {
          agentId: 'agent-2',
          attentionReason: 'ready-for-next-step',
          isShell: false,
          lastOutputAt: 30,
          preview: 'Ready',
          state: 'idle-at-prompt',
          taskId: 'task-2',
          updatedAt: 40,
        },
      ],
      Number.NaN,
    );

    replaceRemoteTaskReviewSnapshots(
      [
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
      Number.POSITIVE_INFINITY,
    );

    replaceRemoteTaskPortsSnapshots(
      [
        {
          exposed: [],
          observed: [],
          taskId: 'task-1',
          updatedAt: 20,
        },
      ],
      Number.NEGATIVE_INFINITY,
    );

    expect(getRemoteAgentSupervision('agent-1')?.taskId).toBe('task-1');
    expect(getRemoteAgentSupervision('agent-2')).toBeNull();
    expect(getRemoteTaskReview('task-1')).toBeNull();
    expect(getRemoteTaskPorts('task-1')).toBeNull();
  });
});
