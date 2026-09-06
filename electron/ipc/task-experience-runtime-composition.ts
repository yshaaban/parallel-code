import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import {
  TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
  type ActiveTaskReliabilityRuntimeCapabilities,
} from '../../src/domain/task-reliability-runtime.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import type { TaskNameRegistry } from '../../server/task-names.js';
import { collectRuntimeCleanupFailures, type RuntimeCleanupFailure } from '../runtime-cleanup.js';
import { cleanupCoordinatorTaskStateAndOwnedSubtasks } from '../coordinator/tool-gateway.js';
import { warn as logWarn } from '../log.js';
import { IPC } from './channels.js';
import {
  createTrustedCoordinatorTaskCreationWorkflow,
  type TrustedCoordinatorTaskCreationWorkflow,
} from './coordinator-task-creation-workflow.js';
import { createProductionAgentSessionRuntime } from './agent-session-runtime.js';
import { createTaskCollapseWorkflow, type TaskCollapseWorkflow } from './task-collapse-workflow.js';
import { isTaskCommandLeaseHeld } from './task-command-leases.js';
import { stopAllTaskAgentWorkflows } from './task-workflows.js';
import type { HandlerContext } from './handler-context.js';
import type { TaskCatalogState } from './task-catalog-state.js';
import { createTaskCreationJournal } from './task-creation-journal.js';
import {
  createTrustedLocalTaskCreationCommand,
  type TrustedLocalTaskCreationCommand,
} from './task-creation-local-command.js';
import {
  createTaskCreationLocalReconciliationCommands,
  type TaskCreationLocalReconciliationCommands,
} from './task-creation-local-reconciliation.js';
import { createProductionTaskCreationPreparationOwner } from './task-creation-preparation-owner.js';
import { activateTaskCreationRuntime, type TaskCreationRuntime } from './task-creation-runtime.js';
import type { ActiveTaskCreationWorkflow } from './task-creation-workflow.js';
import type { TaskExperienceRemoteRuntime } from './task-experience-remote-registrations.js';
import {
  createProductionTaskInitialPromptRuntime,
  type ProductionTaskInitialPromptRuntime,
} from './task-initial-prompt-runtime.js';
import { TaskNotesService } from './task-notes-service.js';
import { executeBackendTaskMergeGit } from './task-git-handlers.js';
import { activateTaskMergeBackend, type ActiveTaskMergeBackend } from './task-merge-workflow.js';
import { createTaskRuntimeRemovalParticipant } from './task-runtime-removal-participant.js';
import {
  createProductionTaskShellSessionRuntime,
  type ProductionTaskShellSessionRuntime,
} from './task-shell-session-runtime.js';
import type { TaskShellSessionCleanRestartCandidate } from './task-shell-session-workflow.js';
import { activateDarkTaskStructuralOwners } from './task-structural-runtime-activation.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspaceMutationService } from './workspace-state-mutations.js';

export interface ProductionTaskExperienceRuntime extends TaskExperienceRemoteRuntime {
  agentSession: ReturnType<typeof createProductionAgentSessionRuntime>;
  capabilities: ActiveTaskReliabilityRuntimeCapabilities;
  close(): Promise<void>;
  coordinatorCreation: TrustedCoordinatorTaskCreationWorkflow;
  creationRuntime: TaskCreationRuntime;
  initialPrompt: ProductionTaskInitialPromptRuntime;
  localCreation: TrustedLocalTaskCreationCommand;
  localReconciliation: TaskCreationLocalReconciliationCommands;
  merge: ActiveTaskMergeBackend;
  shell: ProductionTaskShellSessionRuntime;
  collapse: TaskCollapseWorkflow;
}

export interface CreateProductionTaskExperienceRuntimeDependencies {
  catalog: TaskCatalogState;
  context: HandlerContext;
  serverInstanceId: string;
  structure?: TaskStructureMutationService;
  taskNames: TaskNameRegistry;
  workspace?: WorkspaceMutationService;
}

export type TaskExperienceRuntimeCleanupLabel =
  | 'agent clean-shutdown completion'
  | 'agent clean-shutdown preparation'
  | 'agent runner'
  | 'agent session'
  | 'creation journal'
  | 'initial prompt'
  | 'prompt admission binding'
  | 'shell clean-restart permit'
  | 'shell clean-restart preparation'
  | 'shell session';

