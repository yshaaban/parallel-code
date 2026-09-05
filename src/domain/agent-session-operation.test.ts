import { describe, expect, it } from 'vitest';

import type { TaskRemovalCurrentProjection } from './task-catalog.js';
import {
  canRunAgentSessionAction,
  deriveResumeFallbackOperationId,
  isAgentSessionOperationRequest,
  operationRequestResumesSession,
  reduceAgentSessionOperationProjection,
  transitionAgentSessionOperation,
  type AgentSessionOperationProjection,
  type AgentSessionOperationRequest,
  type AgentSessionReplacementOperationRequest,
  type AgentSessionOperationSnapshot,
} from './agent-session-operation.js';

function current(
  overrides: Partial<TaskRemovalCurrentProjection> = {},
): TaskRemovalCurrentProjection {
  return {
    catalogVersion: 1,
    serverInstanceId: 'server-a',
    taskClosing: false,
    taskState: 'present',
    ...overrides,
  };
}

function request(
  overrides: Partial<AgentSessionReplacementOperationRequest> = {},
): AgentSessionReplacementOperationRequest {
  return {
    admission: { kind: 'task-command' },
    agentId: 'agent-1',
    controllerId: 'controller-1',
    expectedLeaseGeneration: 3,
    expectedSourceGeneration: 7,
    launchReason: 'manual-restart',
    mode: 'fresh',
    operationId: 'operation-1',
    taskId: 'task-1',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<AgentSessionOperationSnapshot> = {},
): AgentSessionOperationSnapshot {
  return {
    agentId: 'agent-1',
    launchReason: 'manual-restart',
    operationId: 'operation-1',
    phase: 'admitted',
    resumed: false,
    sourceGeneration: 7,
    taskId: 'task-1',
    version: 1,
    ...overrides,
  };
}

function projection(
  operationOverrides: Partial<AgentSessionOperationSnapshot> = {},
  currentOverrides: Partial<TaskRemovalCurrentProjection> = {},
): AgentSessionOperationProjection {
  return {
    current: current(currentOverrides),
    operation: snapshot(operationOverrides),
  };
}

describe('agent session operation domain', () => {
  it('validates discriminated initial and replacement requests', () => {
    const initial: AgentSessionOperationRequest = {
      admission: {
        committedWorkspaceRevision: 12,
        creationOperationId: 'creation-1',
        kind: 'task-creation',
      },
      agentId: 'agent-1',
      expectedLeaseGeneration: null,
      expectedSourceGeneration: null,
      launchReason: 'initial',
      mode: 'initial',
      nextAgentDefId: 'claude-code',
      operationId: 'launch-1',
      taskId: 'task-1',
    };
    expect(isAgentSessionOperationRequest(initial)).toBe(true);
    expect(operationRequestResumesSession(initial)).toBe(false);
    expect(isAgentSessionOperationRequest(request())).toBe(true);
    expect(
      isAgentSessionOperationRequest({
        ...request(),
        admission: { kind: 'resume-fallback-system' },
        launchReason: 'resume-fallback',
      }),
    ).toBe(true);
  });

  it.each([
    { ...request(), expectedSourceGeneration: -1 },
    { ...request(), launchReason: 'manual-resume' },
    {
      ...request(),
      admission: { kind: 'resume-fallback-system' },
      launchReason: 'manual-restart',
    },
    { ...request(), launchReason: 'resume-fallback' },
    { ...request(), mode: 'switch', nextAgentDefId: undefined, launchReason: 'agent-switch' },
  ])('rejects inconsistent request %#', (candidate) => {
    expect(isAgentSessionOperationRequest(candidate)).toBe(false);
  });

  it('derives an unambiguous stable fallback operation ID', () => {
    expect(deriveResumeFallbackOperationId('task:a', 'agent/b', 9)).toBe(
      'resume-fallback:v1:task%3Aa:agent%2Fb:9',
    );
    expect(() => deriveResumeFallbackOperationId('', 'agent-1', 1)).toThrow();
    expect(() => deriveResumeFallbackOperationId('task\u0000forged', 'agent-1', 1)).toThrow();
    expect(isAgentSessionOperationRequest(request({ operationId: 'operation\u0000forged' }))).toBe(
      false,
    );
    expect(isAgentSessionOperationRequest(request({ operationId: 'operation\nforged' }))).toBe(
      false,
    );
    expect(isAgentSessionOperationRequest(request({ operationId: 'operation-\ud800' }))).toBe(
      false,
    );
    expect(isAgentSessionOperationRequest(request({ operationId: 'operation-🚀' }))).toBe(true);
  });

  it('enforces the one-way operation phase table', () => {
    const spawning = transitionAgentSessionOperation(snapshot(), {
      phase: 'spawning',
      targetGeneration: 8,
    });
    expect(spawning).toMatchObject({ phase: 'spawning', targetGeneration: 8, version: 2 });
    const running = transitionAgentSessionOperation(spawning, { phase: 'running' });
    expect(running).toMatchObject({ phase: 'running', version: 3 });
    expect(transitionAgentSessionOperation(running, { phase: 'running' })).toBe(running);
    expect(() => transitionAgentSessionOperation(running, { phase: 'spawning' })).toThrow(
      'Invalid agent-session transition',
    );
  });

  it('reduces operation and task-catalog cursors independently', () => {
    const latest = projection(
      { phase: 'running', version: 5 },
      { catalogVersion: 2, taskClosing: false },
    );
    const reduced = reduceAgentSessionOperationProjection(
      latest,
      projection({ phase: 'spawning', version: 4 }, { catalogVersion: 3, taskClosing: true }),
    );
    expect(reduced.operation).toBe(latest.operation);
    expect(reduced.current).toMatchObject({ catalogVersion: 3, taskClosing: true });

    const restarted = reduceAgentSessionOperationProjection(
      reduced,
      projection(
        { phase: 'failed', version: 6 },
        { catalogVersion: 0, serverInstanceId: 'server-b', taskClosing: false },
      ),
    );
    expect(restarted.operation.version).toBe(6);
    expect(restarted.current).toMatchObject({ catalogVersion: 0, serverInstanceId: 'server-b' });
  });

  it('offers actions only for terminal operations on a present open task', () => {
    expect(canRunAgentSessionAction(projection({ phase: 'failed' }))).toBe(true);
    expect(canRunAgentSessionAction(projection({ phase: 'spawning' }))).toBe(false);
    expect(canRunAgentSessionAction(projection({ phase: 'failed' }, { taskClosing: true }))).toBe(
      false,
    );
    expect(
      canRunAgentSessionAction(projection({ phase: 'failed' }, { taskState: 'removed' })),
    ).toBe(false);
  });
});
