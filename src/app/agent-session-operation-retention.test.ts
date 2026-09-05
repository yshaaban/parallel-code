import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearRetainedManualAgentSessionOperation,
  clearRetainedManualAgentSessionOperationsForTask,
  retainManualAgentSessionOperation,
  resetManualAgentSessionOperationsForTests,
  RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT,
  RETAINED_MANUAL_AGENT_SESSION_OPERATION_TTL_MS,
} from './agent-session-operation-retention';

function createIdFactory(): () => string {
  let next = 0;
  return () => `operation-${++next}`;
}

describe('manual agent-session operation retention', () => {
  beforeEach(() => resetManualAgentSessionOperationsForTests());

  it('reuses one identity for the same action and replaces it for a different action', () => {
    const createOperationId = createIdFactory();
    const first = retainManualAgentSessionOperation({
      actionKey: 'task-1\0restart',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 1,
      taskId: 'task-1',
    });
    const retry = retainManualAgentSessionOperation({
      actionKey: 'task-1\0restart',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 2,
      taskId: 'task-1',
    });
    const switched = retainManualAgentSessionOperation({
      actionKey: 'task-1\0switch\0codex',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 3,
      taskId: 'task-1',
    });

    expect(retry).toBe(first);
    expect(switched.operationId).not.toBe(first.operationId);
  });

  it('expires abandoned identities after the bounded retry window', () => {
    const createOperationId = createIdFactory();
    const first = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 10,
      taskId: 'task-1',
    });
    const expired = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 10 + RETAINED_MANUAL_AGENT_SESSION_OPERATION_TTL_MS,
      taskId: 'task-1',
    });

    expect(expired.operationId).not.toBe(first.operationId);
  });

  it('evicts the least-recently-used identity at the capacity bound', () => {
    const createOperationId = createIdFactory();
    let oldestOperationId = '';
    for (let index = 0; index < RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT; index += 1) {
      const retained = retainManualAgentSessionOperation({
        actionKey: 'restart',
        agentId: `agent-${index}`,
        createOperationId,
        nowMs: index,
        taskId: `task-${index}`,
      });
      if (index === 0) oldestOperationId = retained.operationId;
    }
    retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-over-limit',
      createOperationId,
      nowMs: RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT,
      taskId: 'task-over-limit',
    });

    const recreatedOldest = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-0',
      createOperationId,
      nowMs: RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT + 1,
      taskId: 'task-0',
    });
    expect(recreatedOldest.operationId).not.toBe(oldestOperationId);
  });

  it('cleans retained identities by agent and task ownership', () => {
    const createOperationId = createIdFactory();
    const agentOne = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-1',
      createOperationId,
      nowMs: 1,
      taskId: 'task-1',
    });
    const agentTwo = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-2',
      createOperationId,
      nowMs: 1,
      taskId: 'task-1',
    });
    const otherTask = retainManualAgentSessionOperation({
      actionKey: 'restart',
      agentId: 'agent-3',
      createOperationId,
      nowMs: 1,
      taskId: 'task-2',
    });

    clearRetainedManualAgentSessionOperation('agent-1');
    clearRetainedManualAgentSessionOperationsForTask('task-1');

    expect(
      retainManualAgentSessionOperation({
        actionKey: 'restart',
        agentId: 'agent-1',
        createOperationId,
        nowMs: 2,
        taskId: 'task-1',
      }).operationId,
    ).not.toBe(agentOne.operationId);
    expect(
      retainManualAgentSessionOperation({
        actionKey: 'restart',
        agentId: 'agent-2',
        createOperationId,
        nowMs: 2,
        taskId: 'task-1',
      }).operationId,
    ).not.toBe(agentTwo.operationId);
    expect(
      retainManualAgentSessionOperation({
        actionKey: 'restart',
        agentId: 'agent-3',
        createOperationId,
        nowMs: 2,
        taskId: 'task-2',
      }),
    ).toBe(otherTask);
  });
});
