import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import {
  TASK_REMOVAL_CLEANUP_STEPS,
  TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
  type TaskRemovalCleanupStep,
  type TaskRemovalParticipantId,
  type TaskRemovalParticipantRequest,
} from '../../src/domain/task-removal-owner.js';
import type { StorageEnv } from './storage.js';
import type {
  TaskRemovalCleanupStepRequest,
  TaskRemovalCleanupStepResult,
  TaskRemovalOwnerParticipant,
  TaskRemovalParticipantStepResult,
} from './task-removal-owner.js';
import { TaskMergeOperationIssuer } from './task-merge-operation-issuer.js';
import { TaskStructureMutationService } from './task-structure-mutations.js';
import {
  activateTaskMergeBackend,
  type ActiveTaskMergeBackend,
  type TaskMergeGitRequest,
} from './task-merge-workflow.js';
import {
  WorkspaceMutationService,
  activateProtectedPolicies,
  changed,
} from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type WorkspaceHostRecord,
  type WorkspaceHostSnapshot,
  type WorkspaceStateStorage,
  type WorkspaceStorageCommitResult,
  type WorkspaceStorageRepairResult,
  type WorkspaceStorageStartupResult,
} from './workspace-state-storage.js';

const LOOKUP_SAMPLE_COUNT = 250;
const CAPABILITY_LOOKUP_P95_BUDGET_MS = 2;
const PUBLIC_SNAPSHOT_BUDGET_BYTES = 2 * 1_024;
const MAX_GLOBAL_NONTERMINAL_OPERATIONS = 256;
const DELETE_OWNED_WRITE_BUDGET = 22;
const BRANCH_PRESERVE_WRITE_BUDGET = 20;
const REPLAY_PERMUTATION_COUNT = 1_000;
const UNRELATED_TASK_COUNT = 100;
const UNRELATED_ADMISSION_P95_REGRESSION_LIMIT = 0.05;
const ADMISSION_REPETITIONS_PER_SAMPLE = 5_000;
const ADMISSION_SAMPLE_COUNT = 40;
const ADMISSION_ESTIMATE_COUNT = 5;

class CountingWorkspaceStateStorage implements WorkspaceStateStorage {
  commitCount = 0;

  constructor(private readonly storage: WorkspaceStateStorage) {}

  get backupPath(): string {
    return this.storage.backupPath;
  }

  get canonicalIdentity(): string {
    return this.storage.canonicalIdentity;
  }

  get kind(): WorkspaceStateStorage['kind'] {
    return this.storage.kind;
  }

  get primaryPath(): string {
    return this.storage.primaryPath;
  }

  get temporaryPath(): string {
    return this.storage.temporaryPath;
  }

  close(): Promise<void> {
    return this.storage.close();
  }

  commitHostRecord(
    prior: WorkspaceHostSnapshot,
    proposed: WorkspaceHostRecord,
  ): Promise<WorkspaceStorageCommitResult> {
    this.commitCount += 1;
    return this.storage.commitHostRecord(prior, proposed);
  }

  loadCurrent(): Promise<WorkspaceHostSnapshot> {
    return this.storage.loadCurrent();
  }

  repairDurability(expected: WorkspaceHostRecord): Promise<WorkspaceStorageRepairResult> {
    return this.storage.repairDurability(expected);
  }

  resetCommitCount(): void {
    this.commitCount = 0;
  }

  startup(): Promise<WorkspaceStorageStartupResult> {
    return this.storage.startup();
  }
}

interface IssuerFixture {
  accessGenerationCount(): number;
  close(): Promise<void>;
  issuer: TaskMergeOperationIssuer;
  storage: CountingWorkspaceStateStorage;
}

interface WorkflowHarnessOptions {
  cleanupStepResult?: (
    request: TaskRemovalCleanupStepRequest,
  ) => Promise<TaskRemovalCleanupStepResult> | TaskRemovalCleanupStepResult;
  deleteBranchOnClose?: boolean;
  drainResult?: (
    participantId: Exclude<TaskRemovalParticipantId, 'task-runtime'>,
    request: TaskRemovalParticipantRequest,
  ) => Promise<TaskRemovalParticipantStepResult> | TaskRemovalParticipantStepResult;
  taskCount?: number;
}

