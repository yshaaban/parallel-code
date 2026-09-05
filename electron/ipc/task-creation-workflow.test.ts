import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionOperationResult } from '../../src/domain/agent-session-operation.js';
import {
  TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
  TaskCreationConflictAdmissionError,
  createNormalizedTaskCreationSemanticRequestV1,
  createTaskCreationJournal,
  deriveTaskCreationConflictKey,
  deriveTaskCreationSemanticFingerprint,
  getTaskCreationJournalRecordCharge,
  taskCreationConflictKeyId,
  type TaskCreationJournal,
  type TaskCreationJournalRecord,
} from './task-creation-journal.js';
import type {
  TaskCreationCapabilities,
  TaskCreationCommittedCurrentProjection,
  TaskCreationIntent,
  TaskCreationOperationSnapshot,
} from '../../src/domain/task-creation.js';
import type { RemoteTaskSummary } from '../../src/domain/task-catalog.js';
import {
  createTaskCreationAuthEpoch,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import type {
  TaskShellSessionOperationIdentity,
  TaskShellSessionOperationReplay,
} from '../../src/domain/task-shell-session-operation.js';
import { encodeTaskWorktreeLinkRequestV1 } from './git-worktree-symlinks.js';
import { createTaskCreationAuthenticationSessionGeneration } from './task-creation-operation-ticket.js';
import {
  createTaskCreationOperationTicketIssuer,
  type TaskCreationOperationTicketIssuer,
} from './task-creation-operation-ticket.js';
import type { TaskCreationOwnerCapabilityBundle } from './task-creation-owner-capability.js';
import type { TaskShellSessionWorkflow } from './task-shell-session-workflow.js';
import {
  TaskCreationPreparationManualReconciliationError,
  createTaskCreationWorkflow,
  type TaskCreationIdentityFactory,
  type TaskCreationPreparedTask,
  type TaskCreationPreparationOwner,
  type TaskCreationResolvedIntent,
} from './task-creation-workflow.js';

const NOW = 10_000;
const PRINCIPAL_HASH = createHash('sha256').update('principal-1').digest('hex');

class MemoryTaskCreationJournal implements TaskCreationJournal {
  readonly records = new Map<string, TaskCreationJournalRecord>();
  readonly phases: string[] = [];

  activateFresh() {
    return Promise.resolve({ health: 'healthy' as const, topologyEpoch: 'topology-1' });
  }

  activateFromLegacy(records: readonly TaskCreationJournalRecord[]) {
    for (const record of records) this.store(record);
    return Promise.resolve({ health: 'healthy' as const, topologyEpoch: 'topology-1' });
  }

  close() {
    return Promise.resolve();
  }

  compactExpired() {
    return Promise.resolve(0);
  }

  findConflict() {
    return [];
  }

  flushDerivedIndex() {
    return Promise.resolve(true);
  }

  get(workspacePrincipalHash: string, operationId: string) {
    return structuredClone(this.records.get(`${workspacePrincipalHash}:${operationId}`) ?? null);
  }

  getByOperationId(operationId: string) {
    const found = [...this.records.values()].find((record) => record.operationId === operationId);
    return found ? structuredClone(found) : null;
  }

  getByTaskId(taskId: string) {
    const found = [...this.records.values()].find(
      (record) => record.commit.kind === 'committed' && record.commit.taskId === taskId,
    );
    return found ? structuredClone(found) : null;
  }

  getCounts() {
    const records = [...this.records.values()];
    return {
      chargedBytes: records.reduce(
        (total, record) => total + getTaskCreationJournalRecordCharge(record),
        0,
      ),
      nonterminal: records.filter(
        (record) =>
          record.retention.kind === 'nonterminal' || record.retention.kind === 'retained-artifact',
      ).length,
      records: records.length,
    };
  }

  getHealth() {
    return 'healthy' as const;
  }

  getTopologyEpoch() {
    return 'topology-1';
  }

  hasOperationId(operationId: string) {
    return [...this.records.values()].some((record) => record.operationId === operationId);
  }

  list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  repairDurability() {
    return Promise.resolve(true);
  }

  save(record: TaskCreationJournalRecord, expectedVersion: number | null) {
    const key = `${record.workspacePrincipalHash}:${record.operationId}`;
    const prior = this.records.get(key);
    if (
      (!prior && expectedVersion !== null) ||
      (prior && expectedVersion !== prior.recordVersion)
    ) {
      throw new Error('stale memory journal write');
    }
    this.store(record);
    return Promise.resolve({ kind: 'committed' as const });
  }

  startup() {
    return Promise.resolve({ health: 'healthy' as const, topologyEpoch: 'topology-1' });
  }

  private store(record: TaskCreationJournalRecord): void {
    this.records.set(
      `${record.workspacePrincipalHash}:${record.operationId}`,
      structuredClone(record),
    );
    this.phases.push(record.phase);
  }
}

function authentication(): TaskCreationTicketAuthenticationContext {
  return {
    authEpoch: createTaskCreationAuthEpoch(1),
    authenticationSessionGeneration: createTaskCreationAuthenticationSessionGeneration(() =>
      Uint8Array.from({ length: 16 }, () => 0x41),
    ),
    workspacePrincipalId: 'principal-1',
  };
}

function taskSummary(
  taskId: string,
  taskMode: 'agent' | 'terminal',
  sessionId: string,
): RemoteTaskSummary {
  return {
    branchLabel: 'task/test',
    branchLabelTruncated: false,
    creationStatus: 'ready',
    lifecycle: 'active',
    location: 'project-root',
    name: 'Test task',
    nameTruncated: false,
    ownership: 'shared',
    primarySessionId: sessionId,
    projectId: 'project-1',
    sessionCount: 1,
    taskId,
    taskMode,
  };
}

function capabilities(): TaskCreationCapabilities {
  return {
    coordinator: { reason: 'coordinator-not-supported', supported: false },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    modes: { agent: { enabled: true }, terminal: { enabled: true } },
    permissionBypass: { enabled: true },
  };
}

function shellReplay(
  identity: TaskShellSessionOperationIdentity,
  phase: 'admitted' | 'reserved-for-task-commit' | 'running',
): TaskShellSessionOperationReplay {
  const running = phase === 'running';
  return {
    current: {
      catalogVersion: running ? 1 : 0,
      serverInstanceId: 'server-1',
      session: running ? { generation: 0, sessionId: identity.sessionId, state: 'running' } : null,
      task: running ? taskSummary(identity.taskId, 'terminal', identity.sessionId) : null,
      taskClosing: false,
      taskState: running ? 'present' : 'not-visible',
      workspaceRevision: running ? 1 : 0,
    },
    disposition:
      phase === 'running'
        ? { kind: 'attempted-no-replay', reason: 'running-at-ack' }
        : phase === 'admitted'
          ? { kind: 'in-progress', reason: 'spawn-admission-in-progress' }
          : { kind: 'in-progress', reason: 'task-commit-pending' },
    identity,
    phase,
    recordVersion: running ? 3 : phase === 'admitted' ? 2 : 1,
    replayKind: 'full',
  } as TaskShellSessionOperationReplay;
}

function makeHarness(
  mode: 'agent' | 'terminal',
  args: {
    identities?: TaskCreationIdentityFactory;
    journal?: TaskCreationJournal;
    launchFails?: boolean;
    projectMode?: 'git' | 'non-git';
    tickets?: TaskCreationOperationTicketIssuer;
  } = {},
) {
  const auth = authentication();
  let randomCall = 0;
  const tickets =
    args.tickets ??
    createTaskCreationOperationTicketIssuer({
      now: () => NOW,
      randomBytes: (length) => {
        randomCall += 1;
        return Uint8Array.from({ length }, (_, index) => (index + randomCall) % 256);
      },
    });
  const journal = new MemoryTaskCreationJournal();
  let committed: { mode: 'agent' | 'terminal'; sessionId: string; taskId: string } | undefined;
  let currentShell: TaskShellSessionOperationReplay | null = null;
  const identities: TaskCreationIdentityFactory = args.identities ?? {
    allocate: () => ({
      agentId: 'agent-1',
      deliveryId: null,
      launchOperationId: 'launch-1',
      sessionId: mode === 'agent' ? 'agent-1' : 'shell-1',
      taskId: 'task-1',
    }),
  };
  const resolved: TaskCreationResolvedIntent = {
    agent:
      mode === 'agent' ? { definition: { id: 'agent-def-1' }, definitionId: 'agent-def-1' } : null,
    semanticRequest: createNormalizedTaskCreationSemanticRequestV1({
      launch:
        mode === 'agent'
          ? { agentDefId: 'agent-def-1', kind: 'agent', skipPermissions: false }
          : { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'Test task',
      projectId: 'project-1',
      stepsTracking: false,
    }),
  };
  const normalizeIntent = (intent: Readonly<TaskCreationIntent>) =>
    createNormalizedTaskCreationSemanticRequestV1({
      ...(intent.baseBranchRef !== undefined ? { baseBranchRef: intent.baseBranchRef } : {}),
      ...(intent.branchPrefixPreference !== undefined
        ? { branchPrefixPreference: intent.branchPrefixPreference.trim() }
        : {}),
      ...(intent.githubUrl !== undefined ? { githubUrl: intent.githubUrl.trim() } : {}),
      launch:
        intent.launch.kind === 'agent'
          ? {
              agentDefId: intent.launch.agentDefId,
              ...(intent.launch.initialPrompt !== undefined
                ? { initialPrompt: intent.launch.initialPrompt }
                : {}),
              kind: 'agent',
              skipPermissions: intent.launch.skipPermissions,
            }
          : { kind: 'terminal' },
      location:
        intent.location.kind === 'managed-worktree'
          ? {
              kind: 'managed-worktree',
              worktreeLinkRequest: encodeTaskWorktreeLinkRequestV1(
                intent.location.requestedLinkNames,
              ),
            }
          : intent.location.kind === 'existing-worktree'
            ? { kind: 'existing-worktree', worktreeRef: intent.location.worktreeRef }
            : { kind: 'project-root' },
      name: intent.name.trim(),
      projectId: intent.projectId,
      stepsTracking: intent.stepsTracking,
    });
  const preparation: TaskCreationPreparationOwner = {
    getCapabilities: () => capabilities(),
    getPickerPage: vi.fn(),
    getWorktreeLinkCandidates: vi.fn(),
    prepare: vi.fn(async ({ resolved }): Promise<TaskCreationPreparedTask> => {
      if (args.projectMode === 'non-git') {
        return {
          task: {
            branchName: '',
            projectMode: 'non-git' as const,
            projectRoot: '/repo',
            worktreePath: '/repo',
          },
          warnings: [],
        };
      }
      const location = resolved.semanticRequest.location.kind;
      return {
        task: {
          branchName: 'task/test',
          gitIsolation:
            location === 'managed-worktree'
              ? ('worktree' as const)
              : location === 'existing-worktree'
                ? ('existing-worktree' as const)
                : ('current-branch' as const),
          projectMode: 'git' as const,
          projectRoot: '/repo',
          worktreePath: location === 'project-root' ? '/repo' : '/repo/.worktrees/test',
        },
        warnings: [],
      };
    }),
    reconcileFailedCommit: vi.fn(async () => ({ kind: 'proven-clean' as const })),
    normalizeIntent: vi.fn((intent) => ({
      kind: 'normalized' as const,
      semanticRequest: normalizeIntent(intent),
    })),
    resolveIntent: vi.fn(async (intent, _authentication, semanticRequest) => ({
      kind: 'resolved' as const,
      value: {
        ...resolved,
        semanticRequest: semanticRequest ?? normalizeIntent(intent),
      },
    })),
  };
  const ownerCapability: TaskCreationOwnerCapabilityBundle = {
    getDeploymentCapability: vi.fn(async () => ({
      cutoverEpoch: 'cutover-1',
      hookSetVersions: {
        agentSession: 'agent-session-owner-hooks-v1' as const,
        initialPrompt: 'initial-prompt-owner-hooks-v1' as const,
      },
      kind: 'active' as const,
      shellTopologyEpoch: 'topology-1',
      writerEpoch: 'managed-initial-shell-v1' as const,
    })),
    getTaskAdmissionCapability: vi.fn(async () => ({
      cutoverEpoch: 'cutover-1',
      hookSetVersions: {
        agentSession: 'agent-session-owner-hooks-v1' as const,
        initialPrompt: 'initial-prompt-owner-hooks-v1' as const,
      },
      kind: 'active' as const,
      shellTopologyEpoch: 'topology-1',
      writerEpoch: 'managed-initial-shell-v1' as const,
    })),
  };
  const shell: TaskShellSessionWorkflow = {
    abortCleanRestartDrain: vi.fn(() => true),
    admitAfterTaskCommit: vi.fn(async (request) => {
      const prior = currentShell?.identity;
      if (!prior) throw new Error('shell was not reserved');
      const identity = { ...prior, committedWorkspaceRevision: request.committedWorkspaceRevision };
      currentShell = shellReplay(identity, 'admitted');
      return currentShell;
    }),
    beginCleanRestartDrain: vi.fn(async () => []),
    cancelBeforeTaskCommit: vi.fn(async () => {
      if (!currentShell) throw new Error('shell was not reserved');
      return currentShell;
    }),
    finalizeTaskRemoval: vi.fn(),
    get: vi.fn(async () => currentShell),
    isTaskSpawnQuarantined: vi.fn(() => false),
    markTaskRemovalCommitted: vi.fn(),
    persistCleanRestartPermit: vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'candidate-unavailable' as const,
    })),
    prepareTaskRemoval: vi.fn(),
    repairAfterRestart: vi.fn(),
    reserveForTaskCommit: vi.fn(async (request) => {
      currentShell = shellReplay(
        {
          committedWorkspaceRevision: null,
          creationOperationId: request.creationOperationId,
          expectedGeneration: request.expectedGeneration,
          operationId: request.operationId,
          sessionId: request.sessionId,
          taskId: request.taskId,
        },
        'reserved-for-task-commit',
      );
      return currentShell;
    }),
    resolveAmbiguity: vi.fn(),
    restoreManagedSession: vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'session-state-unavailable' as const,
    })),
    retrySameTuple: vi.fn(),
    start: vi.fn(async () => {
      if (!currentShell) throw new Error('shell was not admitted');
      currentShell = shellReplay(currentShell.identity, args.launchFails ? 'admitted' : 'running');
      return currentShell;
    }),
  };
  const execute = vi.fn(
    async (request): Promise<AgentSessionOperationResult> => ({
      kind: 'operation',
      projection: {
        current: {
          catalogVersion: 1,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskState: 'present',
        },
        operation: {
          agentId: request.agentId,
          ...(args.launchFails ? { failure: 'spawn' as const } : {}),
          launchReason: request.launchReason,
          operationId: request.operationId,
          phase: args.launchFails ? 'failed' : 'running',
          resumed: false,
          sourceGeneration: null,
          targetGeneration: 0,
          taskId: request.taskId,
          version: 1,
        },
      },
      replayed: false,
    }),
  );
  const structure = {
    addManagedTask: vi.fn(async (_mutation, request) => {
      committed = { mode: request.taskMode, sessionId: request.sessionId, taskId: request.taskId };
      return { changed: true, result: { task: {}, taskId: request.taskId }, revision: 1 };
    }),
  };
  const current = {
    read: vi.fn(
      async (
        taskId,
        taskMode,
      ): Promise<TaskCreationCommittedCurrentProjection<'agent' | 'terminal'>> =>
        committed
          ? {
              catalogVersion: 1,
              serverInstanceId: 'server-1',
              task: taskSummary(taskId, taskMode, committed.sessionId),
              taskClosing: false,
              taskState: 'present',
              workspaceRevision: 1,
            }
          : {
              catalogVersion: 0,
              serverInstanceId: 'server-1',
              task: null,
              taskClosing: false,
              taskState: 'not-visible',
              workspaceRevision: 0,
            },
    ),
  };
  const workflow = createTaskCreationWorkflow({
    agentSession: { execute },
    authorization: { authorize: vi.fn(() => true) },
    current,
    identities,
    initialPrompt: {
      getProjection: vi.fn(async () => null),
      queue: vi.fn(),
    },
    journal: args.journal ?? journal,
    now: () => NOW,
    ownerCapability,
    preparation,
    shell,
    structure,
    tickets,
  });
  async function intent(overrides: Partial<TaskCreationIntent> = {}): Promise<TaskCreationIntent> {
    const issued = await tickets.issue(auth);
    return {
      launch:
        mode === 'agent'
          ? { agentDefId: 'agent-def-1', kind: 'agent', skipPermissions: false }
          : { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'Test task',
      operationCapability: tickets.createOperationCapability(),
      operationId: issued.operationId,
      operationTicket: issued.operationTicket,
      projectId: 'project-1',
      stepsTracking: false,
      ...overrides,
    };
  }
  return { auth, current, execute, intent, journal, preparation, shell, structure, workflow };
}

