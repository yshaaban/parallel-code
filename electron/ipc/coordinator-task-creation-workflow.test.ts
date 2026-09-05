import { describe, expect, it, vi } from 'vitest';

import type { TaskCreationIntent } from '../../src/domain/task-creation.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
  TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import { createNormalizedTaskCreationSemanticRequestV1 } from './task-creation-journal.js';
import {
  createTrustedCoordinatorTaskCreationWorkflow,
  type CoordinatorTaskCreationRuntimeAdapters,
} from './coordinator-task-creation-workflow.js';
import type {
  TaskCreationCommitFailureReconciliation,
  TaskCreationPreparationOwner,
  TaskCreationPreparedTask,
  TaskCreationIntentResolution,
  TaskCreationResolvedIntent,
  TaskCreationWorkflow,
} from './task-creation-workflow.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA' as TaskCreationOperationId;
const authentication = {} as TaskCreationTicketAuthenticationContext;

function intent(): TaskCreationIntent {
  return {
    launch: {
      agentDefId: 'agent-def-1',
      initialPrompt: 'Start here',
      kind: 'agent',
      skipPermissions: false,
    },
    location: { kind: 'project-root' },
    name: 'Coordinator task',
    operationCapability:
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA' as TaskCreationOperationCapability,
    operationId,
    operationTicket: 'ticket',
    projectId: 'project-1',
    stepsTracking: false,
  };
}

function resolved(): TaskCreationResolvedIntent {
  return {
    agent: {
      definition: { command: 'agent', id: 'agent-def-1', name: 'Agent' },
      definitionId: 'agent-def-1',
    },
    semanticRequest: createNormalizedTaskCreationSemanticRequestV1({
      launch: {
        agentDefId: 'agent-def-1',
        initialPrompt: 'Start here',
        kind: 'agent',
        skipPermissions: false,
      },
      location: { kind: 'project-root' },
      name: 'Coordinator task',
      projectId: 'project-1',
      stepsTracking: false,
    }),
  };
}

function prepared(): TaskCreationPreparedTask {
  return {
    task: {
      baseBranch: 'main',
      branchName: 'main',
      gitIsolation: 'current-branch',
      projectMode: 'git',
      projectRoot: '/repo',
      worktreePath: '/repo',
    },
    warnings: [],
  };
}

function basePreparation(
  reconciliation: TaskCreationCommitFailureReconciliation = { kind: 'proven-clean' },
): TaskCreationPreparationOwner {
  return {
    getCapabilities: vi.fn(async () => {
      throw new Error('not used');
    }),
    getPickerPage: vi.fn(async () => {
      throw new Error('not used');
    }),
    getWorktreeLinkCandidates: vi.fn(async () => {
      throw new Error('not used');
    }),
    normalizeIntent: vi.fn(() => ({
      kind: 'normalized' as const,
      semanticRequest: resolved().semanticRequest,
    })),
    prepare: vi.fn(async () => prepared()),
    reconcileFailedCommit: vi.fn(async () => reconciliation),
    resolveIntent: vi.fn(
      async (_intent, _authentication, semanticRequest): Promise<TaskCreationIntentResolution> => ({
        kind: 'resolved',
        value: {
          ...resolved(),
          ...(semanticRequest ? { semanticRequest } : {}),
        },
      }),
    ),
  };
}

function identities() {
  return {
    agentId: 'agent-1',
    deliveryId: 'delivery-1',
    launchOperationId: 'launch-1',
    sessionId: 'agent-1',
    taskId: 'task-1',
  };
}