interface WorkflowHarness {
  backend: ActiveTaskMergeBackend;
  cleanupStepCalls: TaskRemovalCleanupStep[];
  close(): Promise<void>;
  gitCalls: TaskMergeGitRequest[];
  storage: CountingWorkspaceStateStorage;
  structure: TaskStructureMutationService;
  taskIds: string[];
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function median(values: readonly number[]): number {
  return percentile(
    [...values].sort((left, right) => left - right),
    0.5,
  );
}

function createOperationAccess(index: number): {
  operationCapability: string;
  operationId: string;
} {
  return {
    operationCapability: index.toString(36).padStart(43, '0'),
    operationId: `task-merge-performance:${index}`,
  };
}

async function createIssuerFixture(taskCount: number): Promise<IssuerFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-merge-performance-'));
  const env: StorageEnv = { isPackaged: true, userDataPath: root };
  const delegate = await createStandaloneWorkspaceStateStorage(env);
  const storage = new CountingWorkspaceStateStorage(delegate);
  const workspace = new WorkspaceMutationService(storage);
  const taskIds = Array.from({ length: taskCount }, (_, index) => `task-${index + 1}`);
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-merge-performance' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: taskIds,
      tasks: Object.fromEntries(
        taskIds.map((taskId, index) => [
          taskId,
          {
            branchName: `task/branch-${index + 1}`,
            gitIsolation: 'worktree',
            id: taskId,
            name: `Task ${index + 1}`,
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: `/repo/.worktrees/${taskId}`,
          },
        ]),
      ),
    },
    undefined,
  );
  let generatedAccessCount = 0;
  const issuer = new TaskMergeOperationIssuer(workspace.createPrivateMutationAuthority(), {
    createCutoverEpoch: () => 'merge-performance-cutover',
    createOperationAccess: () => createOperationAccess(++generatedAccessCount),
    now: () => Date.parse('2026-08-04T00:00:00.000Z'),
  });
  await issuer.activate({
    disableLegacyMergeWriters: async () => undefined,
    verifyLegacyMergeWritersDisabled: async () => undefined,
  });
  return {
    accessGenerationCount: () => generatedAccessCount,
    async close() {
      await storage.close();
      fs.rmSync(root, { force: true, recursive: true });
    },
    issuer,
    storage,
  };
}

function participant(
  id: TaskRemovalParticipantId,
  workspace: WorkspaceMutationService,
  options: WorkflowHarnessOptions,
  cleanupStepCalls: TaskRemovalCleanupStep[],
): TaskRemovalOwnerParticipant {
  const hookSetVersion =
    id === 'agent-session'
      ? AGENT_SESSION_OWNER_HOOK_SET_VERSION
      : id === 'initial-prompt'
        ? TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        : TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION;
  return {
    activateLegacyEffectCutover: async () => {
      if (id !== 'initial-prompt') return;
      await workspace
        .createPrivateMutationAuthority()
        .mutate({ operation: 'activate-performance-initial-prompt-owner' }, (slices) =>
          changed(
            {
              nextPrivateState: activateProtectedPolicies(slices.privateState, ['initial-prompt']),
            },
            undefined,
          ),
        );
    },
    async drainTaskForRemoval(request) {
      if (id === 'task-runtime') return { kind: 'complete' };
      return options.drainResult?.(id, request) ?? { kind: 'complete' };
    },
    ...(id === 'task-runtime'
      ? {
          async cleanupTaskRuntimeStep(request: TaskRemovalCleanupStepRequest) {
            cleanupStepCalls.push(request.step);
            return (
              (await options.cleanupStepResult?.(request)) ?? {
                evidence: { state: 'performance-complete' },
                kind: 'step-complete' as const,
                step: request.step,
              }
            );
          },
        }
      : {}),
    finalizeRemovedTaskState: async () => ({ kind: 'complete' }),
    hookSetVersion,
    id,
    probe: async () => ({ hookSetVersion, kind: 'ready' }),
    verifyLegacyEffectCutover: async () => undefined,
  };
}

