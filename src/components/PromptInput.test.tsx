import { render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  leaseCleanupMock,
  registerActionMock,
  registerFocusFnMock,
  sendAgentEnterMock,
  sendPromptMock,
  setTaskFocusedPanelMock,
  takeOverMock,
  unregisterActionMock,
  unregisterFocusFnMock,
} = vi.hoisted(() => ({
  leaseCleanupMock: vi.fn(),
  registerActionMock: vi.fn(),
  registerFocusFnMock: vi.fn(),
  sendAgentEnterMock: vi.fn(),
  sendPromptMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  takeOverMock: vi.fn().mockResolvedValue(true),
  unregisterActionMock: vi.fn(),
  unregisterFocusFnMock: vi.fn(),
}));

vi.mock('../app/task-command-lease', () => ({
  createTaskCommandLeaseSession: () => ({
    cleanup: leaseCleanupMock,
    takeOver: takeOverMock,
  }),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getAgentOutputTail: () => '',
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
    hasReadyPromptInTail: () => false,
    isAgentAskingQuestion: () => false,
    isAutoTrustSettling: () => false,
    isTrustQuestionAutoHandled: () => false,
    looksLikeQuestion: () => false,
    normalizeForComparison: (value: string) => value,
    offAgentReady: vi.fn(),
    onAgentReady: vi.fn(),
    registerAction: registerActionMock,
    registerFocusFn: registerFocusFnMock,
    sendAgentEnter: sendAgentEnterMock,
    sendPrompt: sendPromptMock,
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
});
