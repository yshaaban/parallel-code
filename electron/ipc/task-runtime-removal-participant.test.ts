import { describe, expect, it, vi } from 'vitest';

import type {
  TaskRemovalCleanupStep,
  TaskRemovalParticipantRequest,
} from '../../src/domain/task-removal-owner.js';
import { WorkspaceTaskRemovalLegacyWriterGate } from './task-removal-legacy-writer-gate.js';
import type { TaskRemovalCleanupStepRequest } from './task-removal-owner.js';
import { createTaskRuntimeRemovalParticipant } from './task-runtime-removal-participant.js';

function request(): TaskRemovalParticipantRequest {
  return {
    cleanupPlan: {
      agentIds: ['agent-1'],
      branchName: 'task/one',
      deleteBranch: true,
      gitCleanup: 'managed-worktree',
      launchOperationId: null,
      preparedWorkspaceRevision: 1,
      projectMode: 'git',
      projectRoot: '/repo',
      quarantinePath: '/repo/.worktrees/.parallel-code-recovery/operation/worktree',
      taskId: 'task-1',
      taskIdentityWitness: 'a'.repeat(64),
      taskMode: 'agent',
      worktreePath: '/repo/.worktrees/task/one',
    },
    deletionOperationId: 'delete-1',
    taskId: 'task-1',
  };
}

function stepRequest(
  step: TaskRemovalCleanupStep,
  evidence: TaskRemovalCleanupStepRequest['evidence'] = {},
): TaskRemovalCleanupStepRequest {
  return {
    ...request(),
    completedSteps: [],
    evidence,
    step,
  };
}

