import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isIssuedTaskMergeOperation,
  isMergeProgressSnapshot,
  isTaskMergeOperationAccess,
  isTaskMergeOperationSnapshot,
  isTaskMergeResultEnvelope,
  isTaskMergeSemanticRequest,
  type TaskMergeResultEnvelope,
} from '../../src/domain/task-merge.js';
import {
  isTaskRemovalMutationResult,
  type TaskRemovalMutationResult,
} from '../../src/domain/task-removal-owner.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('task merge transport contract', () => {
  it('round-trips server-issued access and the public outcome/current envelope', () => {
    const issued = roundTrip({
      firstAdmissionExpiresAt: 2_000,
      issuedAt: 1_000,
      operationCapability: 'a'.repeat(43),
      operationId: 'merge-operation-1',
    });
    const envelope: TaskMergeResultEnvelope<TaskRemovalMutationResult> = roundTrip({
      currentProgress: {
        dateKey: '2026-08-04',
        linesAdded: 7,
        linesRemoved: 2,
        schemaVersion: 1,
        tasksToday: 1,
        updatedAt: '2026-08-04T00:00:00.000Z',
        version: 2,
      },
      currentRemoval: {
        deletionOperationId: 'merge-operation-1',
        pendingFinalizers: ['task-runtime'],
        removed: true,
        removalState: 'finalizer-repair-pending',
        taskId: 'task-1',
      },
      originalOutcome: {
        cleanupRequested: true,
        counted: true,
        gitMerged: true,
        linesAdded: 7,
        linesRemoved: 2,
        operationId: 'merge-operation-1',
        phase: 'completed',
        progressVersionAtOutcome: 2,
        taskId: 'task-1',
        taskReleased: true,
        version: 5,
      },
      replayed: false,
    });

    expect(isIssuedTaskMergeOperation(issued)).toBe(true);
    expect(isMergeProgressSnapshot(envelope.currentProgress)).toBe(true);
    expect(isTaskRemovalMutationResult(envelope.currentRemoval)).toBe(true);
    expect(isTaskMergeOperationSnapshot(envelope.originalOutcome)).toBe(true);
  });

  it('rejects private planning fields, extra access fields, and UTF-8 oversized messages', () => {
    const access = {
      operationCapability: 'a'.repeat(43),
      operationId: 'merge-operation-1',
    };
    const semanticRequest = {
      cleanup: true,
      squash: false,
      taskId: 'task-1',
    };

    expect(isTaskMergeOperationAccess(access)).toBe(true);
    expect(isTaskMergeOperationAccess({ ...access, projectRoot: '/forged' })).toBe(false);
    expect(isTaskMergeSemanticRequest(semanticRequest)).toBe(true);
    expect(isTaskMergeSemanticRequest({ ...semanticRequest, message: 'bad\u0000message' })).toBe(
      false,
    );
    expect(
      isTaskMergeSemanticRequest({
        ...semanticRequest,
        branchName: 'forged',
        worktreePath: '/forged',
      }),
    ).toBe(false);
    expect(isTaskMergeSemanticRequest({ ...semanticRequest, message: '🚀'.repeat(20_000) })).toBe(
      false,
    );
  });

  it('rejects private or unknown fields at every public result boundary', () => {
    const progress = {
      dateKey: '2026-08-04',
      linesAdded: 7,
      linesRemoved: 2,
      schemaVersion: 1 as const,
      tasksToday: 1,
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: 2,
    };
    const outcome = {
      cleanupRequested: true,
      counted: true,
      gitMerged: true,
      linesAdded: 7,
      linesRemoved: 2,
      operationId: 'merge-operation-1',
      phase: 'completed' as const,
      progressVersionAtOutcome: 2,
      taskId: 'task-1',
      taskReleased: true,
      version: 5,
    };
    const removal: TaskRemovalMutationResult = {
      deletionOperationId: 'merge-operation-1',
      removed: true,
      removalState: 'complete',
      taskId: 'task-1',
    };

    expect(isMergeProgressSnapshot({ ...progress, privateGeneration: 3 })).toBe(false);
    expect(isTaskMergeOperationSnapshot({ ...outcome, targetFingerprint: 'private' })).toBe(false);
    expect(
      isTaskRemovalMutationResult({ ...removal, cleanupPlan: { projectRoot: '/private' } }),
    ).toBe(false);
    expect(
      isTaskMergeResultEnvelope(
        {
          currentProgress: progress,
          currentRemoval: removal,
          originalOutcome: outcome,
          privateEvidence: true,
          replayed: false,
        },
        isTaskRemovalMutationResult,
      ),
    ).toBe(false);
  });

  it('keeps the active renderer on issue/start/status without local merge completion writers', () => {
    const lifecycle = source('src/app/task-lifecycle-workflows.ts');
    const mergeStart = lifecycle.indexOf('export async function mergeTask(');
    const mergeEnd = lifecycle.indexOf('export async function pushTask(', mergeStart);
    const mergeSource = lifecycle.slice(mergeStart, mergeEnd);

    expect(mergeSource).toContain('IPC.IssueTaskMergeOperation');
    expect(mergeSource).toContain('IPC.StartTaskMergeOperation');
    expect(mergeSource).toContain('IPC.GetTaskMergeOperationStatus');
    expect(mergeSource).not.toContain('IPC.MergeTask');
    expect(mergeSource).not.toContain('recordMergedLines');
    expect(mergeSource).not.toContain('recordMergedTaskToday');
    expect(mergeSource).not.toContain('IPC.CleanupTaskRuntime');

    const completionProjection = source('src/store/completion.ts');
    expect(completionProjection).not.toContain('setStore');
    expect(completionProjection).not.toContain('enqueueWorkspaceFieldEdit');
    expect(completionProjection).not.toContain('recordMerged');

    const preload = source('electron/preload.cjs');
    for (const channel of [
      'issue_task_merge_operation',
      'start_task_merge_operation',
      'get_task_merge_operation_status',
    ]) {
      expect(preload).toContain(channel);
    }
  });
});