export class TaskExperienceRuntimeCleanupError extends Error {
  readonly failures: Array<RuntimeCleanupFailure<TaskExperienceRuntimeCleanupLabel>>;

  constructor(failures: Array<RuntimeCleanupFailure<TaskExperienceRuntimeCleanupLabel>>) {
    super(
      `Task-experience runtime cleanup failed: ${failures
        .map((failure) => failure.label)
        .join(', ')}`,
    );
    this.name = 'TaskExperienceRuntimeCleanupError';
    this.failures = failures;
  }
}

export class TaskShellCleanRestartPermitError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super('One or more shell clean-restart permits could not be saved');
    this.name = 'TaskShellCleanRestartPermitError';
    this.errors = errors;
  }
}

export class TaskExperienceRuntimeActivationError extends Error {
  readonly errors: [unknown, unknown];
  private cleanupAttempt: Promise<void> | null = null;

  constructor(
    readonly activationError: unknown,
    readonly cleanupError: unknown,
    private readonly cleanup: () => Promise<void>,
  ) {
    super('Task-experience runtime activation failed and cleanup also failed');
    this.name = 'TaskExperienceRuntimeActivationError';
    this.errors = [activationError, cleanupError];
  }

  retryCleanup(): Promise<void> {
    if (!this.cleanupAttempt) {
      const attempt = Promise.resolve().then(this.cleanup);
      this.cleanupAttempt = attempt;
      void attempt.catch(() => {
        if (this.cleanupAttempt === attempt) this.cleanupAttempt = null;
      });
    }
    return this.cleanupAttempt;
  }
}

export async function settleTaskExperienceRuntimeCleanupOwners(
  owners: ReadonlyArray<{
    cleanup: () => Promise<void> | void;
    label: TaskExperienceRuntimeCleanupLabel;
  }>,
): Promise<void> {
  const failures = await collectRuntimeCleanupFailures(
    owners.map((owner) => ({
      cleanup: Promise.resolve().then(owner.cleanup),
      label: owner.label,
    })),
  );
  if (failures.length > 0) {
    throw new TaskExperienceRuntimeCleanupError(failures);
  }
}

interface TaskExperienceCleanShutdownAgentSessionOwner {
  closeWithoutRestartPermit(): Promise<void>;
  completeCleanShutdown(): Promise<void>;
  prepareCleanShutdown(): Promise<void>;
}

interface TaskExperienceCleanShutdownShellOwner {
  abortCleanRestartDrain(): boolean;
  beginCleanRestartDrain(): Promise<TaskShellSessionCleanRestartCandidate[]>;
  close(): Promise<void>;
  persistCleanRestartPermit(
    candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): Promise<{ kind: 'prepared' } | { kind: 'unavailable'; reason: string }>;
}

export interface CoordinateTaskExperienceCleanShutdownDependencies {
  agentSession: TaskExperienceCleanShutdownAgentSessionOwner;
  closeOwners: ReadonlyArray<{
    cleanup: () => Promise<void> | void;
    label: TaskExperienceRuntimeCleanupLabel;
  }>;
  shell: TaskExperienceCleanShutdownShellOwner;
  stopAgentRunners(): Promise<void>;
}

async function collectTaskExperienceCleanupPhaseFailures(
  failures: Array<RuntimeCleanupFailure<TaskExperienceRuntimeCleanupLabel>>,
  owners: ReadonlyArray<{
    cleanup: () => Promise<void> | void;
    label: TaskExperienceRuntimeCleanupLabel;
  }>,
): Promise<void> {
  failures.push(
    ...(await collectRuntimeCleanupFailures(
      owners.map((owner) => ({
        cleanup: Promise.resolve().then(owner.cleanup),
        label: owner.label,
      })),
    )),
  );
}

