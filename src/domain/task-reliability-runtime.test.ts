import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  isRendererAgentSessionOperationRequest,
} from './agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from './task-initial-prompt-delivery.js';
import {
  eventMatchesTaskReliabilityCapabilities,
  isActiveTaskReliabilityRuntimeCapabilities,
  isTaskReliabilityRuntimeEvent,
  TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
  type ActiveTaskReliabilityRuntimeCapabilities,
} from './task-reliability-runtime.js';

function capabilities(): ActiveTaskReliabilityRuntimeCapabilities {
  return {
    agentSessions: {
      automaticResumeFallback: false,
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      initialLaunch: true,
      manualReplacement: true,
    },
    contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
    cutoverEpoch: 'cutover-1',
    initialPromptDelivery: {
      enabled: true,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    },
    kind: 'active',
    serverInstanceId: 'server-1',
  };
}

function sessionProjection() {
  return {
    current: {
      catalogVersion: 4,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'present' as const,
    },
    operation: {
      agentId: 'agent-1',
      launchReason: 'manual-resume' as const,
      operationId: 'operation-1',
      phase: 'running' as const,
      resumed: true,
      sourceGeneration: 2,
      targetGeneration: 3,
      taskId: 'task-1',
      version: 3,
    },
  };
}

describe('task reliability runtime wire contract', () => {
  it('accepts only exact, hook-version-bound active capability bundles', () => {
    expect(isActiveTaskReliabilityRuntimeCapabilities(capabilities())).toBe(true);
    expect(
      isActiveTaskReliabilityRuntimeCapabilities({ ...capabilities(), cutoverEpoch: '../escape' }),
    ).toBe(false);
    expect(
      isActiveTaskReliabilityRuntimeCapabilities({
        ...capabilities(),
        agentSessions: { ...capabilities().agentSessions, hookSetVersion: 'future-hooks' },
      }),
    ).toBe(false);
    expect(
      isActiveTaskReliabilityRuntimeCapabilities({ ...capabilities(), privateGateRecord: true }),
    ).toBe(false);
  });

  it('keeps initial launch and automatic fallback outside renderer authority', () => {
    const manual = {
      admission: { kind: 'task-command' },
      agentId: 'agent-1',
      controllerId: 'controller-1',
      expectedLeaseGeneration: 2,
      expectedSourceGeneration: 3,
      launchReason: 'manual-restart',
      mode: 'fresh',
      operationId: 'operation-1',
      taskId: 'task-1',
    };
    expect(isRendererAgentSessionOperationRequest(manual)).toBe(true);
    expect(
      isRendererAgentSessionOperationRequest({
        ...manual,
        admission: { kind: 'resume-fallback-system' },
        launchReason: 'resume-fallback',
      }),
    ).toBe(false);
    expect(
      isRendererAgentSessionOperationRequest({
        admission: {
          committedWorkspaceRevision: 2,
          creationOperationId: 'creation-1',
          kind: 'task-creation',
        },
        agentId: 'agent-1',
        expectedLeaseGeneration: null,
        expectedSourceGeneration: null,
        launchReason: 'initial',
        mode: 'initial',
        nextAgentDefId: 'claude-code',
        operationId: 'operation-1',
        taskId: 'task-1',
      }),
    ).toBe(false);
  });

  it('validates live projections and binds them to both server and cutover identities', () => {
    const event = {
      cutoverEpoch: 'cutover-1',
      kind: 'agent-session-operation-changed' as const,
      projection: sessionProjection(),
      serverInstanceId: 'server-1',
    };
    expect(isTaskReliabilityRuntimeEvent(event)).toBe(true);
    expect(eventMatchesTaskReliabilityCapabilities(event, capabilities())).toBe(true);
    expect(
      eventMatchesTaskReliabilityCapabilities(
        { ...event, cutoverEpoch: 'cutover-2' },
        capabilities(),
      ),
    ).toBe(false);
    expect(
      isTaskReliabilityRuntimeEvent({
        ...event,
        projection: {
          ...event.projection,
          privateRemovalOperationId: 'delete-1',
        },
      }),
    ).toBe(false);
  });
});
