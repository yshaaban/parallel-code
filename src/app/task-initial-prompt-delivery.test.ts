import { describe, expect, it, vi } from 'vitest';

import {
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  type ManualInitialPromptSendOperationSnapshot,
  type ReviseTaskInitialPromptDraftRequest,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDraftSnapshot,
} from '../domain/task-initial-prompt-delivery.js';
import {
  createManualInitialPromptSendRequest,
  createTaskInitialPromptDraftController,
  getTaskInitialPromptPresentation,
  isVisibleInitialPromptDraftAcknowledged,
  reduceTaskInitialPromptDeliveryProjection,
} from './task-initial-prompt-delivery.js';

function draft(
  overrides: Partial<TaskInitialPromptDraftSnapshot> = {},
): TaskInitialPromptDraftSnapshot {
  const text = overrides.text ?? 'Ship it';
  return {
    editRevision: 0,
    fingerprint: deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text,
    }),
    mode: 'automatic',
    text,
    workspaceRevision: 1,
    ...overrides,
  };
}

function projection(
  overrides: Partial<TaskInitialPromptDeliveryProjection> = {},
): TaskInitialPromptDeliveryProjection {
  return {
    current: {
      catalogVersion: 1,
      serverInstanceId: 'server-a',
      taskClosing: false,
      taskState: 'present',
    },
    currentDraft: draft(),
    delivery: {
      agentId: 'agent-1',
      attempts: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      status: 'waiting-ready',
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: 1,
    },
    ...overrides,
  };
}

