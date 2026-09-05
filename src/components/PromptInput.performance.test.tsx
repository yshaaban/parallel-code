import { render } from '@solidjs/testing-library';
import { batch } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptInputFacts } from '../app/prompt-input-policy';
import { setStore } from '../store/core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { policyEvaluationMock } = vi.hoisted(() => ({
  policyEvaluationMock: vi.fn<(facts: PromptInputFacts) => void>(),
}));

vi.mock('../app/prompt-input-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/prompt-input-policy')>();
  return {
    ...actual,
    getPromptInputPolicy: (facts: PromptInputFacts) => {
      policyEvaluationMock(facts);
      return actual.getPromptInputPolicy(facts);
    },
  };
});

vi.mock('../app/task-command-lease', () => ({
  createTaskCommandLeaseSession: () => ({
    cleanup: vi.fn(),
    takeOver: vi.fn().mockResolvedValue(true),
    touch: vi.fn(() => false),
  }),
}));

vi.mock('../app/task-workflows', () => ({
  sendPrompt: vi.fn().mockResolvedValue(true),
}));

vi.mock('../app/coordinator', () => ({
  nextCoordinatorActivityHintSeq: vi.fn(() => 1),
  sendCoordinatorActivityHint: vi.fn().mockResolvedValue(undefined),
}));

import { PromptInput } from './PromptInput';

function setSupervisionState(
  state: 'awaiting-input' | 'idle-at-prompt',
  supervisionVersion: number,
): void {
  batch(() => {
    setStore('agentSupervision', 'agent-1', 'state', state);
    setStore('agentSupervision', 'agent-1', 'supervisionVersion', supervisionVersion);
    setStore('agentSupervision', 'agent-1', 'updatedAt', supervisionVersion);
  });
}

describe('PromptInput transition performance', () => {
  beforeEach(() => {
    resetStoreForTest();
    policyEvaluationMock.mockClear();
    setStore('tasks', 'task-1', createTestTask({ agentIds: ['agent-1'] }));
    setStore('agents', 'agent-1', createTestAgent({ generation: 7 }));
    setStore('focusedPanel', 'task-1', 'prompt');
    setStore('agentSupervision', 'agent-1', {
      agentId: 'agent-1',
      attentionReason: null,
      generation: 7,
      isShell: false,
      lastOutputAt: 0,
      preview: 'fixture>',
      state: 'idle-at-prompt',
      supervisionVersion: 1,
      taskId: 'task-1',
      updatedAt: 1,
    });
  });

  afterEach(() => {
    resetStoreForTest();
    vi.restoreAllMocks();
  });

  it('performs one policy evaluation and no focus, timer, or listener work per transition', () => {
    const result = render(() => <PromptInput agentId="agent-1" taskId="task-1" />);
    const textarea = result.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const documentListenerSpy = vi.spyOn(document, 'addEventListener');
    const windowListenerSpy = vi.spyOn(window, 'addEventListener');
    policyEvaluationMock.mockClear();

    const transitions = [
      { state: 'awaiting-input', version: 2 },
      { state: 'idle-at-prompt', version: 3 },
      { state: 'awaiting-input', version: 4 },
      { state: 'idle-at-prompt', version: 5 },
    ] as const;

    for (const transition of transitions) {
      setSupervisionState(transition.state, transition.version);
      expect(document.activeElement).toBe(textarea);
    }

    const policyEvaluationCount = policyEvaluationMock.mock.calls.length;
    const focusCallCount = focusSpy.mock.calls.length;
    const timerCallCount = timeoutSpy.mock.calls.length + intervalSpy.mock.calls.length;
    const listenerCallCount =
      documentListenerSpy.mock.calls.length + windowListenerSpy.mock.calls.length;

    process.stdout.write(
      `${[
        'prompt-input-transitions',
        `samples=${transitions.length}`,
        `policyEvaluations=${policyEvaluationCount}`,
        `focusCalls=${focusCallCount}`,
        `timerCalls=${timerCallCount}`,
        `listenerCalls=${listenerCallCount}`,
      ].join(' ')}\n`,
    );

    expect(policyEvaluationCount).toBe(transitions.length);
    expect(focusCallCount).toBe(0);
    expect(timerCallCount).toBe(0);
    expect(listenerCallCount).toBe(0);
  });
});