async function persistEveryShellCleanRestartPermit(
  shell: TaskExperienceCleanShutdownShellOwner,
  candidates: readonly TaskShellSessionCleanRestartCandidate[],
): Promise<void> {
  const results = await Promise.allSettled(
    candidates.map((candidate) => shell.persistCleanRestartPermit(candidate)),
  );
  const errors = results.flatMap((result, index): unknown[] => {
    if (result.status === 'rejected') {
      return [result.reason];
    }
    if (result.value.kind === 'prepared') return [];
    const candidate = candidates[index];
    return [
      {
        candidate: candidate ? structuredClone(candidate) : null,
        result: structuredClone(result.value),
      },
    ];
  });
  if (errors.length > 0) {
    throw new TaskShellCleanRestartPermitError(errors);
  }
}

/**
 * Closes every spawn admission before stopping processes and only persists
 * restart permits after the global runner owner proves that every process is
 * gone. A failed preparation or stop permanently takes the no-permit path.
 */
export async function coordinateTaskExperienceCleanShutdown(
  dependencies: CoordinateTaskExperienceCleanShutdownDependencies,
): Promise<void> {
  const failures: Array<RuntimeCleanupFailure<TaskExperienceRuntimeCleanupLabel>> = [];
  let candidates: TaskShellSessionCleanRestartCandidate[] = [];
  let shellPermitsCompleted = false;

  await collectTaskExperienceCleanupPhaseFailures(failures, [
    {
      cleanup: () => dependencies.agentSession.prepareCleanShutdown(),
      label: 'agent clean-shutdown preparation',
    },
    {
      cleanup: async () => {
        candidates = await dependencies.shell.beginCleanRestartDrain();
      },
      label: 'shell clean-restart preparation',
    },
  ]);
  const preparationSucceeded = failures.length === 0;

  const stopFailureOffset = failures.length;
  await collectTaskExperienceCleanupPhaseFailures(failures, [
    { cleanup: () => dependencies.stopAgentRunners(), label: 'agent runner' },
  ]);
  const stopSucceeded = failures.length === stopFailureOffset;
  const noPermitShutdown = !preparationSucceeded || !stopSucceeded;

  if (!noPermitShutdown) {
    await collectTaskExperienceCleanupPhaseFailures(failures, [
      {
        cleanup: async () => {
          await dependencies.agentSession.completeCleanShutdown();
        },
        label: 'agent clean-shutdown completion',
      },
      {
        cleanup: async () => {
          await persistEveryShellCleanRestartPermit(dependencies.shell, candidates);
          shellPermitsCompleted = true;
        },
        label: 'shell clean-restart permit',
      },
    ]);
  } else {
    await collectTaskExperienceCleanupPhaseFailures(failures, [
      {
        cleanup: () => {
          dependencies.shell.abortCleanRestartDrain();
        },
        label: 'shell session',
      },
    ]);
  }

  await collectTaskExperienceCleanupPhaseFailures(failures, [
    ...dependencies.closeOwners,
    ...(noPermitShutdown
      ? [
          {
            cleanup: () => dependencies.agentSession.closeWithoutRestartPermit(),
            label: 'agent session' as const,
          },
        ]
      : []),
    ...(noPermitShutdown || shellPermitsCompleted
      ? [{ cleanup: () => dependencies.shell.close(), label: 'shell session' as const }]
      : []),
  ]);

  if (failures.length > 0) throw new TaskExperienceRuntimeCleanupError(failures);
}

/**
 * Hosts retain this second stop for Arena and activation-before-runtime cases.
 * Its only ordering rule is that the task-experience owner settles first.
 */
export function stopAgentRunnersAfterTaskExperience(
  taskExperienceCleanup: Promise<void>,
  stopAgentRunners: () => Promise<void> = () =>
    stopAllTaskAgentWorkflows({ keepAdmissionClosed: true }),
): Promise<void> {
  const stop = (): Promise<void> => Promise.resolve().then(stopAgentRunners);
  return taskExperienceCleanup.then(stop, stop);
}

export async function rethrowTaskExperienceActivationFailure(
  activationError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new TaskExperienceRuntimeActivationError(activationError, cleanupError, cleanup);
  }
  throw activationError;
}

function exactActiveCapabilities(
  serverInstanceId: string,
  cutoverEpoch: string,
): ActiveTaskReliabilityRuntimeCapabilities {
  return {
    agentSessions: {
      automaticResumeFallback: true,
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      initialLaunch: true,
      manualReplacement: true,
    },
    contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
    cutoverEpoch,
    initialPromptDelivery: {
      enabled: true,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    },
    kind: 'active',
    serverInstanceId,
  };
}

