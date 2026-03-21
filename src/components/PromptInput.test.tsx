import { fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  getAgentOutputTailMock,
  hasReadyPromptInTailMock,
  leaseCleanupMock,
  offAgentReadyMock,
  onAgentReadyMock,
  normalizeForComparisonMock,
  registerActionMock,
  registerFocusFnMock,
  sendAgentEnterMock,
  sendPromptMock,
  setTaskFocusedPanelMock,
  takeOverMock,
  unregisterActionMock,
  unregisterFocusFnMock,
} = vi.hoisted(() => ({
  getAgentOutputTailMock: vi.fn(() => ''),
  hasReadyPromptInTailMock: vi.fn(() => false),
  leaseCleanupMock: vi.fn(),
  offAgentReadyMock: vi.fn(),
  onAgentReadyMock: vi.fn(),
  normalizeForComparisonMock: vi.fn((value: string) => value),
  registerActionMock: vi.fn(),
  registerFocusFnMock: vi.fn(),
  sendAgentEnterMock: vi.fn(),
  sendPromptMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  takeOverMock: vi.fn().mockResolvedValue(true),
  unregisterActionMock: vi.fn(),
  unregisterFocusFnMock: vi.fn(),
}));

function resetPromptStoreMocks(): void {
  getAgentOutputTailMock.mockReset();
  getAgentOutputTailMock.mockReturnValue('');
  hasReadyPromptInTailMock.mockReset();
  hasReadyPromptInTailMock.mockReturnValue(false);
  normalizeForComparisonMock.mockReset();
  normalizeForComparisonMock.mockImplementation((value: string) => value);
  onAgentReadyMock.mockReset();
  offAgentReadyMock.mockReset();
}

vi.mock('../app/task-command-lease', () => ({
  createTaskCommandLeaseSession: () => ({
    cleanup: leaseCleanupMock,
    takeOver: takeOverMock,
    touch: () => false,
  }),
}));

vi.mock('../app/task-workflows', () => ({
  sendAgentEnter: sendAgentEnterMock,
  sendPrompt: sendPromptMock,
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getAgentOutputTail: getAgentOutputTailMock,
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
    hasReadyPromptInTail: hasReadyPromptInTailMock,
    isAgentAskingQuestion: () => false,
    isAutoTrustSettling: () => false,
    isTrustQuestionAutoHandled: () => false,
    looksLikeQuestion: () => false,
    normalizeForComparison: normalizeForComparisonMock,
    offAgentReady: offAgentReadyMock,
    onAgentReady: onAgentReadyMock,
    registerAction: registerActionMock,
    registerFocusFn: registerFocusFnMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    stripAnsi: (value: string) => value,
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
    sendAgentEnterMock.mockResolvedValue(true);
    takeOverMock.mockResolvedValue(true);
  });

  afterEach(() => {
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

    expect(textarea.disabled).toBe(true);
    const takeOverButton = result.getByRole('button', { name: 'Take Over Prompt' });
    takeOverButton.click();

    expect(takeOverMock).toHaveBeenCalledTimes(1);
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
  });

  it('does not add extra retry delay after auto-send verification times out', async () => {
    vi.useFakeTimers();
    getAgentOutputTailMock.mockReturnValue('❯');
    hasReadyPromptInTailMock.mockReturnValue(true);
    const onSendMock = vi.fn();

    render(() => (
      <PromptInput agentId="agent-1" initialPrompt="Ship it" onSend={onSendMock} taskId="task-1" />
    ));

    expect(onAgentReadyMock).toHaveBeenCalledTimes(1);
    const onReady = onAgentReadyMock.mock.calls[0]?.[1];
    expect(onReady).toBeTypeOf('function');

    onReady?.();

    await vi.advanceTimersByTimeAsync(7_999);
    expect(onSendMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onSendMock).toHaveBeenCalledWith('Ship it');
  });
});
