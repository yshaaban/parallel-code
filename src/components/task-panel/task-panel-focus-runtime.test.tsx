import { render } from '@solidjs/testing-library';
import { createSignal, untrack } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskPanelFocusRuntime } from './task-panel-focus-runtime';

function FocusRuntimeHarness(props: {
  getDefaultFocusedPanel?: (taskId: string) => string;
  getPanelRef?: () => HTMLDivElement | undefined;
  getPromptRef?: () => HTMLTextAreaElement | undefined;
  getStoredTaskFocusedPanel?: (taskId: string) => string | null;
  hasPromptPanel?: boolean;
  isActive?: boolean;
  taskId: () => string;
  registerFocusFn: (id: string, focusFn: () => void) => void;
  triggerFocus: (id: string) => void;
  unregisterFocusFn: (id: string) => void;
}): null {
  const registerFocusFn = untrack(() => props.registerFocusFn);
  const getDefaultFocusedPanel =
    untrack(() => props.getDefaultFocusedPanel) ?? (() => 'ai-terminal');
  const getPanelRef = untrack(() => props.getPanelRef) ?? (() => undefined);
  const getPromptRef = untrack(() => props.getPromptRef) ?? (() => undefined);
  const getStoredTaskFocusedPanel = untrack(() => props.getStoredTaskFocusedPanel) ?? (() => null);
  const hasPromptPanel = untrack(() => props.hasPromptPanel) ?? true;
  const taskId = untrack(() => props.taskId);
  const triggerFocus = untrack(() => props.triggerFocus);
  const unregisterFocusFn = untrack(() => props.unregisterFocusFn);

  createTaskPanelFocusRuntime({
    getChangedFilesRef: () => undefined,
    getDefaultFocusedPanel,
    getNotesRef: () => undefined,
    getPanelRef,
    getPlanContent: () => undefined,
    getPlanFocusRef: () => undefined,
    getPromptRef,
    getStoredTaskFocusedPanel,
    getTitleEditHandle: () => undefined,
    hasPromptPanel,
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

  it('focuses the default panel when the task has no stored focused panel', async () => {
    vi.useFakeTimers();
    const registerFocusFn = vi.fn();
    const unregisterFocusFn = vi.fn();
    const triggerFocus = vi.fn();

    render(() => (
      <FocusRuntimeHarness
        taskId={() => 'task-1'}
        registerFocusFn={registerFocusFn}
        triggerFocus={triggerFocus}
        unregisterFocusFn={unregisterFocusFn}
      />
    ));

    expect(triggerFocus).not.toHaveBeenCalledWith('task-1:ai-terminal');
    await vi.runAllTimersAsync();

    expect(triggerFocus).toHaveBeenCalledWith('task-1:ai-terminal');
  });

  it('does not register a prompt focus target when the panel has no prompt capability', () => {
    const registerFocusFn = vi.fn();
    const unregisterFocusFn = vi.fn();
    const result = render(() => (
      <FocusRuntimeHarness
        hasPromptPanel={false}
        taskId={() => 'task-terminal'}
        registerFocusFn={registerFocusFn}
        triggerFocus={() => {}}
        unregisterFocusFn={unregisterFocusFn}
      />
    ));

    expect(registerFocusFn).not.toHaveBeenCalledWith('task-terminal:prompt', expect.any(Function));

    result.unmount();
    expect(unregisterFocusFn).not.toHaveBeenCalledWith('task-terminal:prompt');
  });

  it.each([null, 'prompt'])(
    'preserves an already focused child control with stored panel %s',
    async (storedPanel) => {
      vi.useFakeTimers();
      const panel = document.createElement('div');
      const child = document.createElement('button');
      const registerFocusFn = vi.fn();
      const unregisterFocusFn = vi.fn();
      const triggerFocus = vi.fn();

      panel.append(child);
      document.body.append(panel);
      child.focus();

      try {
        render(() => (
          <FocusRuntimeHarness
            getPanelRef={() => panel}
            getStoredTaskFocusedPanel={() => storedPanel}
            taskId={() => 'task-1'}
            registerFocusFn={registerFocusFn}
            triggerFocus={triggerFocus}
            unregisterFocusFn={unregisterFocusFn}
          />
        ));

        await vi.runAllTimersAsync();

        expect(triggerFocus).not.toHaveBeenCalled();
      } finally {
        panel.remove();
      }
    },
  );

  it('prefers stored focus over the default panel', () => {
    const registerFocusFn = vi.fn();
    const unregisterFocusFn = vi.fn();
    const triggerFocus = vi.fn();

    render(() => (
      <FocusRuntimeHarness
        getDefaultFocusedPanel={() => 'ai-terminal'}
        getStoredTaskFocusedPanel={() => 'prompt'}
        taskId={() => 'task-1'}
        registerFocusFn={registerFocusFn}
        triggerFocus={triggerFocus}
        unregisterFocusFn={unregisterFocusFn}
      />
    ));

    expect(triggerFocus).toHaveBeenCalledWith('task-1:prompt');
  });
});
