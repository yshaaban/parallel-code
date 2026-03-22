import { describe, expect, it } from 'vitest';

import {
  getGitStatusSyncEventBufferKey,
  isGitStatusSyncSnapshotEvent,
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  isExitedRemoteAgentStatus,
  isPauseReason,
} from './server-state';

describe('server state helpers', () => {
  it('recognizes only supported pause reasons', () => {
    expect(isPauseReason('manual')).toBe(true);
    expect(isPauseReason('flow-control')).toBe(true);
    expect(isPauseReason('restore')).toBe(true);
    expect(isPauseReason('resume')).toBe(false);
    expect(isPauseReason(undefined)).toBe(false);
  });

  it('maps pause reasons to remote agent statuses', () => {
    expect(getRemoteAgentStatus('manual')).toBe('paused');
    expect(getRemoteAgentStatus('flow-control')).toBe('flow-controlled');
    expect(getRemoteAgentStatus('restore')).toBe('restoring');
    expect(getRemoteAgentStatus(null, 'exited')).toBe('exited');
  });

  it('identifies automatic pause reasons without string fallbacks', () => {
    expect(isAutomaticPauseReason('manual')).toBe(false);
    expect(isAutomaticPauseReason('flow-control')).toBe(true);
    expect(isAutomaticPauseReason('restore')).toBe(true);
    expect(isAutomaticPauseReason(undefined)).toBe(false);
  });

  it('builds distinct buffer keys for worktree, branch, and project git-status invalidations', () => {
    expect(
      getGitStatusSyncEventBufferKey({
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
      }),
    ).toBe('worktree:/tmp/task-1');
    expect(
      getGitStatusSyncEventBufferKey({
        worktreePath: '/tmp/task-1',
      }),
    ).toBe('worktree:/tmp/task-1');
    expect(
      getGitStatusSyncEventBufferKey({
        branchName: 'feature/task-1',
        projectRoot: '/tmp/project',
      }),
    ).toBe('branch:/tmp/project:feature/task-1');
    expect(
      getGitStatusSyncEventBufferKey({
        projectRoot: '/tmp/project',
      }),
    ).toBe('project:/tmp/project');
  });

  it('does not treat malformed null git-status payloads as snapshots', () => {
    expect(
      isGitStatusSyncSnapshotEvent({
        worktreePath: '/tmp/task-1',
        status: null,
      } as never),
    ).toBe(false);
  });

  it('exposes explicit remote-agent lifecycle predicates', () => {
    expect(isExitedRemoteAgentStatus('running')).toBe(false);
    expect(isExitedRemoteAgentStatus('paused')).toBe(false);
    expect(isExitedRemoteAgentStatus('flow-controlled')).toBe(false);
    expect(isExitedRemoteAgentStatus('restoring')).toBe(false);
    expect(isExitedRemoteAgentStatus('exited')).toBe(true);
  });
});
