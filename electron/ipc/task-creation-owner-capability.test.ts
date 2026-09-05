import { describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import {
  createTaskCreationOwnerCapabilityBundle,
  type TaskCreationOwnerCapabilityDependencies,
} from './task-creation-owner-capability.js';

const CUTOVER = 'cutover-1';

function dependencies(
  overrides: Partial<TaskCreationOwnerCapabilityDependencies> = {},
): TaskCreationOwnerCapabilityDependencies {
  return {
    agentSession: {
      getOwnerAvailability: async () => ({
        current: {
          catalogVersion: 0,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskState: 'not-visible',
        },
        cutoverEpoch: CUTOVER,
        hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        kind: 'active',
      }),
      removalHooks: {
        drainTaskAgentSessionsForRemoval: vi.fn(),
        finalizeRemovedTaskAgentSessionState: vi.fn(),
        hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        probe: async () => ({
          hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          kind: 'ready' as const,
        }),
      },
    },
    initialPrompt: {
      getOwnerAvailability: () => ({
        cutoverEpoch: CUTOVER,
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active' as const,
      }),
    },
    shellJournal: {
      getHealth: () => 'healthy',
      getTopologyEpoch: () => 'topology-1',
    },
    structure: {
      getManagedTaskCreationWriterCapability: () => ({
        cutoverEpoch: CUTOVER,
        hookSetVersions: {
          'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          'task-runtime': TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
        },
        kind: 'active' as const,
        writerEpoch: 'managed-initial-shell-v1',
      }),
    },
    ...overrides,
  };
}

describe('task-creation owner capability bundle', () => {
  it('advertises active only when the real writer, D01, D11, and shell topology agree', async () => {
    const bundle = createTaskCreationOwnerCapabilityBundle(dependencies());
    await expect(bundle.getDeploymentCapability()).resolves.toEqual({
      cutoverEpoch: CUTOVER,
      hookSetVersions: {
        agentSession: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        initialPrompt: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      },
      kind: 'active',
      shellTopologyEpoch: 'topology-1',
      writerEpoch: 'managed-initial-shell-v1',
    });
    await expect(bundle.getTaskAdmissionCapability('future-task-1')).resolves.toMatchObject({
      kind: 'active',
    });
  });

  it.each([
    {
      expected: 'managed-writer-inactive',
      mutate: (value: TaskCreationOwnerCapabilityDependencies) => {
        value.structure.getManagedTaskCreationWriterCapability = () => null;
      },
    },
    {
      expected: 'initial-prompt-owner-inactive',
      mutate: (value: TaskCreationOwnerCapabilityDependencies) => {
        value.initialPrompt.getOwnerAvailability = () => ({
          kind: 'dark' as const,
          reason: 'delivery-owner-dark',
        });
      },
    },
    {
      expected: 'owner-epoch-mismatch',
      mutate: (value: TaskCreationOwnerCapabilityDependencies) => {
        value.initialPrompt.getOwnerAvailability = () => ({
          cutoverEpoch: 'other',
          hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          kind: 'active' as const,
        });
      },
    },
    {
      expected: 'shell-journal-unavailable',
      mutate: (value: TaskCreationOwnerCapabilityDependencies) => {
        value.shellJournal.getHealth = () => 'recovery-required';
      },
    },
  ])('fails deployment closed for $expected', async ({ expected, mutate }) => {
    const deps = dependencies();
    mutate(deps);
    await expect(
      createTaskCreationOwnerCapabilityBundle(deps).getDeploymentCapability(),
    ).resolves.toEqual({ kind: 'unavailable', reason: expected });
  });

  it('requires D11 public admission for both deployment and task admission', async () => {
    const deps = dependencies();
    deps.agentSession.getOwnerAvailability = async () => ({
      kind: 'dark' as const,
      reason: 'session-owner-dark',
    });
    const bundle = createTaskCreationOwnerCapabilityBundle(deps);
    await expect(bundle.getDeploymentCapability()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'agent-session-owner-inactive',
    });
    await expect(bundle.getTaskAdmissionCapability('future-task-1')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'agent-session-owner-inactive',
    });
  });

  it('rejects a D11 owner bound to another removal epoch', async () => {
    const deps = dependencies();
    deps.agentSession.getOwnerAvailability = async () => ({
      current: {
        catalogVersion: 0,
        serverInstanceId: 'server-1',
        taskClosing: false,
        taskState: 'not-visible',
      },
      cutoverEpoch: 'other-cutover',
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      kind: 'active' as const,
    });
    await expect(
      createTaskCreationOwnerCapabilityBundle(deps).getTaskAdmissionCapability('future-task-1'),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'owner-epoch-mismatch' });
  });
});
