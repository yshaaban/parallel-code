import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import {
  TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
  type TaskRemovalOwnerCapability,
} from '../../src/domain/task-removal-owner.js';
import type { AgentSessionRemovalOwnerHooks } from './agent-session-workflow.js';
import type { AgentSessionLegacyWriterCutover } from './agent-session-removal-participant.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import type { WorkspaceTaskInitialPromptPersistence } from './task-initial-prompt-delivery-persistence.js';
import type { TaskNotesStructuralAuthority } from './task-notes-service.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import { activateDarkTaskStructuralOwners } from './task-structural-runtime-activation.js';
import type { TaskRuntimeRemovalParticipant } from './task-runtime-removal-participant.js';

describe('dark task structural runtime activation', () => {
  it('composes the exact D01/D11 participants before activating notes', async () => {
    const calls: string[] = [];
    let registered: readonly TaskRemovalOwnerParticipant[] = [];
    const removal: TaskRemovalOwnerCapability = {
      cutoverEpoch: 'removal-epoch',
      hookSetVersions: {
        'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        'task-runtime': TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
      },
      kind: 'active',
      schemaVersion: 1,
    };
    const notes = {} as TaskNotesStructuralAuthority;
    const structure = {
      async activateTaskNotesStructuralAuthority() {
        calls.push('notes');
        return notes;
      },
      async activateTaskRemovalOwner(participants: readonly TaskRemovalOwnerParticipant[]) {
        calls.push('removal');
        registered = participants;
        return removal;
      },
    } as unknown as TaskStructureMutationService;

    await expect(
      activateDarkTaskStructuralOwners({
        agentSession: {
          hooks: {} as AgentSessionRemovalOwnerHooks,
          legacyWriterCutover: {} as AgentSessionLegacyWriterCutover,
        },
        initialPrompt: {
          persistence: {} as WorkspaceTaskInitialPromptPersistence,
          service: {} as TaskInitialPromptDeliveryService,
        },
        structure,
        taskRuntime: {
          participant: {
            activateLegacyEffectCutover: async () => undefined,
            async cleanupTaskRuntimeStep(request) {
              return {
                evidence: { state: 'test-complete' },
                kind: 'step-complete',
                step: request.step,
              };
            },
            drainTaskForRemoval: async () => ({ kind: 'complete' }),
            finalizeRemovedTaskState: async () => ({ kind: 'complete' }),
            hookSetVersion: TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
            id: 'task-runtime',
            probe: async () => ({
              hookSetVersion: TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
              kind: 'ready',
            }),
            verifyLegacyEffectCutover: async () => undefined,
          } satisfies TaskRuntimeRemovalParticipant,
        },
      }),
    ).resolves.toEqual({ notes, removal });
    expect(calls).toEqual(['removal', 'notes']);
    expect(registered.map(({ hookSetVersion, id }) => ({ hookSetVersion, id }))).toEqual([
      { hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION, id: 'initial-prompt' },
      { hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION, id: 'agent-session' },
      { hookSetVersion: TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION, id: 'task-runtime' },
    ]);
  });
});
