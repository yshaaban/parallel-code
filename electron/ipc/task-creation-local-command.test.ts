import { describe, expect, it, vi } from 'vitest';

import type {
  CreateTaskCreationOperationResult,
  TaskCreationIntent,
} from '../../src/domain/task-creation.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import type { TaskCreationJournalRecord } from './task-creation-journal.js';
import {
  createTrustedLocalTaskCreationCommand,
  type CreateTrustedLocalTaskCreationCommandDependencies,
} from './task-creation-local-command.js';
import type { WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';

function committedResult(
  intent: TaskCreationIntent,
  taskId = 'task-1',
): CreateTaskCreationOperationResult {
  return {
    kind: 'snapshot',
    outcome: 'accepted',
    snapshot: {
      commit: 'committed',
      committedTaskId: taskId,
      committedWorkspaceRevision: 2,
      current: {
        catalogVersion: 2,
        serverInstanceId: 'server-1',
        task: {
          branchLabel: 'task/local',
          branchLabelTruncated: false,
          creationStatus: 'ready',
          lifecycle: 'active',
          location: 'managed-worktree',
          name: intent.name,
          nameTruncated: false,
          ownership: 'managed',
          primarySessionId: 'session-1',
          projectId: intent.projectId,
          sessionCount: 1,
          taskId,
          taskMode: intent.launch.kind,
        },
        taskClosing: false,
        taskState: 'present',
        workspaceRevision: 2,
      },
      managedArtifactRecovery: { kind: 'none' },
      operationId: intent.operationId,
      phase: 'active',
      serverInstanceId: 'server-1',
      symlinkWarnings: [],
      taskMode: intent.launch.kind,
      version: 4,
    },
  } as CreateTaskCreationOperationResult;
}

function failedBeforeCommitResult(intent: TaskCreationIntent): CreateTaskCreationOperationResult {
  return {
    kind: 'snapshot',
    outcome: 'accepted',
    snapshot: {
      commit: 'not-committed',
      committedTaskId: null,
      committedWorkspaceRevision: null,
      current: {
        catalogVersion: 1,
        serverInstanceId: 'server-1',
        task: null,
        taskClosing: false,
        taskState: 'not-visible',
        workspaceRevision: 1,
      },
      issue: {
        code: 'workspace-conflict',
        message: 'Task workspace preparation rolled back safely.',
        retryable: true,
      },
      managedArtifactRecovery: { kind: 'none' },
      operationId: intent.operationId,
      phase: 'failed-before-commit',
      serverInstanceId: 'server-1',
      symlinkWarnings: [],
      taskMode: intent.launch.kind,
      version: 3,
    },
  } as CreateTaskCreationOperationResult;
}

function canonicalTask(
  operationId: TaskCreationOperationId,
  overrides: Record<string, unknown> = {},
) {
  return {
    agentDef: { id: 'codex', name: 'Canonical Codex' },
    agentId: 'session-1',
    agentIds: ['session-1'],
    baseBranch: 'main',
    branchName: 'task/local',
    gitIsolation: 'worktree',
    id: 'task-1',
    initialPrompt: 'Implement the slice',
    initialPromptDeliveryId: 'delivery-1',
    name: 'Local task',
    projectId: 'project-1',
    shellAgentIds: [],
    taskCreationOperationLink: {
      creationOperationId: operationId,
      kind: 'creation-v1',
      launchOperationId: 'launch-1',
    },
    taskCreationProvenance: { creationWriterEpoch: 'managed-initial-shell-v1' },
    taskInitialShellOwnership: {
      kind: 'not-applicable-agent',
      migrationSchemaVersion: 1,
    },
    taskMode: 'agent',
    worktreePath: '/repo/.worktrees/task-local',
    ...overrides,
  };
}

function createHarness() {
  let task: Record<string, unknown> | null = null;
  let journalRecord: TaskCreationJournalRecord | null = null;
  const intents: TaskCreationIntent[] = [];
  const workflowCreate = vi.fn(async (_authentication, intent: TaskCreationIntent) => {
    intents.push(intent);
    task = canonicalTask(intent.operationId);
    journalRecord = {
      commit: { kind: 'committed', taskId: 'task-1', workspaceRevision: 2 },
      identities: {
        deliveryId: 'delivery-1',
        launchOperationId: 'launch-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      operationId: intent.operationId,
    } as TaskCreationJournalRecord;
    return committedResult(intent);
  });
  const coordinatorCreate = vi.fn(async (_authentication, intent: TaskCreationIntent) => {
    intents.push(intent);
    task = canonicalTask(intent.operationId, {
      coordinatorCredentialPath: '/private/coordinator.json',
      coordinatorRole: 'coordinator',
      coordinatorRunId: 'run-1',
      coordinatorToolCommand: 'parallel-code-coordinator',
      initialPrompt: intent.launch.kind === 'agent' ? intent.launch.initialPrompt : undefined,
    });
    journalRecord = {
      commit: { kind: 'committed', taskId: 'task-1', workspaceRevision: 2 },
      identities: {
        deliveryId: 'delivery-1',
        launchOperationId: 'launch-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      operationId: intent.operationId,
    } as TaskCreationJournalRecord;
    return committedResult(intent);
  });
  const privateAuthority: WorkspacePrivateMutationAuthority = {
    mutate: vi.fn(async (_request, mutator) => {
      const decision = mutator({
        localState: {},
        payloadDigest: 'digest',
        privateState: {},
        sharedRevision: 2,
        sharedState: { tasks: task ? { 'task-1': task } : {} },
        storageGeneration: '1',
      });
      if (decision.kind !== 'unchanged') throw new Error('Unexpected test mutation');
      return { changed: false, result: decision.result, revision: 2 };
    }),
  };
  const issueTrustedLocal = vi.fn((_authentication, operationId: TaskCreationOperationId) => ({
    expiresAt: 2,
    issuedAt: 1,
    operationId,
    operationTicket: 'trusted-ticket',
  }));
  const dependencies = {
    coordinator: { create: coordinatorCreate },
    journal: {
      getByOperationId: vi.fn(() => journalRecord),
    },
    preparation: {
      normalizeTrustedLocalSelection: vi.fn(() => ({
        baseBranchRef: 'b_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        projectMode: 'git' as const,
      })),
      resolveTrustedLocalSelection: vi.fn(async () => ({
        baseBranchRef: 'b_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        projectMode: 'git' as const,
      })),
    },
    privateAuthority,
    tickets: { issueTrustedLocal },
    workflow: { create: workflowCreate },
  } as unknown as CreateTrustedLocalTaskCreationCommandDependencies;
  return {
    command: createTrustedLocalTaskCreationCommand(dependencies),
    coordinatorCreate,
    dependencies,
    intents,
    issueTrustedLocal,
    privateAuthority,
    setTask(value: Record<string, unknown> | null) {
      task = value;
    },
    workflowCreate,
  };
}

const request = {
  adapterOperationId: '576c2f17-3cf5-43b4-9b8a-6826941c9e7e',
  agentDefId: 'codex',
  baseBranch: 'main',
  branchPrefix: 'task',
  gitIsolation: 'worktree' as const,
  initialPrompt: 'Implement the slice',
  name: 'Local task',
  projectId: 'project-1',
  projectRoot: '/repo',
  skipPermissions: true,
  stepsTracking: true,
  symlinkDirs: ['node_modules'],
};

describe('trusted local task creation command', () => {
  it('replays one adapter operation with the same canonical identity and session', async () => {
    const harness = createHarness();

    const first = await harness.command.create(request);
    vi.mocked(harness.dependencies.preparation.resolveTrustedLocalSelection).mockRejectedValue(
      new Error('Project and Git selections disappeared'),
    );
    const second = await harness.command.create(request);

    expect(first).toMatchObject({
      creation_writer_epoch: 'managed-initial-shell-v1',
      id: 'task-1',
      initial_prompt_delivery_id: 'delivery-1',
      session_id: 'session-1',
      task_creation_operation_link: {
        kind: 'creation-v1',
        launchOperationId: 'launch-1',
      },
    });
    expect(second).toEqual(first);
    expect(harness.workflowCreate).toHaveBeenCalledTimes(2);
    expect(harness.coordinatorCreate).not.toHaveBeenCalled();
    expect(harness.intents[0]?.operationId).toBe(harness.intents[1]?.operationId);
    expect(harness.intents[0]?.operationCapability).toBe(harness.intents[1]?.operationCapability);
    expect(harness.intents[0]?.operationId).not.toBe(request.adapterOperationId);
    expect(harness.issueTrustedLocal).toHaveBeenCalledOnce();
    expect(harness.issueTrustedLocal).toHaveBeenCalledWith(
      expect.anything(),
      harness.intents[0]?.operationId,
    );
    expect(harness.intents[1]?.operationTicket).toBe('known-operation-replay');
    expect(harness.dependencies.preparation.resolveTrustedLocalSelection).not.toHaveBeenCalled();
  });

  it('routes only a top-level coordinator through the coordinator creation owner', async () => {
    const harness = createHarness();

    const result = await harness.command.create({ ...request, coordinatorMode: true });

    expect(harness.workflowCreate).not.toHaveBeenCalled();
    expect(harness.coordinatorCreate).toHaveBeenCalledOnce();
    const coordinatorIntent = harness.coordinatorCreate.mock.calls[0]?.[1];
    expect(coordinatorIntent?.launch).toMatchObject({
      agentDefId: 'codex',
      kind: 'agent',
    });
    expect(
      coordinatorIntent?.launch.kind === 'agent'
        ? coordinatorIntent.launch.initialPrompt
        : undefined,
    ).toContain('You are the coordinator for this Parallel Code task.');
    expect(result).toMatchObject({
      coordinator_credential_path: '/private/coordinator.json',
      coordinator_run_id: 'run-1',
      coordinator_tool_command: 'parallel-code-coordinator',
      session_id: 'session-1',
    });
  });

  it('surfaces canonical rollback state without reading or falling back after a failed commit', async () => {
    const harness = createHarness();
    harness.workflowCreate.mockImplementationOnce(async (_authentication, intent) =>
      failedBeforeCommitResult(intent),
    );

    await expect(harness.command.create(request)).rejects.toThrow(
      'Task workspace preparation rolled back safely.',
    );

    expect(harness.privateAuthority.mutate).not.toHaveBeenCalled();
    expect(harness.coordinatorCreate).not.toHaveBeenCalled();
  });

  it('fails before ticket issuance when a raw local selection cannot be normalized', async () => {
    const harness = createHarness();
    vi.mocked(
      harness.dependencies.preparation.normalizeTrustedLocalSelection,
    ).mockImplementationOnce(() => {
      throw new Error('Invalid trusted local selection');
    });

    await expect(harness.command.create(request)).rejects.toThrow(
      'Invalid trusted local selection',
    );
    expect(harness.issueTrustedLocal).not.toHaveBeenCalled();
    expect(harness.workflowCreate).not.toHaveBeenCalled();
    expect(harness.coordinatorCreate).not.toHaveBeenCalled();
  });
});