/**
 * Sole desktop/browser composition root for D01/D09/D11/D13/D14. It starts every participant dark,
 * installs the generic-removal cutover, activates managed creation, then activates merge before
 * publishing the composed runtime after all exact epochs and journals have been re-read.
 */
export async function createProductionTaskExperienceRuntime(
  dependencies: CreateProductionTaskExperienceRuntimeDependencies,
): Promise<ProductionTaskExperienceRuntime> {
  const workspace =
    dependencies.workspace ??
    (await dependencies.context.workspaceMutations?.getWorkspaceService());
  const structure =
    dependencies.structure ??
    (await dependencies.context.workspaceMutations?.getTaskStructureService());
  if (!workspace || !structure) {
    throw new Error('Task-experience runtime requires the canonical workspace mutation host');
  }
  const writer = dependencies.context.agentSessionWriter;
  if (!writer) throw new Error('Task-experience runtime requires the managed session writer');
  const promptInputAdmission = dependencies.context.taskPromptInputAdmission;
  if (!promptInputAdmission) {
    throw new Error('Task-experience runtime requires the shared task-prompt admission owner');
  }
  const [legacyRemovalGate, legacyMergeGate] = await Promise.all([
    dependencies.context.workspaceMutations?.getTaskRemovalLegacyWriterGate(),
    dependencies.context.workspaceMutations?.getTaskMergeLegacyWriterGate(),
  ]);
  if (!legacyRemovalGate) {
    throw new Error('Task-experience runtime requires the shared legacy-removal writer gate');
  }
  if (!legacyMergeGate) {
    throw new Error('Task-experience runtime requires the shared legacy-merge writer gate');
  }
  const privateAuthority = workspace.createPrivateMutationAuthority();
  const creationJournal = createTaskCreationJournal(dependencies.context);
  const initialPromptRemovalGate = structure.createTaskRemovalParticipantGate(
    'initial-prompt',
    TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  );
  const initialPrompt = createProductionTaskInitialPromptRuntime({
    authorize: () => true,
    privateAuthority,
    promptInputAdmission,
    removalGate: initialPromptRemovalGate,
    structure,
    workspace,
  });
  const agentSession = createProductionAgentSessionRuntime({
    context: dependencies.context,
    privateAuthority,
    structure,
    writer,
  });
  let creationWorkflow: ActiveTaskCreationWorkflow | undefined;
  const shell = createProductionTaskShellSessionRuntime({
    catalog: dependencies.catalog,
    context: dependencies.context,
    creationJournal,
    privateAuthority,
    waitForInFlightInitialLaunch: async (request) => {
      if (!creationWorkflow) throw new Error('Task creation runtime is not active');
      await creationWorkflow.waitForInFlightInitialLaunch(request);
    },
    removalGate: structure.createTaskRemovalParticipantGate(
      'task-runtime',
      TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
    ),
    verifyTaskIdentityForRemoval: (request) =>
      structure.verifyTaskIdentityWitnessForRemoval(request),
  });
  const taskRuntimeParticipant = createTaskRuntimeRemovalParticipant({
    cleanupCoordinatorTaskState: (taskId) =>
      cleanupCoordinatorTaskStateAndOwnedSubtasks(
        { context: dependencies.context, taskNames: dependencies.taskNames },
        taskId,
      ),
    finalizeRemovedTaskState: (request) => {
      dependencies.taskNames.deleteTask(request.taskId);
    },
    finalizeTaskShellRemoval: async (request) => {
      await shell.workflow.markTaskRemovalCommitted(request);
      await shell.workflow.finalizeTaskRemoval(request);
    },
    legacyWriterGate: legacyRemovalGate,
    onReleasedTaskCommandController: (snapshot) => {
      dependencies.context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, snapshot);
    },
    prepareTaskShellRemoval: async (request) => {
      const replay = await shell.workflow.prepareTaskRemoval(request);
      return {
        launchOperationId: replay.identity.operationId,
        recordVersion: replay.recordVersion,
        replayKind: replay.replayKind,
      };
    },
  });

  let releasePromptInputClosingResolver: (() => void) | null = null;
  function takeTaskExperienceBaseCloseOwners(journal: { close(): Promise<void> }): Array<{
    cleanup: () => Promise<void> | void;
    label: TaskExperienceRuntimeCleanupLabel;
  }> {
    const releasePromptBinding = releasePromptInputClosingResolver;
    releasePromptInputClosingResolver = null;
    return [
      {
        cleanup: () => releasePromptBinding?.(),
        label: 'prompt admission binding',
      },
      { cleanup: () => initialPrompt.close(), label: 'initial prompt' },
      { cleanup: () => journal.close(), label: 'creation journal' },
    ];
  }

  async function rollbackTaskExperienceActivation(journal: {
    close(): Promise<void>;
  }): Promise<void> {
    const failures: Array<RuntimeCleanupFailure<TaskExperienceRuntimeCleanupLabel>> = [];
    await collectTaskExperienceCleanupPhaseFailures(failures, [
      {
        cleanup: () => agentSession.prepareCleanShutdown(),
        label: 'agent clean-shutdown preparation',
      },
      {
        cleanup: () => shell.beginCleanRestartDrain().then(() => undefined),
        label: 'shell clean-restart preparation',
      },
    ]);
    await collectTaskExperienceCleanupPhaseFailures(failures, [
      {
        cleanup: () => stopAllTaskAgentWorkflows({ keepAdmissionClosed: true }),
        label: 'agent runner',
      },
    ]);
    await collectTaskExperienceCleanupPhaseFailures(failures, [
      {
        cleanup: () => {
          shell.abortCleanRestartDrain();
        },
        label: 'shell session',
      },
      ...takeTaskExperienceBaseCloseOwners(journal),
      { cleanup: () => agentSession.journal.close(), label: 'agent session' },
      { cleanup: () => shell.close(), label: 'shell session' },
    ]);
    if (failures.length > 0) throw new TaskExperienceRuntimeCleanupError(failures);
  }
  try {
    releasePromptInputClosingResolver = promptInputAdmission.bindTaskClosingResolver((taskId) =>
      structure.isTaskMutationAdmissionClosed(taskId),
    );
    await Promise.all([initialPrompt.startup(), agentSession.startup(), shell.startup()]);
    const structural = await activateDarkTaskStructuralOwners({
      agentSession: {
        hooks: agentSession.workflow.removalHooks,
        legacyWriterCutover: agentSession.legacyWriterCutover,
      },
      initialPrompt: {
        persistence: initialPrompt.persistence,
        service: initialPrompt.service,
      },
      structure,
      taskRuntime: { participant: taskRuntimeParticipant },
    });
    const promptCapability = await initialPrompt.activate();
    const agentCapability = await agentSession.workflow.getOwnerAvailability(
      'task-experience-activation-probe',
    );
    if (
      agentCapability.kind !== 'active' ||
      agentCapability.cutoverEpoch !== structural.removal.cutoverEpoch ||
      promptCapability.cutoverEpoch !== structural.removal.cutoverEpoch
    ) {
      throw new Error('Task-experience owner epochs changed during public activation');
    }
    const preparation = await createProductionTaskCreationPreparationOwner({
      privateAuthority,
      serverInstanceId: dependencies.serverInstanceId,
    });
    const coordinatorCreation = createTrustedCoordinatorTaskCreationWorkflow({
      basePreparation: preparation,
      env: dependencies.context,
    });
    const creationRuntime = await activateTaskCreationRuntime({
      agentSession: agentSession.workflow,
      authorization: { authorize: () => true },
      creationJournal,
      current: { read: shell.readCreationCurrent },
      env: dependencies.context,
      initialPrompt: initialPrompt.service,
      preparation: coordinatorCreation.preparation,
      shell: shell.workflow,
      shellJournal: shell.journal,
      structure,
    });
    creationWorkflow = creationRuntime.workflow;
    coordinatorCreation.bindCreationWorkflow(creationRuntime.workflow);
    const localReconciliation = createTaskCreationLocalReconciliationCommands({
      audit: (event) => {
        logWarn('task-creation.reconciliation', 'Local reconciliation action', event);
      },
      buildSnapshot: (record) => creationRuntime.workflow.projectRecord(record),
      finalizeRestoredWorktreeUnlock: () => ({ kind: 'proof-insufficient' }),
      inspect: (record) => preparation.reconciliation.inspect(record),
      journal: creationRuntime.journal,
      keepCurrentBranch: () => ({ kind: 'proof-insufficient' }),
      moveRecoveryQuarantine: () => ({ kind: 'proof-insufficient' }),
      planRecoveryRestore: () => null,
      probeCommittedMapping: (record, expectedTaskId) =>
        preparation.reconciliation.probeCommittedMapping(record, expectedTaskId),
      probeOwnedArtifactAbsence: (record, resource) =>
        preparation.reconciliation.probeOwnedArtifactAbsence(record, resource),
      probeRecoveryQuarantineAbsence: (record) =>
        preparation.reconciliation.probeRecoveryQuarantineAbsence(record),
      retryOwnedBranchDelete: () => ({ kind: 'proof-insufficient' }),
      revealRecoveryQuarantine: (record) =>
        dependencies.context.shell
          ? preparation.reconciliation.revealRecoveryQuarantine(
              record,
              dependencies.context.shell.reveal,
            )
          : 'proof-insufficient',
    });
    const merge = await activateTaskMergeBackend({
      authorize: ({ action, principalId, taskId }) =>
        action === 'status' || isTaskCommandLeaseHeld(taskId, principalId),
      executeGit: executeBackendTaskMergeGit,
      legacyWriterCutover: legacyMergeGate,
      structure,
      workspace,
    });
    const localCreation = createTrustedLocalTaskCreationCommand({
      coordinator: coordinatorCreation,
      journal: creationRuntime.journal,
      preparation,
      privateAuthority,
      tickets: creationRuntime.tickets,
      workflow: creationRuntime.workflow,
    });
    const notes = new TaskNotesService(privateAuthority, structural.notes, {
      emitTaskNotesChanged: (notification) => {
        dependencies.context.emitIpcEvent?.(IPC.TaskNotesChanged, notification);
      },
      ...(dependencies.context.taskNotesWriterEntitlements
        ? { writerEntitlements: dependencies.context.taskNotesWriterEntitlements }
        : {}),
    });
    agentSession.activateAutomaticRecovery();
    const collapse = createTaskCollapseWorkflow({
      agentSession,
      shell,
      privateAuthority,
      structure,
    });
    let closePromise: Promise<void> | null = null;
    return {
      agentSession,
      capabilities: exactActiveCapabilities(
        dependencies.serverInstanceId,
        structural.removal.cutoverEpoch,
      ),
      async close() {
        if (!closePromise) {
          const attempt = collapse.drain().then(() =>
            coordinateTaskExperienceCleanShutdown({
              agentSession: {
                closeWithoutRestartPermit: () => agentSession.journal.close(),
                completeCleanShutdown: () => agentSession.completeCleanShutdown(),
                prepareCleanShutdown: () => agentSession.prepareCleanShutdown(),
              },
              closeOwners: takeTaskExperienceBaseCloseOwners(creationRuntime.journal),
              shell: {
                abortCleanRestartDrain: () => shell.abortCleanRestartDrain(),
                beginCleanRestartDrain: () => shell.beginCleanRestartDrain(),
                close: () => shell.close(),
                persistCleanRestartPermit: (candidate) =>
                  shell.persistCleanRestartPermit(candidate),
              },
              stopAgentRunners: () => stopAllTaskAgentWorkflows({ keepAdmissionClosed: true }),
            }),
          );
          closePromise = attempt;
          void attempt.catch(() => {
            if (closePromise === attempt) closePromise = null;
          });
        }
        await closePromise;
      },
      coordinatorCreation,
      creation: creationRuntime.workflow,
      creationRuntime,
      initialPrompt,
      localCreation,
      localReconciliation,
      merge,
      notes,
      shell,
      collapse,
    };
  } catch (activationError) {
    return rethrowTaskExperienceActivationFailure(activationError, () =>
      rollbackTaskExperienceActivation(creationJournal),
    );
  }
}
