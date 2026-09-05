import { describe, expect, it } from 'vitest';

import {
  getPromptCanonicalAgentState,
  getPromptInputPolicy,
  type PromptCanonicalAgentState,
  type PromptInputFacts,
} from './prompt-input-policy';

const CANONICAL_STATES: PromptCanonicalAgentState[] = [
  'starting',
  'working',
  'ready',
  'awaiting-input',
  'exited',
];

function readyFacts(overrides: Partial<PromptInputFacts> = {}): PromptInputFacts {
  return {
    canonicalAgentState: 'ready',
    canonicalGeneration: 7,
    composing: false,
    control: 'local',
    hasText: true,
    sendInFlight: false,
    ...overrides,
  };
}

describe('prompt input policy', () => {
  it('ignores canonical supervision snapshots from another agent generation', () => {
    expect(
      getPromptCanonicalAgentState('awaiting-input', 'running', {
        canonicalGeneration: 8,
        supervisionGeneration: 7,
      }),
    ).toBe('starting');
    expect(
      getPromptCanonicalAgentState('awaiting-input', 'running', {
        canonicalGeneration: 8,
        supervisionGeneration: 8,
      }),
    ).toBe('awaiting-input');
  });

  it('allows a nonempty locally controlled draft to send in every non-question state', () => {
    for (const canonicalAgentState of CANONICAL_STATES.filter(
      (state) => state !== 'awaiting-input',
    )) {
      expect(getPromptInputPolicy(readyFacts({ canonicalAgentState }))).toEqual({
        dispatchAllowed: true,
        editable: true,
        enterAction: 'send',
        focusAction: 'preserve',
      });
    }
  });

  it('keeps question-blocked drafts editable and turns plain Enter into a newline', () => {
    for (const facts of [
      readyFacts({ canonicalAgentState: 'awaiting-input' }),
      readyFacts({ localQuestionGeneration: 7 }),
    ]) {
      expect(getPromptInputPolicy(facts)).toEqual({
        dispatchAllowed: false,
        dispatchBlock: 'agent-question',
        editable: true,
        enterAction: 'newline',
        explanation: 'answer-in-terminal',
        focusAction: 'preserve',
      });
    }
  });

  it('ignores a local question blocker from another generation', () => {
    expect(getPromptInputPolicy(readyFacts({ localQuestionGeneration: 6 })).dispatchAllowed).toBe(
      true,
    );
    expect(getPromptInputPolicy(readyFacts({ localQuestionGeneration: 8 })).dispatchAllowed).toBe(
      true,
    );
  });

  it('makes peer control read-only with precedence over all local blockers', () => {
    const policy = getPromptInputPolicy(
      readyFacts({
        canonicalAgentState: 'awaiting-input',
        composing: true,
        control: 'peer',
        hasText: false,
        localQuestionGeneration: 7,
        sendInFlight: true,
      }),
    );

    expect(policy).toEqual({
      dispatchAllowed: false,
      dispatchBlock: 'peer-controlled',
      editable: false,
      enterAction: 'ignore',
      explanation: 'peer-controlled',
      focusAction: 'preserve',
      readOnlyReason: 'peer-controlled',
    });
  });

  it('never dispatches while composing', () => {
    expect(getPromptInputPolicy(readyFacts({ composing: true }))).toEqual({
      dispatchAllowed: false,
      editable: true,
      enterAction: 'ignore',
      focusAction: 'preserve',
    });
  });

  it('keeps editing available while one send is in flight', () => {
    expect(getPromptInputPolicy(readyFacts({ sendInFlight: true }))).toEqual({
      dispatchAllowed: false,
      dispatchBlock: 'send-in-flight',
      editable: true,
      enterAction: 'newline',
      explanation: 'sending',
      focusAction: 'preserve',
    });
  });

  it('blocks an empty draft without changing focus', () => {
    expect(getPromptInputPolicy(readyFacts({ hasText: false }))).toEqual({
      dispatchAllowed: false,
      dispatchBlock: 'empty',
      editable: true,
      enterAction: 'ignore',
      focusAction: 'preserve',
    });
  });

  it('obeys the frozen precedence table for every boolean combination', () => {
    for (const control of ['local', 'peer'] as const) {
      for (const canonicalAgentState of CANONICAL_STATES) {
        for (const localQuestion of [false, true]) {
          for (const sendInFlight of [false, true]) {
            for (const hasText of [false, true]) {
              for (const composing of [false, true]) {
                const facts = readyFacts({
                  canonicalAgentState,
                  composing,
                  control,
                  hasText,
                  ...(localQuestion ? { localQuestionGeneration: 7 } : {}),
                  sendInFlight,
                });
                const policy = getPromptInputPolicy(facts);

                expect(policy.focusAction).toBe('preserve');
                expect(policy.editable).toBe(control === 'local');
                expect(policy.dispatchAllowed).toBe(
                  control === 'local' &&
                    !composing &&
                    canonicalAgentState !== 'awaiting-input' &&
                    !localQuestion &&
                    !sendInFlight &&
                    hasText,
                );
              }
            }
          }
        }
      }
    }
  });
});
