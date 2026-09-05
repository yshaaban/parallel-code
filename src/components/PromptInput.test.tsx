import { fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';

const {
  localQuestionGenerationMock,
  leaseCleanupMock,
  registerActionMock,
  registerFocusFnMock,
  sendPromptMock,
  setActiveAgentMock,
  setTaskFocusedPanelMock,
  setTaskFocusedPanelStateMock,
  takeOverMock,
  unregisterActionMock,
  unregisterFocusFnMock,
} = vi.hoisted(() => ({
  localQuestionGenerationMock: vi.fn(() => undefined),
  leaseCleanupMock: vi.fn(),
  registerActionMock: vi.fn(),
  registerFocusFnMock: vi.fn(),
  sendPromptMock: vi.fn(),
  setActiveAgentMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  setTaskFocusedPanelStateMock: vi.fn(),
  takeOverMock: vi.fn().mockResolvedValue(true),
  unregisterActionMock: vi.fn(),
  unregisterFocusFnMock: vi.fn(),
}));

function resetPromptStoreMocks(): void {
  localQuestionGenerationMock.mockReset();
  localQuestionGenerationMock.mockReturnValue(undefined);
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

vi.mock('../app/task-command-lease', () => ({
  createTaskCommandLeaseSession: () => ({
    cleanup: leaseCleanupMock,
    takeOver: takeOverMock,
    touch: () => false,
  }),
}));

vi.mock('../app/task-workflows', () => ({
  sendPrompt: sendPromptMock,
}));

vi.mock('./InitialPromptDeliveryControl', () => ({
  InitialPromptDeliveryControl: (props: {
    deliveryId: string;
    onInspectTerminal?: (agentId: string) => void;
  }) => (
    <div aria-label="Initial prompt owner">
      {props.deliveryId}
      <button
        type="button"
        aria-label="Inspect canonical initial prompt terminal"
        onClick={() => props.onInspectTerminal?.('agent-canonical')}
      />
    </div>
  ),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getPeerTaskCommandControlStatus: (taskId: string, fallbackAction: string) => {
      const controller = core.store.taskCommandControllers[taskId];
      if (!controller || controller.controllerId === 'client-self') {
        return null;
      }

      const action = controller.action ?? fallbackAction;
      if (action === 'send a prompt') {
        return {
          action,
          controllerId: controller.controllerId,
          controllerKey: `${controller.controllerId}:${action}`,
          label: 'Prompt in use',
          message: 'Another browser session is currently sending prompts for this task.',
        };
      }

      return {
        action,
        controllerId: controller.controllerId,
        controllerKey: `${controller.controllerId}:${action}`,
        label: 'Read-only',
        message: `Another browser session is controlling this task to ${action}.`,
      };
    },
    getTaskFocusedPanel: (taskId: string) => core.store.focusedPanel[taskId] ?? 'prompt',
    getLocalAgentQuestionGeneration: localQuestionGenerationMock,
    registerAction: registerActionMock,
    registerFocusFn: registerFocusFnMock,
    setActiveAgent: setActiveAgentMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    setTaskFocusedPanelState: setTaskFocusedPanelStateMock,
    store: core.store,
    unregisterAction: unregisterActionMock,
    unregisterFocusFn: unregisterFocusFnMock,
  };
});

import { PromptInput } from './PromptInput';

describe('PromptInput', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetPromptStoreMocks();
    resetStoreForTest();
    setStore('focusedPanel', 'task-1', 'prompt');
    sendPromptMock.mockResolvedValue(true);
    takeOverMock.mockResolvedValue(true);
    setTaskFocusedPanelStateMock.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__');
    Reflect.deleteProperty(window, '__parallelCodeRendererRuntimeDiagnostics');
    resetRendererRuntimeDiagnostics();
    resetStoreForTest();
    vi.clearAllMocks();
  });

  it('shows a prompt-specific read-only banner when another client controls the task', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'send a prompt',
      controllerId: 'peer-client',
    });

    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);

    expect(
      await result.findByText(
        'Another browser session is currently sending prompts for this task.',
      ),
    ).toBeTruthy();
    const textarea = result.getByPlaceholderText(
      'Another browser session is controlling this task…',
    ) as HTMLTextAreaElement;

    expect(textarea.disabled).toBe(false);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.getAttribute('aria-readonly')).toBe('true');
    const takeOverButton = result.getByRole('button', { name: 'Take Over Prompt' });
    takeOverButton.click();

    expect(takeOverMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(setTaskFocusedPanelStateMock).toHaveBeenCalledWith('task-1', 'prompt');
    });
  });

  it('ignores a late prompt takeover result after cleanup', async () => {
    const takeover = createDeferredPromise<boolean>();
    takeOverMock.mockReturnValueOnce(takeover.promise);
    setStore('taskCommandControllers', 'task-1', {
      action: 'send a prompt',
      controllerId: 'peer-client',
    });

    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);

    const takeOverButton = await result.findByRole('button', { name: 'Take Over Prompt' });
    takeOverButton.click();

    expect(takeOverMock).toHaveBeenCalledTimes(1);

    result.unmount();
    takeover.resolve(true);
    await takeover.promise;
    await Promise.resolve();

    expect(setTaskFocusedPanelStateMock).not.toHaveBeenCalled();
  });

  it('collapses the prompt banner into a compact chip when dismissed', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'send a prompt',
      controllerId: 'peer-client',
    });

    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);

    const dismissButton = await result.findByRole('button', {
      name: 'Dismiss control notice',
    });
    dismissButton.click();

    expect(result.getByText('Prompt in use')).toBeTruthy();
  });

  it('keeps the prompt text when sending is skipped after control is lost', async () => {
    sendPromptMock.mockResolvedValue(false);
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByPlaceholderText(
      'Send a prompt... (Enter to send, Shift+Enter for newline)',
    ) as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      currentTarget: { value: 'Ship it' },
      target: { value: 'Ship it' },
    });
    result.getByTitle('Send prompt').click();

    await vi.waitFor(() => {
      expect(sendPromptMock).toHaveBeenCalledWith('task-1', 'agent-1', 'Ship it', {
        confirmTakeover: false,
      });
    });
    expect(textarea.value).toBe('Ship it');
    expect(
      await result.findByText('Prompt was not sent because another client controls this task.'),
    ).toBeTruthy();
  });

  it('disables and spins the send control while a send is in flight and dims the draft', async () => {
    let resolveSend: (value: boolean) => void = () => {};
    sendPromptMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByPlaceholderText(
      'Send a prompt... (Enter to send, Shift+Enter for newline)',
    ) as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      currentTarget: { value: 'Ship it' },
      target: { value: 'Ship it' },
    });
    const sendButton = result.getByTitle('Send prompt') as HTMLButtonElement;
    sendButton.click();

    expect(result.getByTitle('Sending prompt…')).toBe(sendButton);
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.getAttribute('aria-busy')).toBe('true');
    expect(sendButton.querySelector('.inline-spinner')).not.toBeNull();
    expect(textarea.style.opacity).toBe('0.6');
    expect(textarea.value).toBe('Ship it');

    resolveSend(true);
    await vi.waitFor(() => {
      expect(textarea.value).toBe('');
    });
    expect((result.getByTitle('Send prompt') as HTMLButtonElement).getAttribute('aria-busy')).toBe(
      null,
    );
    expect(textarea.style.opacity).toBe('1');
  });

  it('preserves edits made while an accepted send is in flight', async () => {
    window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
    const send = createDeferredPromise<boolean>();
    sendPromptMock.mockReturnValueOnce(send.promise);
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByRole('textbox') as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      currentTarget: { value: 'First draft' },
      target: { value: 'First draft' },
    });
    result.getByTitle('Send prompt').click();
    await vi.waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(1));

    await fireEvent.input(textarea, {
      currentTarget: { value: 'New work while sending' },
      target: { value: 'New work while sending' },
    });
    send.resolve(true);

    await vi.waitFor(() => expect(result.getByTitle('Send prompt')).toBeTruthy());
    expect(textarea.value).toBe('New work while sending');
    expect(getRendererRuntimeDiagnosticsSnapshot().promptQuestion.draftPreservedAfterSend).toBe(1);
  });

  it('keeps focus and editing during a canonical question while blocking every send affordance', async () => {
    window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
    setStore('agents', 'agent-1', {
      generation: 3,
      status: 'running',
    } as never);
    setStore('agentSupervision', 'agent-1', {
      state: 'awaiting-input',
    } as never);
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();

    await fireEvent.input(textarea, {
      currentTarget: { value: 'I can draft this answer' },
      target: { value: 'I can draft this answer' },
    });
    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    textarea.dispatchEvent(enter);

    expect(textarea.readOnly).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(enter.defaultPrevented).toBe(false);
    expect(sendPromptMock).not.toHaveBeenCalled();
    expect((result.getByTitle('Send prompt') as HTMLButtonElement).disabled).toBe(true);
    expect(
      result.getByText('Answer the question in the terminal; you can draft here while you work.'),
    ).toBeTruthy();
    expect(setTaskFocusedPanelMock).not.toHaveBeenCalled();

    const registeredSend = registerActionMock.mock.calls.find(
      ([key]) => key === 'task-1:send-prompt',
    )?.[1] as (() => void) | undefined;
    registeredSend?.();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().promptQuestion.blockedDispatchAttempts[
        'agent-question'
      ],
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().promptQuestion.canonicalLocalDisagreement
        .activeCurrent,
    ).toBe(1);

    setStore('agentSupervision', 'agent-1', 'state', 'idle-at-prompt');
    await vi.waitFor(() => {
      expect(
        getRendererRuntimeDiagnosticsSnapshot().promptQuestion.canonicalLocalDisagreement.completed,
      ).toBe(1);
    });
  });

  it('never dispatches through Enter or the registered action during composition', async () => {
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByRole('textbox') as HTMLTextAreaElement;
    await fireEvent.input(textarea, {
      currentTarget: { value: '編集中' },
      target: { value: '編集中' },
    });
    await fireEvent.compositionStart(textarea);
    const registeredSend = registerActionMock.mock.calls.find(
      ([key]) => key === 'task-1:send-prompt',
    )?.[1] as (() => Promise<void>) | undefined;
    await registeredSend?.();
    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    textarea.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(false);
    expect(sendPromptMock).not.toHaveBeenCalled();
    await fireEvent.compositionEnd(textarea);
    await registeredSend?.();
    expect(sendPromptMock).toHaveBeenCalledOnce();
  });

  it('does not expose the generic prompt sender while initial delivery is unresolved', async () => {
    const result = render(() => (
      <PromptInput taskId="task-1" agentId="agent-1" initialPromptDeliveryId="delivery-1" />
    ));

    expect((await result.findByLabelText('Initial prompt owner')).textContent).toBe('delivery-1');
    expect(result.queryByTitle('Send prompt')).toBeNull();
    expect(result.queryByPlaceholderText(/Send a prompt/iu)).toBeNull();
    expect(sendPromptMock).not.toHaveBeenCalled();

    result.getByLabelText('Inspect canonical initial prompt terminal').click();
    expect(setActiveAgentMock).toHaveBeenCalledWith('agent-canonical');
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'ai-terminal');
  });

  it('restores the draft at full strength when an in-flight send fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectSend: (error: unknown) => void = () => {};
    sendPromptMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByPlaceholderText(
      'Send a prompt... (Enter to send, Shift+Enter for newline)',
    ) as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      currentTarget: { value: 'Ship it' },
      target: { value: 'Ship it' },
    });
    result.getByTitle('Send prompt').click();
    expect(textarea.style.opacity).toBe('0.6');

    rejectSend(new Error('socket unavailable'));
    expect(await result.findByText('Prompt send failed: socket unavailable')).toBeTruthy();
    expect(textarea.value).toBe('Ship it');
    expect(textarea.style.opacity).toBe('1');
    consoleErrorSpy.mockRestore();
  });

  it('shows send failures without clearing the draft prompt and clears them on retry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sendPromptMock.mockRejectedValueOnce(new Error('socket unavailable'));
    const result = render(() => <PromptInput taskId="task-1" agentId="agent-1" />);
    const textarea = result.getByPlaceholderText(
      'Send a prompt... (Enter to send, Shift+Enter for newline)',
    ) as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      currentTarget: { value: 'Ship it' },
      target: { value: 'Ship it' },
    });
    result.getByTitle('Send prompt').click();

    expect(await result.findByText('Prompt send failed: socket unavailable')).toBeTruthy();
    expect(textarea.value).toBe('Ship it');

    await fireEvent.input(textarea, {
      currentTarget: { value: 'Ship it again' },
      target: { value: 'Ship it again' },
    });
    expect(result.queryByText('Prompt send failed: socket unavailable')).toBeNull();

    result.getByTitle('Send prompt').click();

    await vi.waitFor(() => {
      expect(sendPromptMock).toHaveBeenCalledTimes(2);
    });
    expect(result.queryByText('Prompt send failed: socket unavailable')).toBeNull();
    expect(textarea.value).toBe('');
    consoleErrorSpy.mockRestore();
  });
});
