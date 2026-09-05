import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestTask } from '../../test/store-test-helpers';
import type { PendingAction } from '../../store/types';

const { decisionRef, notifyTaskGitActionDenialMock } = vi.hoisted(() => ({
  decisionRef: {
    current: {
      allowed: true,
    } as
      | { allowed: true }
      | { allowed: false; message: string; reason: 'non_git_task' | 'task_collapsed' },
  },
  notifyTaskGitActionDenialMock: vi.fn(),
}));

vi.mock('../../app/task-git-action-capability', () => ({
  getCurrentTaskGitActionDecision: vi.fn(() => decisionRef.current),
  notifyTaskGitActionDenial: notifyTaskGitActionDenialMock,
}));

import { createTaskPanelDialogState } from './task-panel-dialog-state';

function createHarness() {
  let dispose!: () => void;
  let setPendingAction!: (action: PendingAction | null) => void;
  let dialogState!: ReturnType<typeof createTaskPanelDialogState>;
  const clearPendingAction = vi.fn(() => setPendingAction(null));

  createRoot((rootDispose) => {
    const [pendingAction, setInnerPendingAction] = createSignal<PendingAction | null>(null);
    setPendingAction = setInnerPendingAction;
    dialogState = createTaskPanelDialogState({
      clearPendingAction,
      pendingAction,
      showNotification: vi.fn(),
      task: () => createTestTask(),
    });
    dispose = rootDispose;
  });

  return { clearPendingAction, dialogState, dispose, setPendingAction };
}

describe('createTaskPanelDialogState', () => {
  beforeEach(() => {
    decisionRef.current = { allowed: true };
    notifyTaskGitActionDenialMock.mockReset();
  });

  it.each(['merge', 'push'] as const)(
    'opens an already-admitted %s action after current-state revalidation',
    async (type) => {
      const harness = createHarness();

      harness.setPendingAction({ taskId: 'task-1', type });
      await Promise.resolve();

      expect(harness.clearPendingAction).toHaveBeenCalledOnce();
      expect(
        type === 'merge'
          ? harness.dialogState.showMergeConfirm()
          : harness.dialogState.showPushConfirm(),
      ).toBe(true);
      expect(notifyTaskGitActionDenialMock).not.toHaveBeenCalled();
      harness.dispose();
    },
  );

  it('rejects task churn before opening and reports the shared capability reason once', async () => {
    const harness = createHarness();
    decisionRef.current = {
      allowed: false,
      message: 'Restore this task before merging it.',
      reason: 'task_collapsed',
    };

    harness.setPendingAction({ taskId: 'task-1', type: 'merge' });
    await Promise.resolve();

    expect(harness.clearPendingAction).toHaveBeenCalledOnce();
    expect(harness.dialogState.showMergeConfirm()).toBe(false);
    expect(notifyTaskGitActionDenialMock).toHaveBeenCalledOnce();
    expect(notifyTaskGitActionDenialMock).toHaveBeenCalledWith(decisionRef.current);
    harness.dispose();
  });
});