describe('task runtime removal participant', () => {
  it('owns each infrastructure effect as one independently acknowledged cleanup step', async () => {
    const released = {
      action: 'close task',
      controllerId: 'client-1',
      taskId: 'task-1',
      version: 2,
    };
    const calls: string[] = [];
    const onReleasedTaskCommandController = vi.fn();
    const participant = createTaskRuntimeRemovalParticipant({
      cleanupContainers: async () => {
        calls.push('containers');
      },
      cleanupCoordinatorTaskState: async () => {
        calls.push('coordinator');
        return [];
      },
      cleanupRunners: async () => {
        calls.push('runners');
      },
      cleanupRuntimeState: async () => {
        calls.push('runtime-state');
        return { releasedTaskCommandController: released };
      },
      finalizeRemovedTaskState: vi.fn(),
      legacyWriterGate: new WorkspaceTaskRemovalLegacyWriterGate(),
      onReleasedTaskCommandController,
      quarantineWorktree: async () => {
        calls.push('worktree-quarantine');
        return { headOid: 'a'.repeat(40), state: 'quarantined-detached' };
      },
      releaseBranch: async (_request, evidence) => {
        calls.push(`branch-release:${String(evidence?.state)}`);
        return { state: 'released' };
      },
    });

    for (const step of ['runners', 'containers', 'runtime-state', 'coordinator'] as const) {
      await expect(participant.cleanupTaskRuntimeStep?.(stepRequest(step))).resolves.toMatchObject({
        kind: 'step-complete',
        step,
      });
    }
    const quarantine = await participant.cleanupTaskRuntimeStep?.(
      stepRequest('worktree-quarantine'),
    );
    expect(quarantine).toMatchObject({ kind: 'step-complete', step: 'worktree-quarantine' });
    const quarantineEvidence =
      quarantine?.kind === 'step-complete' ? quarantine.evidence : undefined;
    await expect(
      participant.cleanupTaskRuntimeStep?.(
        stepRequest('branch-release', {
          'worktree-quarantine': quarantineEvidence ?? {},
        }),
      ),
    ).resolves.toMatchObject({ kind: 'step-complete', step: 'branch-release' });

    expect(calls).toEqual([
      'runners',
      'containers',
      'runtime-state',
      'coordinator',
      'worktree-quarantine',
      'branch-release:quarantined-detached',
    ]);
    expect(onReleasedTaskCommandController).toHaveBeenCalledWith(released);
  });

  it('keeps the coordinator step incomplete when cleanup warnings remain', async () => {
    const participant = createTaskRuntimeRemovalParticipant({
      cleanupCoordinatorTaskState: async () => [
        { kind: 'containers', message: 'coordinator child container is busy' },
      ],
      finalizeRemovedTaskState: vi.fn(),
      legacyWriterGate: new WorkspaceTaskRemovalLegacyWriterGate(),
    });

    await expect(participant.cleanupTaskRuntimeStep?.(stepRequest('coordinator'))).resolves.toEqual(
      {
        kind: 'retry-required',
        reason: 'containers: coordinator child container is busy',
      },
    );
  });

  it('fails closed if an older owner tries to invoke the former aggregate drain', async () => {
    const participant = createTaskRuntimeRemovalParticipant({
      cleanupCoordinatorTaskState: async () => [],
      finalizeRemovedTaskState: vi.fn(),
      legacyWriterGate: new WorkspaceTaskRemovalLegacyWriterGate(),
    });

    await expect(participant.drainTaskForRemoval(request())).resolves.toEqual({
      kind: 'retry-required',
      reason: 'Task runtime cleanup requires the durable cleanup-step owner',
    });
  });

  it('runs canonical-absence finalization separately from infrastructure cleanup', async () => {
    const finalizeRemovedTaskState = vi.fn();
    const participant = createTaskRuntimeRemovalParticipant({
      cleanupCoordinatorTaskState: async () => [],
      finalizeRemovedTaskState,
      legacyWriterGate: new WorkspaceTaskRemovalLegacyWriterGate(),
    });

    const finalizerRequest = { ...request(), removedWorkspaceRevision: 2 };
    await expect(participant.finalizeRemovedTaskState(finalizerRequest)).resolves.toEqual({
      kind: 'complete',
    });
    expect(finalizeRemovedTaskState).toHaveBeenCalledWith(finalizerRequest);
  });

  it('prepares and finalizes a managed terminal shell with exact durable identities', async () => {
    const calls: string[] = [];
    const prepareTaskShellRemoval = vi.fn(async () => {
      calls.push('shell-prepare');
      return { recordVersion: 4, state: 'prepared' };
    });
    const finalizeTaskShellRemoval = vi.fn(async () => {
      calls.push('shell-finalize');
    });
    const finalizeRemovedTaskState = vi.fn(async () => {
      calls.push('canonical-finalize');
    });
    const participant = createTaskRuntimeRemovalParticipant({
      cleanupCoordinatorTaskState: async () => [],
      finalizeRemovedTaskState,
      finalizeTaskShellRemoval,
      legacyWriterGate: new WorkspaceTaskRemovalLegacyWriterGate(),
      prepareTaskShellRemoval,
    });
    const managedTerminalRequest: TaskRemovalParticipantRequest = {
      ...request(),
      cleanupPlan: {
        ...request().cleanupPlan,
        launchOperationId: 'launch-operation-1',
        preparedWorkspaceRevision: 7,
        taskMode: 'terminal',
      },
    };
    const shellStep: TaskRemovalCleanupStepRequest = {
      ...managedTerminalRequest,
      completedSteps: ['runners', 'containers', 'runtime-state', 'coordinator'],
      evidence: {
        containers: { state: 'complete' },
        coordinator: { state: 'complete' },
        runners: { state: 'complete' },
        'runtime-state': { state: 'complete' },
      },
      step: 'shell-prepare',
    };

    await expect(participant.cleanupTaskRuntimeStep(shellStep)).resolves.toEqual({
      evidence: { recordVersion: 4, state: 'prepared' },
      kind: 'step-complete',
      step: 'shell-prepare',
    });
    expect(prepareTaskShellRemoval).toHaveBeenCalledWith({
      deletionOperationId: 'delete-1',
      launchOperationId: 'launch-operation-1',
      preparedWorkspaceRevision: 7,
      taskId: 'task-1',
      taskIdentityWitness: 'a'.repeat(64),
    });

    await expect(
      participant.finalizeRemovedTaskState({
        ...managedTerminalRequest,
        removedWorkspaceRevision: 9,
      }),
    ).resolves.toEqual({ kind: 'complete' });
    expect(finalizeTaskShellRemoval).toHaveBeenCalledWith({
      deletionOperationId: 'delete-1',
      launchOperationId: 'launch-operation-1',
      removedWorkspaceRevision: 9,
      taskId: 'task-1',
    });
    expect(calls).toEqual(['shell-prepare', 'shell-finalize', 'canonical-finalize']);
  });
});
