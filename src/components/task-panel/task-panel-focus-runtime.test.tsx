import { render } from '@solidjs/testing-library';
import { createSignal, untrack } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskPanelFocusRuntime } from './task-panel-focus-runtime';

function FocusRuntimeHarness(props: {
  getPanelRef?: () => HTMLDivElement | undefined;
  getPromptRef?: () => HTMLTextAreaElement | undefined;
  getStoredTaskFocusedPanel?: (taskId: string) => string | null;
  isActive?: boolean;
  taskId: () => string;
  registerFocusFn: (id: string, focusFn: () => void) => void;
  triggerFocus: (id: string) => void;
  unregisterFocusFn: (id: string) => void;
}): null {
  const registerFocusFn = untrack(() => props.registerFocusFn);
  const getPanelRef = untrack(() => props.getPanelRef) ?? (() => undefined);
  const getPromptRef = untrack(() => props.getPromptRef) ?? (() => undefined);
  const getStoredTaskFocusedPanel = untrack(() => props.getStoredTaskFocusedPanel) ?? (() => null);
  const taskId = untrack(() => props.taskId);
  const triggerFocus = untrack(() => props.triggerFocus);
  const unregisterFocusFn = untrack(() => props.unregisterFocusFn);

  createTaskPanelFocusRuntime({
    getChangedFilesRef: () => undefined,
    getNotesRef: () => undefined,
    getPanelRef,
    getPlanContent: () => undefined,
    getPlanFocusRef: () => undefined,
    getPromptRef,
    getStoredTaskFocusedPanel,
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('cancels delayed default prompt focus when the task becomes inactive', async () => {
    vi.useFakeTimers();
    const registerFocusFn = vi.fn();
    const unregisterFocusFn = vi.fn();
    const triggerFocus = vi.fn();
    const promptFocus = vi.fn();
    const [isActive, setIsActive] = createSignal(true);

    render(() => (
      <FocusRuntimeHarness
        getPromptRef={() => ({ focus: promptFocus }) as unknown as HTMLTextAreaElement}
        isActive={isActive()}
        taskId={() => 'task-1'}
        registerFocusFn={registerFocusFn}
        triggerFocus={triggerFocus}
        unregisterFocusFn={unregisterFocusFn}
      />
    ));

    setIsActive(false);
    await vi.runAllTimersAsync();

    expect(promptFocus).not.toHaveBeenCalled();
  });
});
