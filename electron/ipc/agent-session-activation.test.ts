import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  type AgentSessionOperationRequest,
} from '../../src/domain/agent-session-operation.js';
import {
  createMemoryAgentSessionOperationJournal,
  deriveAgentSessionOperationFingerprint,
} from './agent-session-operation-journal.js';
import {
  createProductionAgentSessionRuntime,
  isTrustedBuiltInResumeFallbackDefinition,
} from './agent-session-runtime.js';
import { createAgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import type { HandlerContext } from './handler-context.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';

const CUTOVER_EPOCH = 'agent-session-cutover-1';

function replacementRequest(): AgentSessionOperationRequest {
  return {
    admission: { kind: 'task-command' },
    agentId: 'agent-1',
    controllerId: 'controller-1',
    expectedLeaseGeneration: 4,
    expectedSourceGeneration: 4,
    launchReason: 'manual-restart',
    mode: 'fresh',
    operationId: 'operation-1',
    taskId: 'task-1',
  };
}

function createHarness() {
  let active = false;
  let hookSetVersion: string = AGENT_SESSION_OWNER_HOOK_SET_VERSION;
  const current = {
    catalogVersion: 7,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present' as const,
  };
  const gate = {
    getTaskSnapshot: vi.fn(() =>
      active && hookSetVersion === AGENT_SESSION_OWNER_HOOK_SET_VERSION
        ? {
            current,
            cutoverEpoch: CUTOVER_EPOCH,
            hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
            kind: 'active' as const,
          }
        : ({ kind: 'unavailable' as const } as const),
    ),
    verifyCommittedRemoval: vi.fn(() => true),
  };
  const structure = {
    createTaskRemovalParticipantGate: vi.fn(() => gate),
    getTaskRemovalOwnerCapability: vi.fn(() =>
      active
        ? {
            cutoverEpoch: CUTOVER_EPOCH,
            hookSetVersions: {
              'agent-session': hookSetVersion,
              'initial-prompt': 'task-initial-prompt-hooks-v1',
              'task-runtime': 'task-runtime-removal-v1',
            },
            kind: 'active' as const,
            schemaVersion: 1 as const,
          }
        : null,
    ),
  } as unknown as TaskStructureMutationService;
  const writer = createAgentSessionWriterRuntime({ getCurrentGeneration: () => null });
  const journal = createMemoryAgentSessionOperationJournal();
  const runtime = createProductionAgentSessionRuntime({
    context: {
      isPackaged: true,
      sendToChannel: vi.fn(),
      userDataPath: '/unused',
    } satisfies HandlerContext,
    journal,
    privateAuthority: {} as WorkspacePrivateMutationAuthority,
    structure,
    writer,
  });
  return {
    activate() {
      active = true;
      writer.activate(CUTOVER_EPOCH);
    },
    journal,
    runtime,
    setHookSetVersion(next: string) {
      hookSetVersion = next;
    },
  };
}

describe('production agent-session activation', () => {
  it('binds automatic fallback trust to exact built-in launch semantics', () => {
    const trusted = {
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resume_args: ['--continue'],
      resume_failure_classifier: 'claude-no-conversation-v1' as const,
      resume_failure_fallback: 'fresh-start' as const,
      resume_strategy: 'cli-args' as const,
      skip_permissions_args: ['--dangerously-skip-permissions'],
      description: 'Claude',
    };

    expect(isTrustedBuiltInResumeFallbackDefinition({}, trusted)).toBe(true);
    expect(
      isTrustedBuiltInResumeFallbackDefinition({}, { ...trusted, command: '/tmp/claude' }),
    ).toBe(false);
    expect(isTrustedBuiltInResumeFallbackDefinition({}, { ...trusted, args: ['--forged'] })).toBe(
      false,
    );
    expect(
      isTrustedBuiltInResumeFallbackDefinition({}, { ...trusted, env: { TOKEN: 'forged' } }),
    ).toBe(false);
    expect(
      isTrustedBuiltInResumeFallbackDefinition({ customAgents: [{ ...trusted }] }, trusted),
    ).toBe(false);
  });

  it('loads its journal dark and exposes neither projections nor subscriptions before cutover', async () => {
    const harness = createHarness();

    await expect(harness.runtime.startup()).resolves.toBeUndefined();
    await expect(
      harness.runtime.getProjection({ agentId: 'agent-1', taskId: 'task-1' }),
    ).resolves.toBeNull();
    expect(() => harness.runtime.subscribe(vi.fn())).toThrow(
      'subscriptions require the active session owner',
    );
    expect(harness.journal.getCounts()).toEqual({
      activeOperations: 0,
      identityMarkers: 0,
      terminalResponses: 0,
    });
  });

  it('publishes safe current state only under the exact active epoch and hook version', async () => {
    const harness = createHarness();
    await harness.runtime.startup();
    const request = replacementRequest();
    await harness.journal.saveOperation({
      agentDefId: 'claude-code',
      createdAtMs: 10,
      fingerprint: deriveAgentSessionOperationFingerprint({
        agentDefId: 'claude-code',
        request,
      }),
      request,
      snapshot: {
        agentId: request.agentId,
        launchReason: request.launchReason,
        operationId: request.operationId,
        phase: 'running',
        resumed: false,
        sourceGeneration: request.expectedSourceGeneration,
        targetGeneration: 5,
        taskId: request.taskId,
        version: 4,
      },
      updatedAtMs: 20,
    });
    harness.activate();

    const stop = harness.runtime.subscribe(vi.fn());
    expect(stop).toBeTypeOf('function');
    await expect(
      harness.runtime.getProjection({ agentId: 'agent-1', taskId: 'task-1' }),
    ).resolves.toEqual({
      current: expect.objectContaining({ taskState: 'present', taskClosing: false }),
      operation: expect.objectContaining({ operationId: 'operation-1', phase: 'running' }),
    });

    harness.setHookSetVersion('wrong-version');
    expect(() => harness.runtime.subscribe(vi.fn())).toThrow(
      'subscriptions require the active session owner',
    );
    await expect(
      harness.runtime.getProjection({ agentId: 'agent-1', taskId: 'task-1' }),
    ).resolves.toBeNull();
    stop();
  });
});
