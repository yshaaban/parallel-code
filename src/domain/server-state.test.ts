import { describe, expect, it } from 'vitest';

import {
  getGitStatusSyncEventBufferKey,
  isAgentSupervisionEvent,
  isAgentSupervisionSnapshot,
  isAgentSupervisionState,
  isGitStatusSyncSnapshotEvent,
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  isExitedRemoteAgentStatus,
  isGitStatusSyncEvent,
  isPeerPresenceSnapshot,
  isPauseReason,
  isRemoteAccessStatus,
  isRemoteAgent,
  isRemoteAgentStatus,
  isRemotePresence,
  isRemovedAgentSupervisionEvent,
  isRemovedTaskPortsEvent,
  isTaskExposedPort,
  isTaskAttentionReason,
  isTaskExposedPortSource,
  isTaskObservedPortSource,
  isTaskObservedPort,
  isTaskPortSnapshot,
  isTaskPortsEvent,
  isTaskPortProtocol,
  isTaskPreviewAvailability,
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

  it('recognizes only supported task-port wire states', () => {
    expect(isTaskPreviewAvailability('unknown')).toBe(true);
    expect(isTaskPreviewAvailability('available')).toBe(true);
    expect(isTaskPreviewAvailability('blocked')).toBe(false);
    expect(isTaskPortProtocol('http')).toBe(true);
    expect(isTaskPortProtocol('ftp')).toBe(false);
    expect(isTaskExposedPortSource('manual')).toBe(true);
    expect(isTaskExposedPortSource('output')).toBe(false);
    expect(isTaskObservedPortSource('rediscovery')).toBe(true);
    expect(isTaskObservedPortSource('manual')).toBe(false);
  });

  it('validates task-port snapshot payload shapes from transport boundaries', () => {
    const exposedPort = {
      availability: 'available',
      host: null,
      label: 'App',
      lastVerifiedAt: 100,
      port: 5173,
      protocol: 'http',
      source: 'manual',
      statusMessage: null,
      updatedAt: 101,
      verifiedHost: '127.0.0.1',
    };
    const observedPort = {
      host: '127.0.0.1',
      port: 5173,
      protocol: 'http',
      source: 'output',
      suggestion: 'http://127.0.0.1:5173',
      updatedAt: 102,
    };

    expect(isTaskExposedPort(exposedPort)).toBe(true);
    expect(isTaskObservedPort(observedPort)).toBe(true);
    expect(
      isTaskPortSnapshot({
        exposed: [exposedPort],
        observed: [observedPort],
        taskId: 'task-1',
        updatedAt: 103,
      }),
    ).toBe(true);
    expect(isTaskExposedPort({ ...exposedPort, source: 'output' })).toBe(false);
    expect(isTaskObservedPort({ ...observedPort, protocol: 'ftp' })).toBe(false);
    expect(isTaskExposedPort({ ...exposedPort, port: 0 })).toBe(false);
    expect(isTaskExposedPort({ ...exposedPort, lastVerifiedAt: -1 })).toBe(false);
    expect(isTaskExposedPort({ ...exposedPort, updatedAt: 1.5 })).toBe(false);
    expect(isTaskObservedPort({ ...observedPort, port: 65_536 })).toBe(false);
    expect(isTaskObservedPort({ ...observedPort, updatedAt: -1 })).toBe(false);
    expect(
      isTaskPortSnapshot({
        exposed: [exposedPort],
        observed: [{ ...observedPort, suggestion: null }],
        taskId: 'task-1',
        updatedAt: 103,
      }),
    ).toBe(false);
    expect(
      isTaskPortSnapshot({
        exposed: [exposedPort],
        observed: [observedPort],
        taskId: 'task-1',
        updatedAt: 1.5,
      }),
    ).toBe(false);
    expect(
      isTaskPortsEvent({
        exposed: [exposedPort],
        kind: 'snapshot',
        observed: [observedPort],
        taskId: 'task-1',
        updatedAt: 103,
      }),
    ).toBe(true);
    expect(
      isTaskPortsEvent({
        kind: 'removed',
        removed: true,
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      isTaskPortsEvent({
        kind: 'removed',
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
    expect(
      isTaskPortsEvent({
        exposed: [exposedPort],
        kind: 'snapshot',
        observed: [observedPort],
        stateVersion: '7',
        taskId: 'task-1',
        updatedAt: 103,
      }),
    ).toBe(false);
    expect(
      isTaskPortsEvent({
        exposed: [exposedPort],
        kind: 'snapshot',
        observed: [observedPort],
        stateVersion: 1.5,
        taskId: 'task-1',
        updatedAt: 103,
      }),
    ).toBe(false);
    expect(
      isRemovedTaskPortsEvent({
        kind: 'removed',
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
  });

  it('recognizes only supported supervision and attention states', () => {
    expect(isAgentSupervisionState('active')).toBe(true);
    expect(isAgentSupervisionState('flow-controlled')).toBe(true);
    expect(isAgentSupervisionState('waiting-input')).toBe(false);
    expect(isTaskAttentionReason('ready-for-next-step')).toBe(true);
    expect(isTaskAttentionReason('idle-at-prompt')).toBe(false);
  });

  it('validates agent supervision snapshots and events from transport boundaries', () => {
    const snapshot = {
      agentId: 'agent-1',
      attentionReason: 'ready-for-next-step',
      isShell: false,
      lastOutputAt: null,
      preview: 'Ready',
      runnerInstanceId: 'runner-1',
      runnerProvider: 'docker-container',
      state: 'idle-at-prompt',
      taskId: 'task-1',
      updatedAt: 10,
    };

    expect(isAgentSupervisionSnapshot(snapshot)).toBe(true);
    expect(
      isAgentSupervisionEvent({
        ...snapshot,
        kind: 'snapshot',
        stateVersion: '7',
      }),
    ).toBe(false);
    expect(
      isAgentSupervisionEvent({
        ...snapshot,
        kind: 'snapshot',
        stateVersion: -1,
      }),
    ).toBe(false);
    expect(
      isAgentSupervisionEvent({
        ...snapshot,
        kind: 'snapshot',
      }),
    ).toBe(true);
    expect(
      isAgentSupervisionEvent({
        agentId: 'agent-1',
        kind: 'removed',
        removed: true,
        taskId: null,
      }),
    ).toBe(true);
    expect(isAgentSupervisionSnapshot({ ...snapshot, attentionReason: 'blocked' })).toBe(false);
    expect(isAgentSupervisionSnapshot({ ...snapshot, lastOutputAt: -1 })).toBe(false);
    expect(isAgentSupervisionSnapshot({ ...snapshot, runnerProvider: 'container' })).toBe(false);
    expect(isAgentSupervisionSnapshot({ ...snapshot, updatedAt: 1.5 })).toBe(false);
    expect(isAgentSupervisionEvent({ ...snapshot, kind: 'removed' })).toBe(false);
    expect(
      isRemovedAgentSupervisionEvent({
        agentId: 'agent-1',
        kind: 'removed',
        removed: false,
        taskId: null,
      }),
    ).toBe(false);
  });

  it('validates peer presence snapshots from transport boundaries', () => {
    const snapshot = {
      activeTaskId: 'task-1',
      clientId: 'client-1',
      controllingAgentIds: ['agent-1'],
      controllingTaskIds: ['task-1'],
      displayName: 'Remote user',
      focusedSurface: null,
      lastSeenAt: 10,
      visibility: 'visible',
    };

    expect(isPeerPresenceSnapshot(snapshot)).toBe(true);
    expect(isPeerPresenceSnapshot({ ...snapshot, visibility: 'minimized' })).toBe(false);
    expect(isPeerPresenceSnapshot({ ...snapshot, lastSeenAt: Number.NaN })).toBe(false);
    expect(isPeerPresenceSnapshot({ ...snapshot, lastSeenAt: 1.5 })).toBe(false);
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
      }),
    ).toBe(false);
  });

  it('validates git-status sync events from transport boundaries', () => {
    expect(
      isGitStatusSyncEvent({
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
        worktreePath: '/tmp/task-1',
      }),
    ).toBe(true);
    expect(
      isGitStatusSyncEvent({
        branchName: 'feature/task-1',
        projectRoot: '/tmp/project',
      }),
    ).toBe(true);
    expect(
      isGitStatusSyncEvent({
        stateVersion: '7',
        worktreePath: '/tmp/task-1',
      }),
    ).toBe(false);
    expect(
      isGitStatusSyncEvent({
        stateVersion: 1.5,
        worktreePath: '/tmp/task-1',
      }),
    ).toBe(false);
    expect(
      isGitStatusSyncEvent({
        status: {
          has_committed_changes: true,
        },
        worktreePath: '/tmp/task-1',
      }),
    ).toBe(false);
  });

  it('validates remote status and presence payloads from transport boundaries', () => {
    expect(
      isRemotePresence({
        connectedClients: 2,
        peerClients: 1,
      }),
    ).toBe(true);
    expect(
      isRemotePresence({
        connectedClients: 1.5,
        peerClients: 1,
      }),
    ).toBe(false);
    expect(
      isRemotePresence({
        connectedClients: 1,
        peerClients: -1,
      }),
    ).toBe(false);
    expect(
      isRemoteAccessStatus({
        connectedClients: 0,
        enabled: false,
        peerClients: 0,
        port: 7777,
        tailscaleUrl: null,
        token: null,
        url: null,
        wifiUrl: null,
      }),
    ).toBe(true);
    expect(
      isRemoteAccessStatus({
        connectedClients: 1,
        enabled: true,
        peerClients: 0,
        port: 7777,
        tailscaleUrl: null,
        token: 'token',
        url: 'http://127.0.0.1:7777',
        wifiUrl: null,
      }),
    ).toBe(true);
    expect(
      isRemoteAccessStatus({
        connectedClients: 1,
        enabled: true,
        peerClients: 0,
        port: 7777.5,
        tailscaleUrl: null,
        token: 'token',
        url: 'http://127.0.0.1:7777',
        wifiUrl: null,
      }),
    ).toBe(false);
    expect(
      isRemoteAccessStatus({
        connectedClients: 0,
        enabled: false,
        peerClients: 0,
        port: 0,
        tailscaleUrl: null,
        token: null,
        url: null,
        wifiUrl: null,
      }),
    ).toBe(false);
    expect(
      isRemoteAccessStatus({
        connectedClients: 1,
        enabled: true,
        peerClients: 0,
        port: 65_536,
        tailscaleUrl: null,
        token: 'token',
        url: 'http://127.0.0.1:65536',
        wifiUrl: null,
      }),
    ).toBe(false);
    expect(
      isRemoteAccessStatus({
        connectedClients: 1,
        enabled: true,
        peerClients: 0,
        port: 7777,
        tailscaleUrl: null,
        token: null,
        url: 'http://127.0.0.1:7777',
        wifiUrl: null,
      }),
    ).toBe(false);
  });

  it('validates remote-agent payloads from transport boundaries', () => {
    const remoteAgent = {
      agentId: 'agent-1',
      exitCode: null,
      lastLine: 'ready',
      status: 'running',
      taskId: 'task-1',
      taskName: 'Task 1',
    };

    expect(isRemoteAgentStatus('flow-controlled')).toBe(true);
    expect(isRemoteAgentStatus('waiting')).toBe(false);
    expect(isRemoteAgent(remoteAgent)).toBe(true);
    expect(
      isRemoteAgent({
        ...remoteAgent,
        runnerInstanceId: 'runner-1',
        runnerProvider: 'docker-container',
      }),
    ).toBe(true);
    expect(isRemoteAgent({ ...remoteAgent, exitCode: 1.5 })).toBe(false);
    expect(isRemoteAgent({ ...remoteAgent, runnerProvider: 'container' })).toBe(false);
    expect(isRemoteAgent({ ...remoteAgent, taskMeta: { directMode: false } })).toBe(false);
    expect(
      isRemoteAgent({
        ...remoteAgent,
        taskMeta: {
          agentDefId: null,
          agentDefName: null,
          branchName: 'feature/task-1',
          directMode: false,
          folderName: null,
          gitIsolation: 'worktree',
          lastPrompt: null,
          projectMode: 'git',
          worktreeOwnership: 'managed',
        },
      }),
    ).toBe(true);
    expect(
      isRemoteAgent({
        ...remoteAgent,
        taskMeta: {
          agentDefId: null,
          agentDefName: null,
          branchName: null,
          directMode: false,
          folderName: 'non-git-project',
          gitIsolation: 'current-branch',
          lastPrompt: null,
          projectMode: 'non-git',
        },
      }),
    ).toBe(true);
    expect(
      isRemoteAgent({
        ...remoteAgent,
        taskMeta: {
          agentDefId: null,
          agentDefName: null,
          branchName: null,
          directMode: false,
          folderName: null,
          gitIsolation: 'detached',
          lastPrompt: null,
        },
      }),
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
