import type { JsonObject } from './workspace-state-storage.js';
import { resolvePersistedTaskMode } from '../../src/domain/task-mode.js';
import type { StorageEnv } from './storage.js';
import type { AgentSessionWorkflow } from './agent-session-workflow.js';
import {
  createTaskCreationJournal,
  type TaskCreationJournal,
  type TaskCreationJournalOptions,
} from './task-creation-journal.js';
import {
  createTaskCreationOperationTicketIssuer,
  type TaskCreationOperationTicketIssuer,
} from './task-creation-operation-ticket.js';
import {
  createTaskCreationOwnerCapabilityBundle,
  type TaskCreationOwnerCapabilityBundle,
} from './task-creation-owner-capability.js';
import {
  createTaskCreationWorkflow,
  type ActiveTaskCreationWorkflow,
  type TaskCreationWorkflowDependencies,
} from './task-creation-workflow.js';
import type { TaskShellSessionJournal } from './task-shell-session-journal.js';
import type { TaskShellSessionWorkflow } from './task-shell-session-workflow.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import type {
  ExistingTaskCreationCutoverEvidence,
  ManagedTaskCreationCutoverClassifier,
  TaskStructureMutationService,
} from './task-structure-mutations.js';

export interface ActivateTaskCreationRuntimeDependencies extends Pick<
  TaskCreationWorkflowDependencies,
  'authorization' | 'current' | 'preparation'
> {
  agentSession: Pick<AgentSessionWorkflow, 'execute' | 'getOwnerAvailability' | 'removalHooks'>;
  creationJournal?: TaskCreationJournal;
  creationJournalOptions?: TaskCreationJournalOptions;
  env: StorageEnv;
  initialPrompt: Pick<
    TaskInitialPromptDeliveryService,
    'getOwnerAvailability' | 'getProjection' | 'queue'
  >;
  now?: () => number;
  shell: TaskShellSessionWorkflow;
  shellJournal: TaskShellSessionJournal;
  structure: TaskStructureMutationService;
  tickets?: TaskCreationOperationTicketIssuer;
  writerClassifier?: ManagedTaskCreationCutoverClassifier;
}

export interface TaskCreationRuntime {
  journal: TaskCreationJournal;
  ownerCapability: TaskCreationOwnerCapabilityBundle;
  tickets: TaskCreationOperationTicketIssuer;
  workflow: ActiveTaskCreationWorkflow;
}

export const migratePreManagedTaskCreation: ManagedTaskCreationCutoverClassifier = {
  async classify(
    _taskId: string,
    canonicalTask: Readonly<JsonObject>,
  ): Promise<ExistingTaskCreationCutoverEvidence> {
    const taskMode = resolvePersistedTaskMode(canonicalTask.taskMode);
    if (taskMode === 'agent') {
      return {
        operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
        shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
      };
    }
    if (taskMode === 'terminal') {
      return {
        operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
        shellOwnership: { kind: 'legacy-unmanaged-terminal', migrationSchemaVersion: 1 },
      };
    }
    throw new Error('Pre-managed task has no canonical task mode');
  },
};

async function activateJournal(
  journal: Pick<TaskCreationJournal, 'activateFresh' | 'getHealth' | 'startup'>,
): Promise<void> {
  const startup = await journal.startup();
  const active = startup.health === 'activation-required' ? await journal.activateFresh() : startup;
  if (active.health !== 'healthy' || journal.getHealth() !== 'healthy') {
    throw new Error(`Task-creation journal is unavailable (${active.health})`);
  }
}

async function activateShellJournal(
  journal: Pick<TaskShellSessionJournal, 'activateFresh' | 'getHealth' | 'startup'>,
): Promise<void> {
  const startup = await journal.startup();
  const active = startup.health === 'activation-required' ? await journal.activateFresh() : startup;
  if (active.health !== 'healthy' || journal.getHealth() !== 'healthy') {
    throw new Error(`Task-shell-session journal is unavailable (${active.health})`);
  }
}

/**
 * Commit-6 activation after the generic removal/D01/D11 cutover. Journals and
 * the managed writer become healthy before any workflow is returned; an owner
 * epoch mismatch fails closed and exposes no command owner.
 */
export async function activateTaskCreationRuntime(
  dependencies: ActivateTaskCreationRuntimeDependencies,
): Promise<TaskCreationRuntime> {
  const journal =
    dependencies.creationJournal ??
    createTaskCreationJournal(dependencies.env, dependencies.creationJournalOptions);
  await Promise.all([activateJournal(journal), activateShellJournal(dependencies.shellJournal)]);
  await dependencies.structure.activateManagedTaskCreationWriter(
    dependencies.writerClassifier ?? migratePreManagedTaskCreation,
  );
  await dependencies.shell.repairAfterRestart();

  const ownerCapability = createTaskCreationOwnerCapabilityBundle({
    agentSession: dependencies.agentSession,
    initialPrompt: dependencies.initialPrompt,
    shellJournal: dependencies.shellJournal,
    structure: dependencies.structure,
  });
  const deployment = await ownerCapability.getDeploymentCapability();
  if (deployment.kind !== 'active') {
    throw new Error(`Task-creation owner activation failed (${deployment.reason})`);
  }
  const tickets =
    dependencies.tickets ??
    createTaskCreationOperationTicketIssuer({
      isOperationIdInUse: (operationId) => journal.hasOperationId(operationId),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
  const workflow = createTaskCreationWorkflow({
    agentSession: dependencies.agentSession,
    authorization: dependencies.authorization,
    current: dependencies.current,
    initialPrompt: dependencies.initialPrompt,
    journal,
    ownerCapability,
    preparation: dependencies.preparation,
    shell: dependencies.shell,
    structure: dependencies.structure,
    tickets,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  return { journal, ownerCapability, tickets, workflow };
}