async function activateManagedWriter(service: TaskStructureMutationService): Promise<void> {
  await service.activateManagedTaskCreationWriter({
    async classify(_taskId, task) {
      return task.taskMode === 'agent'
        ? {
            operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
            shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
          }
        : {
            operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
            shellOwnership: { kind: 'legacy-unmanaged-terminal', migrationSchemaVersion: 1 },
          };
    },
  });
}

async function createWorkflowHarness(
  options: WorkflowHarnessOptions = {},
): Promise<WorkflowHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-merge-workflow-performance-'));
  const env: StorageEnv = { isPackaged: true, userDataPath: root };
  const delegate = await createStandaloneWorkspaceStateStorage(env);
  const storage = new CountingWorkspaceStateStorage(delegate);
  const workspace = new WorkspaceMutationService(storage);
  const structure = new TaskStructureMutationService(workspace, {
    removalOwner: {
      createCutoverEpoch: () => 'task-removal-performance-cutover',
      serverInstanceId: 'task-removal-performance-server',
    },
  });
  const taskIds = Array.from({ length: options.taskCount ?? 1 }, (_, index) => `task-${index + 1}`);
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-task-merge-workflow-performance' },
    {
      collapsedTaskOrder: [],
      completedTaskCount: 0,
      completedTaskDate: '2026-08-04',
      mergedLinesAdded: 0,
      mergedLinesRemoved: 0,
      projects: [
        {
          ...(options.deleteBranchOnClose === false ? { deleteBranchOnClose: false } : {}),
          id: 'project-1',
          name: 'Project',
          path: '/repo',
        },
      ],
      taskOrder: taskIds,
      tasks: Object.fromEntries(
        taskIds.map((taskId, index) => [
          taskId,
          {
            branchName: `task/branch-${index + 1}`,
            gitIsolation: 'worktree',
            id: taskId,
            name: `Task ${index + 1}`,
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: `/repo/.worktrees/${taskId}`,
          },
        ]),
      ),
    },
    undefined,
  );
  const cleanupStepCalls: TaskRemovalCleanupStep[] = [];
  await structure.ensurePreManagedWriterCutover();
  await structure.activateTaskRemovalOwner([
    participant('initial-prompt', workspace, options, cleanupStepCalls),
    participant('agent-session', workspace, options, cleanupStepCalls),
    participant('task-runtime', workspace, options, cleanupStepCalls),
  ]);
  await activateManagedWriter(structure);
  const gitCalls: TaskMergeGitRequest[] = [];
  let accessIndex = 0;
  const backend = await activateTaskMergeBackend({
    authorize: async () => true,
    async executeGit(request) {
      gitCalls.push(structuredClone(request));
      return { linesAdded: 7, linesRemoved: 2 };
    },
    issuerOptions: {
      createCutoverEpoch: () => 'task-merge-performance-cutover',
      createOperationAccess: () => createOperationAccess(++accessIndex),
      now: () => Date.parse('2026-08-04T08:00:00.000Z'),
    },
    legacyWriterCutover: {
      disableLegacyMergeWriters: async () => undefined,
      verifyLegacyMergeWritersDisabled: async () => undefined,
    },
    now: () => Date.parse('2026-08-04T08:00:00.000Z'),
    structure,
    workspace,
  });
  return {
    backend,
    cleanupStepCalls,
    async close() {
      await storage.close();
      fs.rmSync(root, { force: true, recursive: true });
    },
    gitCalls,
    storage,
    structure,
    taskIds,
  };
}

async function issueTaskMerge(backend: ActiveTaskMergeBackend, taskId = 'task-1') {
  const access = await backend.workflow.issue({ principalId: 'principal-1', taskId });
  return {
    access,
    request: { cleanup: true, squash: false, taskId },
  } as const;
}