describe('trusted coordinator task creation workflow', () => {
  it('adds restart-replayable coordinator metadata only for the local trusted command', async () => {
    const base = basePreparation();
    const create = vi.fn(async () => ({
      credentialPath: '/private/coordinator/task-1.json',
      runId: 'run-1',
      toolCommand: 'node coordinator-tool.mjs',
    }));
    const get = vi.fn<CoordinatorTaskCreationRuntimeAdapters['get']>(() => null);
    const owner = createTrustedCoordinatorTaskCreationWorkflow({
      adapters: { cleanup: vi.fn(), create, get },
      basePreparation: base,
      env: {} as never,
    });
    let observed: TaskCreationPreparedTask | null = null;
    owner.bindCreationWorkflow({
      create: async (
        _authentication: TaskCreationTicketAuthenticationContext,
        request: TaskCreationIntent,
      ) => {
        const resolution = await owner.preparation.resolveIntent(request, authentication);
        expect(resolution.kind).toBe('resolved');
        if (resolution.kind !== 'resolved') throw new Error('resolution failed');
        observed = await owner.preparation.prepare({
          identities: identities(),
          operationId: request.operationId,
          resolved: resolution.value,
        });
        return {} as never;
      },
    } as unknown as TaskCreationWorkflow);

    await owner.create(authentication, intent());
    expect(observed).toEqual({
      ...prepared(),
      coordinator: {
        credentialPath: '/private/coordinator/task-1.json',
        runId: 'run-1',
        toolCommand: 'node coordinator-tool.mjs',
      },
    });
    expect(create).toHaveBeenCalledWith({
      agentId: 'agent-1',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
      taskId: 'task-1',
    });

    await owner.preparation.prepare({
      identities: identities(),
      operationId,
      resolved: resolved(),
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reuses exact restored coordinator launch metadata instead of creating a second run', async () => {
    const existing = {
      credentialPath: '/private/coordinator/task-1.json',
      runId: 'run-1',
    };
    const create = vi.fn();
    const owner = createTrustedCoordinatorTaskCreationWorkflow({
      adapters: { cleanup: vi.fn(), create, get: () => existing },
      basePreparation: basePreparation(),
      env: {} as never,
    });
    let observed: TaskCreationPreparedTask | null = null;
    owner.bindCreationWorkflow({
      create: async (
        _authentication: TaskCreationTicketAuthenticationContext,
        request: TaskCreationIntent,
      ) => {
        observed = await owner.preparation.prepare({
          identities: identities(),
          operationId: request.operationId,
          resolved: resolved(),
        });
        return {} as never;
      },
    } as unknown as TaskCreationWorkflow);

    await owner.create(authentication, intent());
    expect((observed as TaskCreationPreparedTask | null)?.coordinator).toEqual(existing);
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans coordinator state after a proven failed commit but preserves mapping ambiguity', async () => {
    const cleanup = vi.fn(async () => undefined);
    const mappingAmbiguous: TaskCreationCommitFailureReconciliation = {
      kind: 'manual-reconciliation-required',
      reconciliation: {
        expectedTaskId: 'task-1',
        kind: 'mapping-ambiguous',
        resource: {
          conflictKey: { digest: 'x'.repeat(43), kind: 'task' },
          resourceId: 'task:task-1',
        },
      },
    };
    let reconciliation = { kind: 'proven-clean' } as TaskCreationCommitFailureReconciliation;
    const base = basePreparation();
    vi.mocked(base.reconcileFailedCommit).mockImplementation(async () => reconciliation);
    const owner = createTrustedCoordinatorTaskCreationWorkflow({
      adapters: {
        cleanup,
        create: async () => ({ credentialPath: '/private/task.json', runId: 'run-1' }),
        get: () => null,
      },
      basePreparation: base,
      env: {} as never,
    });
    owner.bindCreationWorkflow({
      create: async (
        _authentication: TaskCreationTicketAuthenticationContext,
        request: TaskCreationIntent,
      ) => {
        const withCoordinator = await owner.preparation.prepare({
          identities: identities(),
          operationId: request.operationId,
          resolved: resolved(),
        });
        await owner.preparation.reconcileFailedCommit({
          cause: new Error('commit failed'),
          identities: identities(),
          operationId: request.operationId,
          prepared: withCoordinator,
          resolved: resolved(),
        });
        return {} as never;
      },
    } as unknown as TaskCreationWorkflow);

    await owner.create(authentication, intent());
    expect(cleanup).toHaveBeenCalledTimes(1);

    reconciliation = mappingAmbiguous;
    await owner.create(authentication, intent());
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
