import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyProjection: vi.fn(() => true),
  execute: vi.fn(),
  getProjection: vi.fn(),
  randomId: vi.fn(),
  refreshCapabilities: vi.fn(),
  runWithLease: vi.fn(async (_taskId: string, _action: string, run: () => Promise<unknown>) =>
    run(),
  ),
  store: {
    agents: {
      'agent-1': {
        def: { id: 'claude-code' },
        generation: 4,
        id: 'agent-1',
        taskId: 'task-1',
      },
    },
  },
}));

vi.mock('../store/state', () => ({ store: mocks.store }));
vi.mock('../store/agents', () => ({
  applyAgentSessionOperationProjection: mocks.applyProjection,
}));
vi.mock('../lib/random-id', () => ({ createRandomId: mocks.randomId }));
vi.mock('../lib/runtime-client-id', () => ({ getRuntimeClientId: () => 'client-1' }));
vi.mock('./task-command-lease-runtime', () => ({
  getRetainedTaskCommandLeaseGeneration: () => 9,
}));
vi.mock('./task-command-lease-session', () => ({
  isTaskCommandLeaseSkipped: (value: unknown) => value === 'skipped',
  runWithTaskCommandLease: mocks.runWithLease,
}));
vi.mock('./task-reliability-production', () => ({
  getProductionTaskReliabilityClient: () => ({
    agentSessions: { execute: mocks.execute, getProjection: mocks.getProjection },
    refreshCapabilities: mocks.refreshCapabilities,
  }),
}));

import {
  resetManualAgentSessionOperationsForTests,
  runManualAgentSessionAction,
} from './agent-session-workflows';

function projection(phase: 'failed' | 'running' = 'running') {
  return {
    current: {
      catalogVersion: 3,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'present' as const,
    },
    operation: {
      agentId: 'agent-1',
      launchReason: 'manual-restart' as const,
      operationId: 'agent-session-ui:v1:operation-1',
      phase,
      resumed: false,
      sourceGeneration: 4,
      targetGeneration: 5,
      taskId: 'task-1',
      version: 4,
    },
  };
}

describe('manual agent-session workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManualAgentSessionOperationsForTests();
    mocks.randomId.mockReturnValueOnce('operation-1').mockReturnValueOnce('operation-2');
    mocks.getProjection.mockResolvedValue(null);
    mocks.refreshCapabilities.mockResolvedValue({
      agentSessions: { manualReplacement: true },
      kind: 'active',
    });
    mocks.execute.mockResolvedValue({
      kind: 'operation',
      projection: projection(),
      replayed: false,
    });
    mocks.applyProjection.mockReturnValue(true);
  });

  it('holds task control and applies only the authoritative running projection', async () => {
    await expect(runManualAgentSessionAction('agent-1', { kind: 'resume' })).resolves.toBe(true);

    expect(mocks.runWithLease).toHaveBeenCalledWith(
      'task-1',
      'resume an agent',
      expect.any(Function),
      {},
    );
    expect(mocks.execute).toHaveBeenCalledWith({
      admission: { kind: 'task-command' },
      agentId: 'agent-1',
      controllerId: 'client-1',
      expectedLeaseGeneration: 9,
      expectedSourceGeneration: 4,
      launchReason: 'manual-resume',
      mode: 'resume',
      operationId: 'agent-session-ui:v1:operation-1',
      taskId: 'task-1',
    });
    expect(mocks.applyProjection).toHaveBeenCalledTimes(1);
  });

  it('passes switch identity to the backend and projection reducer without optimistic mutation', async () => {
    const nextAgentDef = { id: 'codex', name: 'Codex' } as never;
    mocks.execute.mockResolvedValue({
      kind: 'operation',
      projection: {
        ...projection(),
        operation: { ...projection().operation, launchReason: 'agent-switch' },
      },
      replayed: false,
    });

    const pending = runManualAgentSessionAction('agent-1', {
      agentDef: nextAgentDef,
      kind: 'switch',
    });
    expect(mocks.applyProjection).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe(true);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        launchReason: 'agent-switch',
        mode: 'switch',
        nextAgentDefId: 'codex',
      }),
    );
    expect(mocks.applyProjection).toHaveBeenCalledWith(expect.anything(), nextAgentDef);
  });

  it('does not project failed or closing operations', async () => {
    mocks.execute.mockResolvedValueOnce({
      kind: 'operation',
      projection: projection('failed'),
      replayed: false,
    });
    await expect(runManualAgentSessionAction('agent-1', { kind: 'restart' })).rejects.toThrow(
      'ended in failed',
    );
    expect(mocks.applyProjection).not.toHaveBeenCalled();

    mocks.execute.mockResolvedValueOnce({
      kind: 'operation',
      projection: {
        ...projection(),
        current: { ...projection().current, taskClosing: true },
      },
      replayed: false,
    });
    await expect(runManualAgentSessionAction('agent-1', { kind: 'restart' })).resolves.toBe(false);
    expect(mocks.applyProjection).not.toHaveBeenCalled();
  });

  it('reuses one operation identity after a lost response', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      kind: 'operation',
      projection: projection(),
      replayed: true,
    });

    await expect(runManualAgentSessionAction('agent-1', { kind: 'restart' })).rejects.toThrow(
      'response lost',
    );
    await expect(runManualAgentSessionAction('agent-1', { kind: 'restart' })).resolves.toBe(true);

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]?.[0]).toEqual(mocks.execute.mock.calls[1]?.[0]);
    expect(mocks.execute.mock.calls[1]?.[0]).toMatchObject({
      operationId: 'agent-session-ui:v1:operation-1',
    });
    expect(mocks.randomId).toHaveBeenCalledOnce();
    expect(mocks.applyProjection).toHaveBeenCalledOnce();
  });
});
