import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { createTestTask } from '../../test/store-test-helpers';
import type { PendingAction } from '../../store/types';
import { createTaskPanelDialogState } from './task-panel-dialog-state';

describe('createTaskPanelDialogState', () => {
  it('blocks merge and push dialogs for non-git tasks', async () => {
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
        task: () =>
          createTestTask({
            branchName: '',
            projectMode: 'non-git',
            worktreePath: '/tmp/folder',
          }),
      });
      dispose = rootDispose;
    });

    await Promise.resolve();

    dialogState.openMergeConfirm();
    dialogState.openPushConfirm();
    expect(dialogState.showMergeConfirm()).toBe(false);
    expect(dialogState.showPushConfirm()).toBe(false);

    setPendingAction({ taskId: 'task-1', type: 'merge' });
    await Promise.resolve();
    expect(clearPendingAction).toHaveBeenCalledTimes(1);
    expect(dialogState.showMergeConfirm()).toBe(false);

    setPendingAction({ taskId: 'task-1', type: 'push' });
    await Promise.resolve();
    expect(clearPendingAction).toHaveBeenCalledTimes(2);
    expect(dialogState.showPushConfirm()).toBe(false);

    dispose();
  });
});
