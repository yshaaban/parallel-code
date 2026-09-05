import type { TaskRemovalOwnerCapability } from '../../src/domain/task-removal-owner.js';
import type { AgentSessionRemovalOwnerHooks } from './agent-session-workflow.js';
import {
  createAgentSessionRemovalParticipant,
  type AgentSessionLegacyWriterCutover,
} from './agent-session-removal-participant.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import type { WorkspaceTaskInitialPromptPersistence } from './task-initial-prompt-delivery-persistence.js';
import { createTaskInitialPromptRemovalParticipant } from './task-initial-prompt-removal-participant.js';
import type { TaskNotesStructuralAuthority } from './task-notes-service.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { TaskRuntimeRemovalParticipant } from './task-runtime-removal-participant.js';

export interface DarkTaskStructuralOwnerDependencies {
  agentSession: {
    hooks: AgentSessionRemovalOwnerHooks;
    legacyWriterCutover: AgentSessionLegacyWriterCutover;
  };
  initialPrompt: {
    persistence: WorkspaceTaskInitialPromptPersistence;
    service: TaskInitialPromptDeliveryService;
  };
  structure: TaskStructureMutationService;
  taskRuntime: {
    participant: TaskRuntimeRemovalParticipant;
  };
}

export interface DarkTaskStructuralOwnerCapability {
  notes: TaskNotesStructuralAuthority;
  removal: TaskRemovalOwnerCapability;
}

/**
 * The sole backend activation sequence for the already-composed D01, D11,
 * generic-removal, and notes structural owners. It intentionally accepts the
 * real runtime owners rather than constructing fake terminal/session seams,
 * and it registers no IPC handler or UI capability.
 */
export async function activateDarkTaskStructuralOwners(
  dependencies: DarkTaskStructuralOwnerDependencies,
): Promise<DarkTaskStructuralOwnerCapability> {
  const removal = await dependencies.structure.activateTaskRemovalOwner([
    createTaskInitialPromptRemovalParticipant(dependencies.initialPrompt),
    createAgentSessionRemovalParticipant(dependencies.agentSession),
    dependencies.taskRuntime.participant,
  ]);
  const notes = await dependencies.structure.activateTaskNotesStructuralAuthority();
  return { notes, removal };
}