function measureAdmissionP95(
  structure: TaskStructureMutationService,
  taskIds: readonly string[],
): number {
  const samples: number[] = [];
  for (let sample = 0; sample < ADMISSION_SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    for (let repetition = 0; repetition < ADMISSION_REPETITIONS_PER_SAMPLE; repetition += 1) {
      for (const taskId of taskIds) {
        if (structure.isTaskMutationAdmissionClosed(taskId)) {
          throw new Error(`Unrelated task ${taskId} unexpectedly closed`);
        }
      }
    }
    samples.push(performance.now() - startedAt);
  }
  return percentile(
    samples.sort((left, right) => left - right),
    0.95,
  );
}

describe('task merge workflow performance', () => {
  it('keeps capability validation/hash lookup and the public snapshot bounded', async () => {
    const fixture = await createIssuerFixture(1);
    try {
      const access = await fixture.issuer.issue({ principalId: 'principal-1', taskId: 'task-1' });
      const samples: number[] = [];
      let publicSnapshot = fixture.issuer.snapshot(
        await fixture.issuer.getAuthorizedRecord('principal-1', access),
      );
      for (let index = 0; index < LOOKUP_SAMPLE_COUNT; index += 1) {
        const startedAt = performance.now();
        const record = await fixture.issuer.getAuthorizedRecord('principal-1', access);
        samples.push(performance.now() - startedAt);
        publicSnapshot = fixture.issuer.snapshot(record);
      }
      samples.sort((left, right) => left - right);
      const p95Ms = percentile(samples, 0.95);
      const snapshotBytes = Buffer.byteLength(JSON.stringify(publicSnapshot), 'utf8');
      process.stdout.write(
        `task-merge-capability-lookup samples=${LOOKUP_SAMPLE_COUNT} p95=${p95Ms.toFixed(3)}ms budget=${CAPABILITY_LOOKUP_P95_BUDGET_MS}ms snapshot=${snapshotBytes}B snapshotBudget=${PUBLIC_SNAPSHOT_BUDGET_BYTES}B\n`,
      );

      expect(p95Ms).toBeLessThan(CAPABILITY_LOOKUP_P95_BUDGET_MS);
      expect(snapshotBytes).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_BUDGET_BYTES);
    } finally {
      await fixture.close();
    }
  });

  it('rejects global nonterminal saturation before access generation or a durable write', async () => {
    const fixture = await createIssuerFixture(MAX_GLOBAL_NONTERMINAL_OPERATIONS + 1);
    try {
      for (let index = 0; index < MAX_GLOBAL_NONTERMINAL_OPERATIONS; index += 1) {
        await fixture.issuer.issue({
          principalId: `principal-${index + 1}`,
          taskId: `task-${index + 1}`,
        });
      }
      const accessGenerationCount = fixture.accessGenerationCount();
      const commitCount = fixture.storage.commitCount;

      await expect(
        fixture.issuer.issue({
          principalId: 'principal-over-capacity',
          taskId: `task-${MAX_GLOBAL_NONTERMINAL_OPERATIONS + 1}`,
        }),
      ).rejects.toMatchObject({ code: 'task-merge-operation-capacity' });

      expect(fixture.accessGenerationCount()).toBe(accessGenerationCount);
      expect(fixture.storage.commitCount).toBe(commitCount);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it.each([
    {
      deleteBranchOnClose: true,
      label: 'delete-owned',
      maxWrites: DELETE_OWNED_WRITE_BUDGET,
      requiredSteps: [...TASK_REMOVAL_CLEANUP_STEPS],
    },
    {
      deleteBranchOnClose: false,
      label: 'branch-preserve',
      maxWrites: BRANCH_PRESERVE_WRITE_BUDGET,
      requiredSteps: TASK_REMOVAL_CLEANUP_STEPS.filter((step) => step !== 'branch-release'),
    },
  ])(
    'keeps the $label lifecycle within its durable-write ceiling and skips all terminal replay work',
    async ({ deleteBranchOnClose, label, maxWrites, requiredSteps }) => {
      const harness = await createWorkflowHarness({ deleteBranchOnClose });
      try {
        const { access, request } = await issueTaskMerge(harness.backend);
        harness.storage.resetCommitCount();
        const completed = await harness.backend.workflow.start({
          access,
          principalId: 'principal-1',
          semanticRequest: request,
        });
        const lifecycleWrites = harness.storage.commitCount;
        const state = (await harness.storage.loadCurrent()).record;
        const serializedPrivateState = JSON.stringify(state.privateState);
        process.stdout.write(
          `task-merge-${label} hostWrites=${lifecycleWrites} budget=${maxWrites} gitInvocations=${harness.gitCalls.length}\n`,
        );

        expect(completed).toMatchObject({
          currentProgress: { linesAdded: 7, linesRemoved: 2, tasksToday: 1 },
          currentRemoval: { removalState: 'complete', removed: true },
          originalOutcome: { counted: true, phase: 'completed', taskReleased: true },
        });
        expect(lifecycleWrites).toBeLessThanOrEqual(maxWrites);
        expect(harness.cleanupStepCalls).toEqual(requiredSteps);
        expect(harness.gitCalls).toEqual([
          {
            branchName: 'task/branch-1',
            cleanup: false,
            projectRoot: '/repo',
            squash: false,
            taskId: 'task-1',
            worktreePath: '/repo/.worktrees/task-1',
          },
        ]);
        expect(serializedPrivateState).not.toContain('committing');
        expect(state.privateState).toMatchObject({
          taskRemovalOperations: {
            deletionOperationIdByTaskId: { 'task-1': access.operationId },
            recordsByDeletionOperationId: {
              [access.operationId]: {
                deletionOperationId: access.operationId,
                phase: 'complete',
                taskId: 'task-1',
              },
            },
          },
        });
        expect(state.sharedState.tasks).not.toHaveProperty('task-1');

        harness.storage.resetCommitCount();
        const cleanupCalls = harness.cleanupStepCalls.length;
        await harness.backend.workflow.start({
          access,
          principalId: 'principal-1',
          semanticRequest: request,
        });
        expect(harness.storage.commitCount).toBe(0);
        expect(harness.gitCalls).toHaveLength(1);
        expect(harness.cleanupStepCalls).toHaveLength(cleanupCalls);
      } finally {
        await harness.close();
      }
    },
    30_000,
  );

  it('resumes a failed cleanup step without reinvoking completed steps or Git', async () => {
    let failedOnce = false;
    const harness = await createWorkflowHarness({
      cleanupStepResult(request) {
        if (request.step === 'runtime-state' && !failedOnce) {
          failedOnce = true;
          return { kind: 'retry-required', reason: 'performance-checkpoint' };
        }
        return {
          evidence: { state: 'performance-complete' },
          kind: 'step-complete',
          step: request.step,
        };
      },
    });
    try {
      const { access, request } = await issueTaskMerge(harness.backend);
      harness.storage.resetCommitCount();
      const pending = await harness.backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      });
      expect(pending).toMatchObject({
        currentRemoval: { removalState: 'cleanup-pending', removed: false },
        originalOutcome: { gitMerged: true, phase: 'merged-awaiting-removal' },
      });

      const completed = await harness.backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      });
      expect(completed.originalOutcome.phase).toBe('completed');
      expect(harness.gitCalls).toHaveLength(1);
      expect(harness.storage.commitCount).toBeLessThanOrEqual(DELETE_OWNED_WRITE_BUDGET);
      expect(harness.cleanupStepCalls).toEqual([
        'runners',
        'containers',
        'runtime-state',
        'runtime-state',
        'coordinator',
        'worktree-quarantine',
        'branch-release',
        'shell-prepare',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('keeps 1,000 terminal replay permutations write-, Git-, cleanup-, and progress-neutral', async () => {
    const harness = await createWorkflowHarness();
    try {
      const { access, request } = await issueTaskMerge(harness.backend);
      await harness.backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      });
      const cleanupCalls = harness.cleanupStepCalls.length;
      harness.storage.resetCommitCount();

      for (let offset = 0; offset < REPLAY_PERMUTATION_COUNT; offset += 50) {
        await Promise.all(
          Array.from({ length: 50 }, (_, batchIndex) => {
            const index = offset + batchIndex;
            return index % 2 === 0
              ? harness.backend.workflow.status({ access, principalId: 'principal-1' })
              : harness.backend.workflow.start({
                  access,
                  principalId: 'principal-1',
                  semanticRequest: request,
                });
          }),
        );
      }

      const state = (await harness.storage.loadCurrent()).record.sharedState;
      expect(harness.storage.commitCount).toBe(0);
      expect(harness.gitCalls).toHaveLength(1);
      expect(harness.cleanupStepCalls).toHaveLength(cleanupCalls);
      expect(state).toMatchObject({
        completedTaskCount: 1,
        mergedLinesAdded: 7,
        mergedLinesRemoved: 2,
        mergeProgress: { tasksToday: 1, version: 2 },
      });
      expect(state.tasks).not.toHaveProperty('task-1');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('keeps O(1) unrelated-task admission within 5% p95 while the target drain is held', async () => {
    let releaseDrain!: () => void;
    let signalDrainEntered!: () => void;
    const drainEntered = new Promise<void>((resolve) => {
      signalDrainEntered = resolve;
    });
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const baselineHarness = await createWorkflowHarness({
      taskCount: UNRELATED_TASK_COUNT + 1,
    });
    const activeHarness = await createWorkflowHarness({
      async drainResult(participantId) {
        if (participantId === 'agent-session') {
          signalDrainEntered();
          await drainGate;
        }
        return { kind: 'complete' };
      },
      taskCount: UNRELATED_TASK_COUNT + 1,
    });
    let pending: ReturnType<ActiveTaskMergeBackend['workflow']['start']> | undefined;
    try {
      const unrelatedTaskIds = activeHarness.taskIds.slice(1);
      const { access, request } = await issueTaskMerge(activeHarness.backend);
      pending = activeHarness.backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      });
      await drainEntered;
      expect(activeHarness.structure.isTaskMutationAdmissionClosed('task-1')).toBe(true);

      measureAdmissionP95(baselineHarness.structure, unrelatedTaskIds);
      measureAdmissionP95(activeHarness.structure, unrelatedTaskIds);
      const baselineEstimates: number[] = [];
      const activeEstimates: number[] = [];
      const regressionEstimates: number[] = [];
      for (let index = 0; index < ADMISSION_ESTIMATE_COUNT; index += 1) {
        const first = index % 2 === 0 ? baselineHarness : activeHarness;
        const second = index % 2 === 0 ? activeHarness : baselineHarness;
        const firstEstimate = measureAdmissionP95(first.structure, unrelatedTaskIds);
        const secondEstimate = measureAdmissionP95(second.structure, unrelatedTaskIds);
        if (first === baselineHarness) {
          baselineEstimates.push(firstEstimate);
          activeEstimates.push(secondEstimate);
          regressionEstimates.push((secondEstimate - firstEstimate) / firstEstimate);
        } else {
          activeEstimates.push(firstEstimate);
          baselineEstimates.push(secondEstimate);
          regressionEstimates.push((firstEstimate - secondEstimate) / secondEstimate);
        }
      }
      const baselineP95Ms = median(baselineEstimates);
      const activeP95Ms = median(activeEstimates);
      const regression = median(regressionEstimates);
      process.stdout.write(
        `task-merge-unrelated-admission tasks=${UNRELATED_TASK_COUNT} baselineP95=${baselineP95Ms.toFixed(3)}ms activeP95=${activeP95Ms.toFixed(3)}ms regression=${(regression * 100).toFixed(2)}% budget=${UNRELATED_ADMISSION_P95_REGRESSION_LIMIT * 100}%\n`,
      );
      expect(regression).toBeLessThanOrEqual(UNRELATED_ADMISSION_P95_REGRESSION_LIMIT);

      releaseDrain();
      await pending;
      pending = undefined;
    } finally {
      releaseDrain?.();
      await pending?.catch(() => undefined);
      await activeHarness.close();
      await baselineHarness.close();
    }
  }, 30_000);
});
