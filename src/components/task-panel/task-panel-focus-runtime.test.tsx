import { render } from '@solidjs/testing-library';
import { createSignal, untrack } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { createTaskPanelFocusRuntime } from './task-panel-focus-runtime';

function FocusRuntimeHarness(props: {
  isActive?: boolean;
  taskId: () => string;
  registerFocusFn: (id: string, focusFn: () => void) => void;
  triggerFocus: (id: string) => void;
  unregisterFocusFn: (id: string) => void;
}): null {
  const registerFocusFn = untrack(() => props.registerFocusFn);
  const taskId = untrack(() => props.taskId);
  const triggerFocus = untrack(() => props.triggerFocus);
  const unregisterFocusFn = untrack(() => props.unregisterFocusFn);

  createTaskPanelFocusRuntime({
    getChangedFilesRef: () => undefined,
    getNotesRef: () => undefined,
    getPanelRef: () => undefined,
    getPlanContent: () => undefined,
    getPlanFocusRef: () => undefined,
    getPromptRef: () => undefined,
    getStoredTaskFocusedPanel: () => null,
    getTitleEditHandle: () => undefined,
    isActive: () => props.isActive ?? true,
    notesTab: () => 'notes',
    registerFocusFn,
    showPlans: () => false,
    taskId,
    triggerFocus,
    unregisterFocusFn,
  });

  return null;
}

describe('task-panel focus runtime', () => {
  it('unregisters the same focus target ids it registered even if the accessor changes later', () => {
    const registerFocusFn = vi.fn();
    const unregisterFocusFn = vi.fn();
    const triggerFocus = vi.fn();
    const [taskId, setTaskId] = createSignal('task-1');

    const result = render(() => (
      <FocusRuntimeHarness
        taskId={taskId}
        registerFocusFn={registerFocusFn}
        triggerFocus={triggerFocus}
        unregisterFocusFn={unregisterFocusFn}
      />
    ));

    setTaskId('task-2');
    result.unmount();

    expect(registerFocusFn).toHaveBeenCalledWith('task-1:title', expect.any(Function));
    expect(registerFocusFn).toHaveBeenCalledWith('task-1:changed-files', expect.any(Function));
    expect(registerFocusFn).toHaveBeenCalledWith('task-1:prompt', expect.any(Function));
    expect(unregisterFocusFn).toHaveBeenCalledWith('task-1:title');
    expect(unregisterFocusFn).toHaveBeenCalledWith('task-1:changed-files');
    expect(unregisterFocusFn).toHaveBeenCalledWith('task-1:prompt');
  });
});