describe('task-creation workflow', () => {
  it('commits and starts an agent through one durable phase sequence', async () => {
    const test = makeHarness('agent');
    const result = await test.workflow.create(test.auth, await test.intent());

    expect(result).toMatchObject({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: { commit: 'committed', phase: 'active', taskMode: 'agent' },
    });
    expect(test.journal.phases).toEqual([
      'validating',
      'preparing',
      'committing',
      'starting',
      'active',
    ]);
    expect(test.structure.addManagedTask).toHaveBeenCalledTimes(1);
    expect(test.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        launchReason: 'initial',
        mode: 'initial',
        operationId: 'launch-1',
      }),
    );
  });

  it('accepts the canonical empty-branch representation for non-Git terminal creation', async () => {
    const test = makeHarness('terminal', { projectMode: 'non-git' });
    const result = await test.workflow.create(test.auth, await test.intent());

    expect(result).toMatchObject({
      kind: 'snapshot',
      snapshot: { commit: 'committed', phase: 'active', taskMode: 'terminal' },
    });
    expect(test.structure.addManagedTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        branchName: '',
        projectMode: 'non-git',
        taskMode: 'terminal',
      }),
    );
  });

  it('reserves a terminal before preparation and returns the exact running shell replay', async () => {
    const test = makeHarness('terminal');
    const result = await test.workflow.create(test.auth, await test.intent());

    expect(result).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        phase: 'active',
        shellLaunch: {
          disposition: { kind: 'attempted-no-replay', reason: 'running-at-ack' },
          identity: { operationId: 'launch-1', sessionId: 'shell-1' },
        },
        taskMode: 'terminal',
      },
    });
    expect(test.shell.reserveForTaskCommit).toHaveBeenCalledTimes(1);
    expect(test.preparation.prepare).toHaveBeenCalledTimes(1);
    expect(test.shell.start).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid first-admission ticket without creating state or effects', async () => {
    const test = makeHarness('agent');
    const request = await test.intent({ operationTicket: 'invalid' });
    await expect(test.workflow.create(test.auth, request)).resolves.toEqual({
      code: 'operation-ticket-invalid',
      kind: 'create-rejected-without-snapshot',
    });
    expect(test.journal.records.size).toBe(0);
    expect(test.preparation.prepare).not.toHaveBeenCalled();
    expect(test.structure.addManagedTask).not.toHaveBeenCalled();
  });

  it('maps the journal atomic conflict barrier without starting preparation effects', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    vi.spyOn(test.journal, 'save').mockRejectedValueOnce(
      new TaskCreationConflictAdmissionError(
        deriveTaskCreationConflictKey('project', request.projectId),
        [request.operationId],
      ),
    );

    await expect(test.workflow.create(test.auth, request)).resolves.toEqual({
      code: 'operation-conflict',
      kind: 'create-rejected-without-snapshot',
    });
    expect(test.preparation.prepare).not.toHaveBeenCalled();
    expect(test.structure.addManagedTask).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it('linearizes competing workflows at the durable project barrier before loser effects', async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-task-creation-workflow-conflict-'),
    );
    const journal = createTaskCreationJournal(
      { isPackaged: true, userDataPath },
      { rootPath: path.join(userDataPath, 'journal') },
    );
    await expect(journal.activateFresh()).resolves.toMatchObject({ health: 'healthy' });

    let randomCall = 20;
    const tickets = createTaskCreationOperationTicketIssuer({
      now: () => NOW,
      randomBytes: (length) => {
        randomCall += 1;
        return Uint8Array.from({ length }, (_, index) => (index + randomCall) % 256);
      },
    });
    const identities = (suffix: string): TaskCreationIdentityFactory => ({
      allocate: () => ({
        agentId: `agent-${suffix}`,
        deliveryId: null,
        launchOperationId: `launch-${suffix}`,
        sessionId: `agent-${suffix}`,
        taskId: `task-${suffix}`,
      }),
    });
    const first = makeHarness('agent', {
      identities: identities('first'),
      journal,
      tickets,
    });
    const second = makeHarness('agent', {
      identities: identities('second'),
      journal,
      tickets,
    });
    const firstRequest = await first.intent();
    const secondRequest = await second.intent();

    let markPreparationStarted: () => void = () => undefined;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = () => resolve();
    });
    let releasePreparation: () => void = () => undefined;
    const preparationRelease = new Promise<void>((resolve) => {
      releasePreparation = () => resolve();
    });
    const firstPrepare = vi.mocked(first.preparation.prepare);
    const firstPrepareImplementation = firstPrepare.getMockImplementation();
    if (!firstPrepareImplementation) throw new Error('Expected a preparation implementation');
    firstPrepare.mockImplementation(async (request) => {
      markPreparationStarted();
      await preparationRelease;
      return firstPrepareImplementation(request);
    });

    let firstResultPromise: ReturnType<typeof first.workflow.create> | null = null;
    try {
      firstResultPromise = first.workflow.create(first.auth, firstRequest);
      await preparationStarted;

      await expect(second.workflow.create(second.auth, secondRequest)).resolves.toEqual({
        code: 'operation-conflict',
        kind: 'create-rejected-without-snapshot',
      });
      expect(journal.list()).toHaveLength(1);
      expect(journal.getByOperationId(secondRequest.operationId)).toBeNull();
      expect(second.preparation.prepare).not.toHaveBeenCalled();
      expect(second.structure.addManagedTask).not.toHaveBeenCalled();
      expect(second.execute).not.toHaveBeenCalled();
      expect(second.shell.reserveForTaskCommit).not.toHaveBeenCalled();
      expect(second.shell.start).not.toHaveBeenCalled();

      releasePreparation();
      await expect(firstResultPromise).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'accepted',
        snapshot: { commit: 'committed', phase: 'active' },
      });
      expect(first.preparation.prepare).toHaveBeenCalledOnce();
      expect(first.structure.addManagedTask).toHaveBeenCalledOnce();
      expect(first.execute).toHaveBeenCalledOnce();
    } finally {
      releasePreparation();
      if (firstResultPromise) await Promise.allSettled([firstResultPromise]);
      await journal.close();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('blocks a known validating replay behind a foreign conflict rebuilt on restart', async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-task-creation-workflow-restart-conflict-'),
    );
    const rootPath = path.join(userDataPath, 'journal');
    let randomCall = 40;
    const tickets = createTaskCreationOperationTicketIssuer({
      now: () => NOW,
      randomBytes: (length) => {
        randomCall += 1;
        return Uint8Array.from({ length }, (_, index) => (index + randomCall) % 256);
      },
    });
    const identities: TaskCreationIdentityFactory = {
      allocate: () => ({
        agentId: 'agent-restart',
        deliveryId: null,
        launchOperationId: 'launch-restart',
        sessionId: 'agent-restart',
        taskId: 'task-restart',
      }),
    };
    const seedJournal = createTaskCreationJournal({ isPackaged: true, userDataPath }, { rootPath });
    const seedHarness = makeHarness('agent', { identities, journal: seedJournal, tickets });
    const request = await seedHarness.intent();
    const blockerRequest = await seedHarness.intent();
    const semanticRequest = createNormalizedTaskCreationSemanticRequestV1({
      launch: { agentDefId: 'agent-def-1', kind: 'agent', skipPermissions: false },
      location: { kind: 'project-root' },
      name: 'Test task',
      projectId: 'project-1',
      stepsTracking: false,
    });
    const projectConflict = deriveTaskCreationConflictKey('project', 'project-1');
    const createRecord = (
      intent: TaskCreationIntent,
      identity: { agentId: string; launchOperationId: string; taskId: string },
    ): TaskCreationJournalRecord => {
      const conflictKeys = [
        projectConflict,
        deriveTaskCreationConflictKey('task', identity.taskId),
        deriveTaskCreationConflictKey('launch-operation', identity.launchOperationId),
      ].sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
      );
      return {
        activeConflictKeys: conflictKeys,
        capabilityHash: tickets.hashOperationCapability(intent.operationCapability),
        commit: { kind: 'not-committed' },
        conflictKeys,
        createdAtMs: NOW,
        formatVersion: 1,
        identities: {
          deliveryId: null,
          launchOperationId: identity.launchOperationId,
          sessionId: identity.agentId,
          taskId: identity.taskId,
        },
        issueCode: null,
        operationId: intent.operationId,
        phase: 'validating',
        reconciliation: { kind: 'none' },
        recordVersion: 1,
        retention: { kind: 'nonterminal' },
        semanticFingerprint: deriveTaskCreationSemanticFingerprint(
          intent.operationCapability,
          semanticRequest,
        ),
        taskMode: 'agent',
        updatedAtMs: NOW,
        warning: { warningReservationBytes: 0 },
        workspacePrincipalHash: PRINCIPAL_HASH,
      };
    };
    const admitted = createRecord(request, {
      agentId: 'agent-restart',
      launchOperationId: 'launch-restart',
      taskId: 'task-restart',
    });
    const blocker = createRecord(blockerRequest, {
      agentId: 'agent-blocker',
      launchOperationId: 'launch-blocker',
      taskId: 'task-blocker',
    });
    const legacyDigest = createHash('sha256')
      .update(JSON.stringify([admitted, blocker]))
      .digest('hex');
    await expect(
      seedJournal.activateFromLegacy([admitted, blocker], legacyDigest),
    ).resolves.toMatchObject({ health: 'healthy' });
    await seedJournal.close();

    const journal = createTaskCreationJournal({ isPackaged: true, userDataPath }, { rootPath });
    await expect(journal.startup()).resolves.toMatchObject({ health: 'healthy' });
    const test = makeHarness('agent', { identities, journal, tickets });
    try {
      expect(journal.findConflict(projectConflict)).toHaveLength(2);
      await expect(test.workflow.create(test.auth, request)).resolves.toEqual({
        code: 'operation-conflict',
        kind: 'create-rejected-without-snapshot',
      });
      expect(test.preparation.prepare).not.toHaveBeenCalled();
      expect(test.structure.addManagedTask).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();

      await expect(
        journal.save(
          {
            ...blocker,
            activeConflictKeys: [],
            issueCode: 'preparation-failed',
            phase: 'failed-before-commit',
            recordVersion: 2,
            retention: {
              expiresAtMs: NOW + TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
              kind: 'tombstone',
            },
            updatedAtMs: NOW + 1,
          },
          1,
        ),
      ).resolves.toEqual({ kind: 'committed' });
      await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'accepted',
        snapshot: { commit: 'committed', phase: 'active' },
      });
      expect(test.preparation.prepare).toHaveBeenCalledOnce();
      expect(test.structure.addManagedTask).toHaveBeenCalledOnce();
      expect(test.execute).toHaveBeenCalledOnce();
    } finally {
      await journal.close();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('persists mapping ambiguity against only its predeclared task identity', async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-task-creation-workflow-mapping-'),
    );
    const journal = createTaskCreationJournal(
      { isPackaged: true, userDataPath },
      { rootPath: path.join(userDataPath, 'journal') },
    );
    await expect(journal.activateFresh()).resolves.toMatchObject({ health: 'healthy' });
    const test = makeHarness('agent', { journal });
    const request = await test.intent();
    const taskConflict = deriveTaskCreationConflictKey('task', 'task-1');
    const launchConflict = deriveTaskCreationConflictKey('launch-operation', 'launch-1');
    const projectConflict = deriveTaskCreationConflictKey('project', request.projectId);
    vi.mocked(test.structure.addManagedTask).mockRejectedValueOnce(
      new Error('workspace result was lost'),
    );
    vi.mocked(test.preparation.reconcileFailedCommit).mockResolvedValueOnce({
      kind: 'manual-reconciliation-required',
      reconciliation: {
        expectedTaskId: 'task-1',
        kind: 'mapping-ambiguous',
        resource: { conflictKey: taskConflict, resourceId: 'mapping-resource' },
      },
    });

    try {
      await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'accepted',
        snapshot: {
          issue: { code: 'manual-reconciliation-required' },
          phase: 'manual-reconciliation-required',
        },
      });
      const record = journal.get(PRINCIPAL_HASH, request.operationId);
      if (!record) throw new Error('Expected a durable task-creation record');
      expect(record.activeConflictKeys.map(taskCreationConflictKeyId)).toEqual([
        taskCreationConflictKeyId(taskConflict),
      ]);
      expect(record.conflictKeys.map(taskCreationConflictKeyId)).toEqual(
        expect.arrayContaining([
          taskCreationConflictKeyId(taskConflict),
          taskCreationConflictKeyId(launchConflict),
          taskCreationConflictKeyId(projectConflict),
        ]),
      );
      expect(journal.findConflict(taskConflict)).toHaveLength(1);
      expect(journal.findConflict(launchConflict)).toEqual([]);
      expect(journal.findConflict(projectConflict)).toEqual([]);

      await expect(
        test.workflow.create(test.auth, { ...request, operationTicket: 'lost-response' }),
      ).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'replayed',
        snapshot: { phase: 'manual-reconciliation-required' },
      });
      expect(test.preparation.prepare).toHaveBeenCalledOnce();
      expect(test.structure.addManagedTask).toHaveBeenCalledOnce();
      expect(test.execute).not.toHaveBeenCalled();
    } finally {
      await journal.close();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('persists an artifact ambiguity as the exact retained conflict without widening it', async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-task-creation-workflow-artifact-'),
    );
    const journal = createTaskCreationJournal(
      { isPackaged: true, userDataPath },
      { rootPath: path.join(userDataPath, 'journal') },
    );
    await expect(journal.activateFresh()).resolves.toMatchObject({ health: 'healthy' });
    const test = makeHarness('agent', { journal });
    const request = await test.intent({
      location: { kind: 'managed-worktree', requestedLinkNames: [] },
    });
    const artifactConflict = deriveTaskCreationConflictKey(
      'managed-worktree',
      '/repo/.worktrees/test',
    );
    const projectConflict = deriveTaskCreationConflictKey('project', request.projectId);
    vi.mocked(test.preparation.resolveIntent).mockImplementation(
      async (_intent, _authentication, semanticRequest) => ({
        kind: 'resolved',
        value: {
          agent: { definition: { id: 'agent-def-1' }, definitionId: 'agent-def-1' },
          conflictKeys: [artifactConflict],
          semanticRequest:
            semanticRequest ??
            createNormalizedTaskCreationSemanticRequestV1({
              launch: {
                agentDefId: 'agent-def-1',
                kind: 'agent',
                skipPermissions: false,
              },
              location: {
                kind: 'managed-worktree',
                worktreeLinkRequest: encodeTaskWorktreeLinkRequestV1([]),
              },
              name: 'Test task',
              projectId: 'project-1',
              stepsTracking: false,
            }),
        },
      }),
    );
    vi.mocked(test.preparation.prepare).mockRejectedValueOnce(
      new TaskCreationPreparationManualReconciliationError('artifact outcome is ambiguous', {
        kind: 'artifact-ambiguous',
        resources: [{ conflictKey: artifactConflict, resourceId: 'artifact-resource' }],
      }),
    );

    try {
      await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'accepted',
        snapshot: {
          issue: { code: 'manual-reconciliation-required' },
          phase: 'manual-reconciliation-required',
        },
      });
      const record = journal.get(PRINCIPAL_HASH, request.operationId);
      if (!record) throw new Error('Expected a durable task-creation record');
      expect(record.activeConflictKeys.map(taskCreationConflictKeyId)).toEqual([
        taskCreationConflictKeyId(artifactConflict),
      ]);
      expect(journal.findConflict(artifactConflict)).toHaveLength(1);
      expect(journal.findConflict(projectConflict)).toEqual([]);

      await expect(test.workflow.create(test.auth, await test.intent())).resolves.toEqual({
        code: 'operation-conflict',
        kind: 'create-rejected-without-snapshot',
      });
      expect(test.preparation.prepare).toHaveBeenCalledOnce();
      expect(test.structure.addManagedTask).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();
    } finally {
      await journal.close();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('replays a known exact operation without rechecking its expired or lost ticket', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    await test.workflow.create(test.auth, request);
    const replay = await test.workflow.create(test.auth, { ...request, operationTicket: 'lost' });

    expect(replay).toMatchObject({ kind: 'snapshot', outcome: 'replayed' });
    expect(test.structure.addManagedTask).toHaveBeenCalledTimes(1);
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects changed intent for a known capability without mutating its outcome', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    await test.workflow.create(test.auth, request);
    await expect(
      test.workflow.create(test.auth, { ...request, name: 'Changed task' }),
    ).resolves.toEqual({
      code: 'operation-conflict',
      kind: 'create-rejected-without-snapshot',
    });
    expect(test.structure.addManagedTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['project', {}],
    ['agent', {}],
    ['base branch', { baseBranchRef: 'b_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    [
      'existing worktree',
      {
        location: {
          kind: 'existing-worktree' as const,
          worktreeRef: 'w_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, Partial<TaskCreationIntent>]>)(
    'replays a committed operation after its %s selection disappears',
    async (_selection, overrides) => {
      const test = makeHarness('agent');
      const request = await test.intent(overrides);
      await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'accepted',
        snapshot: { commit: 'committed' },
      });
      expect(test.preparation.resolveIntent).toHaveBeenCalledOnce();

      vi.mocked(test.preparation.resolveIntent).mockResolvedValue({
        code: 'capability-denied',
        kind: 'rejected',
      });
      await expect(
        test.workflow.create(test.auth, { ...request, operationTicket: 'lost-response' }),
      ).resolves.toMatchObject({
        kind: 'snapshot',
        outcome: 'replayed',
        snapshot: { commit: 'committed', committedTaskId: 'task-1' },
      });
      await expect(
        test.workflow.create(test.auth, {
          ...request,
          name: 'Changed semantic request',
          operationTicket: 'lost-response',
        }),
      ).resolves.toEqual({
        code: 'operation-conflict',
        kind: 'create-rejected-without-snapshot',
      });
      expect(test.preparation.resolveIntent).toHaveBeenCalledOnce();
      expect(test.preparation.prepare).toHaveBeenCalledOnce();
      expect(test.structure.addManagedTask).toHaveBeenCalledOnce();
    },
  );

  it('charges invalid fresh selections to first-admission limits before any durable effect', async () => {
    const test = makeHarness('agent');
    vi.mocked(test.preparation.resolveIntent).mockResolvedValue({
      code: 'capability-denied',
      kind: 'rejected',
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(test.workflow.create(test.auth, await test.intent())).resolves.toEqual({
        code: 'capability-denied',
        kind: 'create-rejected-without-snapshot',
      });
    }
    await expect(test.workflow.create(test.auth, await test.intent())).resolves.toEqual({
      code: 'rate-limited',
      kind: 'create-rejected-without-snapshot',
    });

    expect(test.preparation.resolveIntent).toHaveBeenCalledTimes(3);
    expect(test.journal.records.size).toBe(0);
    expect(test.preparation.prepare).not.toHaveBeenCalled();
    expect(test.structure.addManagedTask).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.shell.reserveForTaskCommit).not.toHaveBeenCalled();
  });

  it('keeps a pre-record subscription silent until durable snapshots exist', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    const listener = vi.fn((_snapshot: TaskCreationOperationSnapshot) => undefined);
    const subscription = await test.workflow.subscribeOperation(test.auth, request, listener);
    expect(subscription.kind).toBe('subscribed');
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { commit: 'committed', phase: 'active' },
    });
    await test.workflow.refreshOperation(request.operationId);
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls[listener.mock.calls.length - 1]?.[0]).toMatchObject({
      commit: 'committed',
      operationId: request.operationId,
      phase: 'active',
    });

    if (subscription.kind !== 'subscribed') return;
    await subscription.unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    await test.workflow.refreshOperation(request.operationId);
    expect(listener).toHaveBeenCalledTimes(callsAfterUnsubscribe);
  });

  it('publishes nothing when the first durable record write fails', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    const listener = vi.fn((_snapshot: TaskCreationOperationSnapshot) => undefined);
    const subscription = await test.workflow.subscribeOperation(test.auth, request, listener);
    expect(subscription.kind).toBe('subscribed');
    vi.spyOn(test.journal, 'save').mockRejectedValueOnce(new Error('durability unavailable'));

    await expect(test.workflow.create(test.auth, request)).resolves.toEqual({
      code: 'operation-journal-repair-required',
      kind: 'operation-journal-unavailable',
    });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    if (subscription.kind === 'subscribed') await subscription.unsubscribe();
  });

  it('does not leak refreshed state across principals or capabilities', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    await test.workflow.create(test.auth, request);
    await test.workflow.refreshOperation(request.operationId);
    test.current.read.mockClear();
    const listener = vi.fn((_snapshot: TaskCreationOperationSnapshot) => undefined);
    const otherPrincipalListener = vi.fn((_snapshot: TaskCreationOperationSnapshot) => undefined);
    const operationCapability =
      createTaskCreationOperationTicketIssuer().createOperationCapability();

    const subscription = await test.workflow.subscribeOperation(
      test.auth,
      { ...request, operationCapability },
      listener,
    );
    const otherPrincipalSubscription = await test.workflow.subscribeOperation(
      { ...test.auth, workspacePrincipalId: 'principal-2' },
      request,
      otherPrincipalListener,
    );
    expect(subscription.kind).toBe('subscribed');
    expect(otherPrincipalSubscription.kind).toBe('subscribed');
    await test.workflow.refreshOperation(request.operationId);
    expect(listener).not.toHaveBeenCalled();
    expect(otherPrincipalListener).not.toHaveBeenCalled();
    expect(test.current.read).not.toHaveBeenCalled();
    if (subscription.kind === 'subscribed') await subscription.unsubscribe();
    if (otherPrincipalSubscription.kind === 'subscribed') {
      await otherPrincipalSubscription.unsubscribe();
    }
  });

  it('drops an authorized operation event when current projection is unavailable', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    await test.workflow.create(test.auth, request);
    await test.workflow.refreshOperation(request.operationId);
    test.current.read.mockRejectedValue(new Error('canonical host unavailable'));
    const listener = vi.fn((_snapshot: TaskCreationOperationSnapshot) => undefined);

    const subscription = await test.workflow.subscribeOperation(test.auth, request, listener);
    expect(subscription.kind).toBe('subscribed');
    await test.workflow.refreshOperation(request.operationId);
    expect(listener).not.toHaveBeenCalled();
    if (subscription.kind === 'subscribed') await subscription.unsubscribe();
  });

  it('bounds pending operation subscriptions independently of operation existence', async () => {
    const test = makeHarness('agent');
    const request = await test.intent();
    const subscriptions = [];
    for (let index = 0; index < 16; index += 1) {
      const subscription = await test.workflow.subscribeOperation(test.auth, request, vi.fn());
      expect(subscription.kind).toBe('subscribed');
      if (subscription.kind === 'subscribed') subscriptions.push(subscription);
    }
    await expect(test.workflow.subscribeOperation(test.auth, request, vi.fn())).resolves.toEqual({
      code: 'rate-limited',
      kind: 'lookup-rejected-without-snapshot',
    });
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    const recovered = await test.workflow.subscribeOperation(test.auth, request, vi.fn());
    expect(recovered).toMatchObject({ kind: 'subscribed' });
    if (recovered.kind === 'subscribed') await recovered.unsubscribe();
  });

  it('keeps the committed task and exposes typed attention when initial launch fails', async () => {
    const test = makeHarness('agent', { launchFails: true });
    const result = await test.workflow.create(test.auth, await test.intent());
    expect(result).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        commit: 'committed',
        issue: { code: 'launch-failed' },
        phase: 'created-needs-attention',
        recovery: { kind: 'retry-agent-launch', launchOperationId: 'launch-1' },
      },
    });
    expect(test.structure.addManagedTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['agent', 'launch-failed'],
    ['terminal', 'projection-repair-required'],
  ] as const)(
    'projects an adopted %s mapping as actionable attention without replaying creation',
    async (mode, issueCode) => {
      const test = makeHarness(mode);
      const request = await test.intent();
      await expect(test.workflow.create(test.auth, request)).resolves.toMatchObject({
        kind: 'snapshot',
        snapshot: { commit: 'committed', phase: 'active' },
      });
      const current = test.journal.get(PRINCIPAL_HASH, request.operationId);
      if (!current || current.commit.kind !== 'committed') {
        throw new Error('Expected a committed creation record');
      }
      const adopted: TaskCreationJournalRecord = {
        ...current,
        issueCode,
        phase: 'created-needs-attention',
      };
      vi.mocked(test.preparation.prepare).mockClear();
      vi.mocked(test.structure.addManagedTask).mockClear();
      test.execute.mockClear();
      vi.mocked(test.shell.reserveForTaskCommit).mockClear();
      vi.mocked(test.shell.start).mockClear();

      const snapshot = await test.workflow.projectRecord(adopted);
      expect(snapshot).toMatchObject({
        commit: 'committed',
        issue: { code: issueCode },
        phase: 'created-needs-attention',
        taskMode: mode,
      });
      if (mode === 'agent') {
        expect(snapshot).toMatchObject({
          recovery: { kind: 'retry-agent-launch', launchOperationId: 'launch-1' },
        });
      } else {
        expect(snapshot).not.toHaveProperty('recovery');
      }
      expect(test.preparation.prepare).not.toHaveBeenCalled();
      expect(test.structure.addManagedTask).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();
      expect(test.shell.reserveForTaskCommit).not.toHaveBeenCalled();
      expect(test.shell.start).not.toHaveBeenCalled();
    },
  );

  it('binds status lookup to the admitting principal and operation capability', async () => {
    const test = makeHarness('terminal');
    const request = await test.intent();
    await test.workflow.create(test.auth, request);
    const found = await test.workflow.get(test.auth, request);
    expect(found).toMatchObject({ kind: 'snapshot', outcome: 'found' });

    const otherCapability = createTaskCreationOperationTicketIssuer().createOperationCapability();
    await expect(
      test.workflow.get(test.auth, { ...request, operationCapability: otherCapability }),
    ).resolves.toEqual({
      code: 'capability-denied',
      kind: 'lookup-rejected-without-snapshot',
    });
    expect(test.journal.get(PRINCIPAL_HASH, request.operationId)).not.toBeNull();
  });
});