describe('initial prompt renderer projection', () => {
  it('orders operation and catalog cursors independently', () => {
    const current = projection({
      current: {
        catalogVersion: 8,
        serverInstanceId: 'server-a',
        taskClosing: true,
        taskState: 'present',
      },
      delivery: { ...projection().delivery, version: 4 },
    });
    const reduced = reduceTaskInitialPromptDeliveryProjection(
      current,
      projection({
        current: {
          catalogVersion: 2,
          serverInstanceId: 'server-a',
          taskClosing: false,
          taskState: 'present',
        },
        delivery: { ...projection().delivery, status: 'manual-required', version: 5 },
      }),
    );
    expect(reduced.delivery).toMatchObject({ status: 'manual-required', version: 5 });
    expect(reduced.current).toMatchObject({ catalogVersion: 8, taskClosing: true });

    expect(
      reduceTaskInitialPromptDeliveryProjection(
        reduced,
        projection({
          current: {
            catalogVersion: 0,
            serverInstanceId: 'server-b',
            taskClosing: false,
            taskState: 'present',
          },
        }),
      ).current,
    ).toMatchObject({ catalogVersion: 0, serverInstanceId: 'server-b' });
  });

  it('does not clear or resurrect a draft from a stale nullable projection', () => {
    const current = projection({
      currentDraft: draft({ workspaceRevision: 7 }),
      delivery: { ...projection().delivery, version: 4 },
    });
    const staleClear = projection({
      currentDraft: null,
      delivery: { ...projection().delivery, version: 3 },
    });
    expect(reduceTaskInitialPromptDeliveryProjection(current, staleClear).currentDraft).toEqual(
      current.currentDraft,
    );

    const cleared = reduceTaskInitialPromptDeliveryProjection(
      current,
      projection({
        currentDraft: null,
        delivery: { ...projection().delivery, status: 'delivered', version: 5 },
      }),
    );
    expect(cleared.currentDraft).toBeNull();
    expect(
      reduceTaskInitialPromptDeliveryProjection(
        cleared,
        projection({
          currentDraft: draft({ workspaceRevision: 6 }),
          delivery: { ...projection().delivery, version: 4 },
        }),
      ).currentDraft,
    ).toBeNull();
  });

  it('suppresses every dispatch action for closing, removed, and not-visible tasks', () => {
    for (const current of [
      {
        catalogVersion: 2,
        serverInstanceId: 's',
        taskClosing: true,
        taskState: 'present' as const,
      },
      {
        catalogVersion: 2,
        serverInstanceId: 's',
        taskClosing: false,
        taskState: 'removed' as const,
      },
      {
        catalogVersion: 2,
        serverInstanceId: 's',
        taskClosing: false,
        taskState: 'not-visible' as const,
      },
    ]) {
      expect(getTaskInitialPromptPresentation(projection({ current })).actionAllowed).toBe(false);
    }
  });

  it('derives one exact manual operation from the acknowledged snapshot', () => {
    const currentDraft = draft({ editRevision: 3, mode: 'manual-only' });
    const first = createManualInitialPromptSendRequest({
      agentId: 'agent-1',
      confirmPossiblePriorAutomaticWrite: false,
      draft: currentDraft,
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 7,
      taskId: 'task-1',
    });
    const second = createManualInitialPromptSendRequest({
      agentId: 'agent-1',
      confirmPossiblePriorAutomaticWrite: true,
      draft: currentDraft,
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 7,
      taskId: 'task-1',
    });
    expect(first.manualSendOperationId).toBe(second.manualSendOperationId);
    expect(first).not.toHaveProperty('text');
  });

  it('starts a fresh send when a newer acknowledged edit supersedes a failed operation', () => {
    const failedDraft = draft();
    const currentDraft = draft({
      editRevision: 1,
      mode: 'manual-only',
      text: 'Ship the revised prompt',
      workspaceRevision: 2,
    });
    const failedOperation: ManualInitialPromptSendOperationSnapshot = {
      acknowledgedDraftFingerprint: failedDraft.fingerprint,
      acknowledgedEditRevision: failedDraft.editRevision,
      agentId: 'agent-1',
      attempt: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 7,
      manualSendOperationId: deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: failedDraft.fingerprint,
        acknowledgedEditRevision: failedDraft.editRevision,
        deliveryId: 'delivery-1',
      }),
      phase: 'failed-before-write',
      possiblePriorAutomaticWrite: false,
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:01.000Z',
      version: 2,
    };

    expect(
      getTaskInitialPromptPresentation(
        projection({ currentDraft: failedDraft, manualSendOperation: failedOperation }),
      ).action,
    ).toEqual({ failedAttempt: 1, kind: 'retry-proven-not-sent' });
    expect(
      getTaskInitialPromptPresentation(
        projection({ currentDraft, manualSendOperation: failedOperation }),
      ).action,
    ).toEqual({ kind: 'send' });
  });

  it('coalesces rapid edits into one in-flight and one trailing latest snapshot', async () => {
    const requests: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const submit = vi.fn(async (request) => {
      requests.push(request.revisedText);
      if (requests.length === 1) await firstGate;
      const next = draft({
        editRevision: request.expectedEditRevision + 1,
        mode: 'manual-only',
        text: request.revisedText,
        workspaceRevision: request.expectedEditRevision + 2,
      });
      return { current: next, kind: 'saved-manual-draft' as const };
    });
    let operation = 0;
    const controller = createTaskInitialPromptDraftController({
      createEditOperationId: () => `edit-${++operation}`,
      deliveryId: 'delivery-1',
      initialDraft: draft(),
      submit,
      taskId: 'task-1',
    });
    controller.setVisibleText('A');
    const flushing = controller.flush();
    controller.setVisibleText('B');
    controller.setVisibleText('C');
    releaseFirst();
    await flushing;
    expect(requests).toEqual(['A', 'C']);
    expect(controller.getSnapshot()).toMatchObject({
      acknowledged: { text: 'C' },
      inFlight: false,
      trailingEditQueued: false,
    });
  });

  it('replays a lost-response edit exactly before saving the latest trailing text', async () => {
    const requests: ReviseTaskInitialPromptDraftRequest[] = [];
    const committed = draft({
      editRevision: 1,
      mode: 'manual-only',
      text: 'Committed before disconnect',
      workspaceRevision: 2,
    });
    const trailing = draft({
      editRevision: 2,
      mode: 'manual-only',
      text: 'Latest trailing edit',
      workspaceRevision: 3,
    });
    let rejectLostResponse!: (error: Error) => void;
    const lostResponse = new Promise<never>((_resolve, reject) => {
      rejectLostResponse = reject;
    });
    const submit = vi.fn(async (request) => {
      requests.push(request);
      if (requests.length === 1) return lostResponse;
      if (requests.length === 2) return { current: committed, kind: 'replayed' as const };
      return { current: trailing, kind: 'saved-manual-draft' as const };
    });
    let operation = 0;
    const controller = createTaskInitialPromptDraftController({
      createEditOperationId: () => `edit-${++operation}`,
      deliveryId: 'delivery-1',
      initialDraft: draft(),
      submit,
      taskId: 'task-1',
    });

    controller.setVisibleText(committed.text);
    const firstAttempt = controller.flush();
    controller.setVisibleText('Intermediate edit');
    controller.setVisibleText(trailing.text);
    rejectLostResponse(new Error('response lost after commit'));
    await firstAttempt;
    await controller.flush();

    expect(requests).toHaveLength(3);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[2]).toMatchObject({
      editOperationId: 'edit-2',
      expectedDraftFingerprint: committed.fingerprint,
      expectedEditRevision: committed.editRevision,
      revisedText: trailing.text,
    });
    expect(controller.getSnapshot()).toMatchObject({
      acknowledged: trailing,
      inFlight: false,
      trailingEditQueued: false,
      visibleText: trailing.text,
    });
  });

  it('retries the exact lost-response request when no later edit exists', async () => {
    const requests: ReviseTaskInitialPromptDraftRequest[] = [];
    const committed = draft({
      editRevision: 1,
      mode: 'manual-only',
      text: 'Committed before disconnect',
      workspaceRevision: 2,
    });
    const submit = vi.fn(async (request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error('response lost after commit');
      return { current: committed, kind: 'replayed' as const };
    });
    const controller = createTaskInitialPromptDraftController({
      createEditOperationId: () => 'edit-stable',
      deliveryId: 'delivery-1',
      initialDraft: draft(),
      submit,
      taskId: 'task-1',
    });

    controller.setVisibleText(committed.text);
    await controller.flush();
    await controller.flush();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(controller.getSnapshot()).toMatchObject({
      acknowledged: committed,
      saveError: null,
      trailingEditQueued: false,
      visibleText: committed.text,
    });
  });

  it('stops auto-flush on conflict and retains local text until an explicit choice', async () => {
    const remote = draft({ editRevision: 1, text: 'Remote', workspaceRevision: 2 });
    const submit = vi.fn(async () => ({ current: remote, kind: 'draft-conflict' as const }));
    const controller = createTaskInitialPromptDraftController({
      createEditOperationId: () => 'edit-1',
      deliveryId: 'delivery-1',
      initialDraft: draft(),
      submit,
      taskId: 'task-1',
    });
    controller.setVisibleText('Mine');
    await controller.flush();
    expect(controller.getSnapshot()).toMatchObject({
      conflict: { text: 'Remote' },
      visibleText: 'Mine',
    });
    controller.useCurrent();
    expect(controller.getSnapshot()).toMatchObject({ conflict: null, visibleText: 'Remote' });
  });

  it('does not erase an unacknowledged local edit when a status event refreshes the same draft', () => {
    const controller = createTaskInitialPromptDraftController({
      createEditOperationId: () => 'edit-1',
      deliveryId: 'delivery-1',
      initialDraft: draft(),
      submit: vi.fn(),
      taskId: 'task-1',
    });
    controller.setVisibleText('My unsaved local revision');
    controller.acknowledge(draft({ workspaceRevision: 2 }));

    expect(controller.getSnapshot()).toMatchObject({
      acknowledged: { workspaceRevision: 2 },
      visibleText: 'My unsaved local revision',
    });
  });

  it('blocks Send until visible text matches the acknowledged fingerprint', () => {
    const acknowledged = draft();
    expect(
      isVisibleInitialPromptDraftAcknowledged({
        agentId: 'agent-1',
        draft: acknowledged,
        taskId: 'task-1',
        visibleText: 'Ship it',
      }),
    ).toBe(true);
    expect(
      isVisibleInitialPromptDraftAcknowledged({
        agentId: 'agent-1',
        draft: acknowledged,
        taskId: 'task-1',
        visibleText: 'Ship it now',
      }),
    ).toBe(false);
  });
});
