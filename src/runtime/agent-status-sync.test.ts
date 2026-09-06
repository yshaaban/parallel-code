import { beforeEach, describe, expect, it } from 'vitest';

import { createTestAgent, resetStoreForTest } from '../test/store-test-helpers';
import {
  getLocalAgentQuestionState,
  isLocalAgentQuestionActive,
  markLocalQuestion,
} from '../store/agent-question-state';
import { setStore, store } from '../store/core';
import {
  handleAgentLifecycleMessage,
  reconcileRunningAgentIds,
  syncAgentStatusesFromServer,
} from './agent-status-sync';

function installAgent(
  agentId: string,
  overrides: Parameters<typeof createTestAgent>[0] = {},
): void {
  setStore('agents', agentId, createTestAgent({ id: agentId, ...overrides }));
}

describe('agent status sync generation contracts', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it.each(['paused', 'running'] as const)(
    'hydrates a newer spawn from %s before resetting generation-scoped question state',
    (status) => {
      installAgent('agent-1', { generation: 3, status, terminalSessionVersion: 4 });
      markLocalQuestion('agent-1', 3, 1);

      handleAgentLifecycleMessage({
        agentId: 'agent-1',
        event: 'spawn',
        generation: 4,
        isShell: false,
        status: 'running',
        taskId: 'task-1',
      });

      expect(store.agents['agent-1']).toMatchObject({
        generation: 4,
        status: 'running',
        terminalSessionVersion: 5,
      });
      expect(isLocalAgentQuestionActive('agent-1', 4)).toBe(false);
      expect(getLocalAgentQuestionState('agent-1')).toMatchObject({
        active: false,
        evidenceRevision: 0,
        generation: 4,
      });
    },
  );

  it('correlates managed launch metadata and surfaces successful resume fallback once', () => {
    installAgent('agent-1', { generation: 3, resumed: true, status: 'exited' });

    const fallbackSpawn = {
      agentId: 'agent-1',
      event: 'spawn' as const,
      generation: 4,
      isShell: false,
      launchReason: 'resume-fallback' as const,
      operationId: 'fallback-operation-1',
      resumed: false,
      status: 'running' as const,
      taskId: 'task-1',
    };
    handleAgentLifecycleMessage(fallbackSpawn);

    expect(store.agents['agent-1']).toMatchObject({
      generation: 4,
      launchReason: 'resume-fallback',
      resumed: false,
      sessionOperationId: 'fallback-operation-1',
      status: 'running',
    });
    expect(store.notification?.message).toContain('started a fresh session');

    handleAgentLifecycleMessage(fallbackSpawn);
    expect(store.agents['agent-1']?.sessionOperationId).toBe('fallback-operation-1');

    handleAgentLifecycleMessage({
      ...fallbackSpawn,
      generation: 3,
      operationId: 'stale-operation',
    });
    expect(store.agents['agent-1']?.sessionOperationId).toBe('fallback-operation-1');
  });

  it('does not let stale spawn or exit events mutate current generation state', () => {
    installAgent('agent-1', { generation: 4, status: 'running' });
    markLocalQuestion('agent-1', 4, 1);

    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'spawn',
      generation: 3,
      isShell: false,
      status: 'running',
      taskId: 'task-1',
    });
    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'exit',
      exitCode: 17,
      generation: 3,
      isShell: false,
      signal: 'SIGTERM',
      taskId: 'task-1',
    });

    expect(store.agents['agent-1']).toMatchObject({ generation: 4, status: 'running' });
    expect(isLocalAgentQuestionActive('agent-1', 4)).toBe(true);
  });

  it.each(['status snapshot', 'spawn replay', 'pause/resume'])(
    'preserves current question evidence across a same-generation %s',
    (observation) => {
      installAgent('agent-1', { generation: 4, status: 'running' });
      markLocalQuestion('agent-1', 4, 7);

      if (observation === 'status snapshot') {
        syncAgentStatusesFromServer([{ agentId: 'agent-1', status: 'running' }]);
      } else if (observation === 'spawn replay') {
        handleAgentLifecycleMessage({
          agentId: 'agent-1',
          event: 'spawn',
          generation: 4,
          isShell: false,
          status: 'running',
          taskId: 'task-1',
        });
      } else {
        syncAgentStatusesFromServer([{ agentId: 'agent-1', status: 'paused' }]);
        syncAgentStatusesFromServer([{ agentId: 'agent-1', status: 'running' }]);
      }

      expect(getLocalAgentQuestionState('agent-1')).toMatchObject({
        active: true,
        evidenceRevision: 7,
        generation: 4,
      });
    },
  );

  it('clears generation-scoped question state on an exact-generation exit', () => {
    installAgent('agent-1', { generation: 4, status: 'running' });
    markLocalQuestion('agent-1', 4, 1);

    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'exit',
      exitCode: 17,
      generation: 4,
      isShell: false,
      signal: 'SIGTERM',
      taskId: 'task-1',
    });

    expect(store.agents['agent-1']).toMatchObject({
      exitCode: 17,
      generation: 4,
      signal: 'SIGTERM',
      status: 'exited',
    });
    expect(getLocalAgentQuestionState('agent-1')).toBeNull();
  });

  it('reconciles a full running-id snapshot through the same lifecycle reset seam', () => {
    installAgent('agent-revived', {
      generation: 2,
      signal: 'server_unavailable',
      status: 'exited',
    });
    installAgent('agent-missing', { generation: 5, status: 'running' });
    markLocalQuestion('agent-revived', 2, 1);
    markLocalQuestion('agent-missing', 5, 1);

    reconcileRunningAgentIds(['agent-revived']);

    expect(store.agents['agent-revived']).toMatchObject({
      generation: 2,
      signal: null,
      status: 'running',
    });
    expect(isLocalAgentQuestionActive('agent-revived', 2)).toBe(false);
    expect(store.agents['agent-missing']).toMatchObject({
      generation: 5,
      signal: 'server_unavailable',
      status: 'exited',
    });
    expect(getLocalAgentQuestionState('agent-missing')).toBeNull();
  });

  it('applies live status snapshots only to known or reconnect-uncertain sessions', () => {
    installAgent('agent-known', { generation: 1, status: 'running' });
    installAgent('agent-reconnect', {
      generation: 2,
      signal: 'server_unavailable',
      status: 'exited',
    });
    installAgent('agent-definitive-exit', {
      generation: 3,
      signal: 'SIGTERM',
      status: 'exited',
    });

    syncAgentStatusesFromServer([
      { agentId: 'agent-known', status: 'flow-controlled' },
      { agentId: 'agent-reconnect', status: 'running' },
      { agentId: 'agent-definitive-exit', status: 'running' },
      { agentId: 'agent-unknown', status: 'running' },
    ]);

    expect(store.agents['agent-known']?.status).toBe('flow-controlled');
    expect(store.agents['agent-reconnect']).toMatchObject({ signal: null, status: 'running' });
    expect(store.agents['agent-definitive-exit']).toMatchObject({
      signal: 'SIGTERM',
      status: 'exited',
    });
    expect(store.agents['agent-unknown']).toBeUndefined();
  });
});
