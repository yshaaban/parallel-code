import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionOperationRequest } from '../../src/domain/agent-session-operation.js';

import {
  createAgentSessionRecoveryAdapter,
  type AuthoritativeAgentSessionRecoveryContext,
  type FinalizedAgentSessionExit,
} from './agent-session-recovery.js';

const SUPPORTED_CONTEXT: AuthoritativeAgentSessionRecoveryContext = {
  agentDef: {
    id: 'claude-code',
    resume_failure_classifier: 'claude-no-conversation-v1',
    resume_failure_fallback: 'fresh-start',
  },
  currentGeneration: 7,
  trust: 'built-in-catalog',
};

function recoveryLease(release = vi.fn()) {
  return { leaseGeneration: 11, release };
}

function exit(overrides: Partial<FinalizedAgentSessionExit> = {}): FinalizedAgentSessionExit {
  return {
    agentId: 'agent/a',
    exitCode: 1,
    generation: 7,
    lastOutput: ['No conversation found to continue'],
    resumed: true,
    signal: null,
    taskId: 'task:1',
    ...overrides,
  };
}

function operationResult(operationId: string) {
  return {
    kind: 'operation' as const,
    projection: {
      current: {
        catalogVersion: 1,
        serverInstanceId: 'server-1',
        taskClosing: false,
        taskState: 'present' as const,
      },
      operation: {
        agentId: 'agent/a',
        fallbackClassifier: 'claude-no-conversation-v1' as const,
        launchReason: 'resume-fallback' as const,
        operationId,
        phase: 'running' as const,
        resumed: false,
        sourceGeneration: 7,
        targetGeneration: 8,
        taskId: 'task:1',
        version: 4,
      },
    },
    replayed: false,
  };
}

describe('agent-session exit recovery adapter', () => {
  it('derives one generation-bound request from an authoritative eligible exit', async () => {
    const execute = vi.fn(async (request: AgentSessionOperationRequest) =>
      operationResult(request.operationId),
    );
    const resolveAuthoritativeExit = vi.fn(async () => SUPPORTED_CONTEXT);
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease: async () => recoveryLease(),
      resolveAuthoritativeExit,
      workflow: { execute },
    });

    const result = await adapter.handleFinalizedExit(exit());

    expect(result).toMatchObject({
      kind: 'operation',
      operationId: 'resume-fallback:v1:task%3A1:agent%2Fa:7',
      result: { projection: { operation: { phase: 'running', sourceGeneration: 7 } } },
    });
    expect(execute).toHaveBeenCalledWith({
      admission: { kind: 'resume-fallback-system' },
      agentId: 'agent/a',
      controllerId: 'system:agent-session-recovery-v1',
      expectedLeaseGeneration: 11,
      expectedSourceGeneration: 7,
      launchReason: 'resume-fallback',
      mode: 'fresh',
      operationId: 'resume-fallback:v1:task%3A1:agent%2Fa:7',
      taskId: 'task:1',
    });
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain(
      'No conversation found to continue',
    );
    expect(resolveAuthoritativeExit).toHaveBeenCalledWith({
      agentId: 'agent/a',
      exitCode: 1,
      generation: 7,
      resumed: true,
      signal: null,
      taskId: 'task:1',
    });
  });

  it('acquires and releases the short system lease only after an eligible decision', async () => {
    const eligibleRelease = vi.fn();
    const acquireSystemLease = vi.fn(async () => recoveryLease(eligibleRelease));
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease,
      resolveAuthoritativeExit: async () => SUPPORTED_CONTEXT,
      workflow: { execute: async (request) => operationResult(request.operationId) },
    });

    await adapter.handleFinalizedExit(exit());
    await adapter.handleFinalizedExit(exit({ lastOutput: ['different failure'] }));

    expect(eligibleRelease).toHaveBeenCalledOnce();
    expect(acquireSystemLease).toHaveBeenCalledOnce();
  });

  it('uses the same operation ID for concurrent observations of the same generation', async () => {
    const execute = vi.fn(async (request: AgentSessionOperationRequest) =>
      operationResult(request.operationId),
    );
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease: async () => recoveryLease(),
      resolveAuthoritativeExit: async () => SUPPORTED_CONTEXT,
      workflow: { execute },
    });

    await Promise.all([adapter.handleFinalizedExit(exit()), adapter.handleFinalizedExit(exit())]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].operationId).toBe(execute.mock.calls[1]?.[0].operationId);
  });

  it.each([
    [{ resumed: false }, 'not-resumed'],
    [{ exitCode: 0 }, 'successful-exit'],
    [{ signal: 'SIGTERM' }, 'signal'],
    [{ lastOutput: ['different failure'] }, 'no-match'],
  ] as const)(
    'does not request a workflow for an ineligible exit %#',
    async (overrides, reason) => {
      const execute = vi.fn();
      const adapter = createAgentSessionRecoveryAdapter({
        acquireSystemLease: async () => recoveryLease(),
        resolveAuthoritativeExit: async () => SUPPORTED_CONTEXT,
        workflow: { execute },
      });

      await expect(adapter.handleFinalizedExit(exit(overrides))).resolves.toEqual({
        decision: { kind: 'ineligible', reason },
        kind: 'ineligible',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('does not infer capability from a custom Claude identity or executable-shaped ID', async () => {
    const execute = vi.fn();
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease: async () => recoveryLease(),
      resolveAuthoritativeExit: async () => ({
        agentDef: { id: '/usr/local/bin/claude' },
        currentGeneration: 7,
        trust: 'built-in-catalog',
      }),
      workflow: { execute },
    });

    await expect(adapter.handleFinalizedExit(exit())).resolves.toEqual({
      decision: { kind: 'ineligible', reason: 'unsupported' },
      kind: 'ineligible',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...SUPPORTED_CONTEXT, currentGeneration: 8 },
    { ...SUPPORTED_CONTEXT, trust: 'forged' },
  ])('fails closed for unavailable, stale, or untrusted authority context %#', async (context) => {
    const execute = vi.fn();
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease: async () => recoveryLease(),
      resolveAuthoritativeExit: async () =>
        context as AuthoritativeAgentSessionRecoveryContext | null,
      workflow: { execute },
    });

    await expect(adapter.handleFinalizedExit(exit())).resolves.toEqual({ kind: 'unavailable' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the dark workflow result and exposes no retry side effect of its own', async () => {
    const execute = vi.fn(async () => ({
      failure: 'session-state-unavailable' as const,
      kind: 'admission-unavailable' as const,
    }));
    const adapter = createAgentSessionRecoveryAdapter({
      acquireSystemLease: async () => recoveryLease(),
      resolveAuthoritativeExit: async () => SUPPORTED_CONTEXT,
      workflow: { execute },
    });

    await expect(adapter.handleFinalizedExit(exit())).resolves.toEqual({ kind: 'unavailable' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('contains no exit subscription, public handler, or transport registration', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('./agent-session-recovery.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/ipcMain|register.*Handler|\.on\(['"]exit|channels\.ts/u);
  });
});
