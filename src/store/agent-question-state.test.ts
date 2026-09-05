import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';

import {
  clearLocalQuestion,
  getLocalAgentQuestionGeneration,
  getLocalAgentQuestionState,
  isLocalAgentQuestionActive,
  markLocalQuestion,
  removeLocalQuestion,
  resetAgentQuestionStateForTests,
  resetLocalQuestionForGeneration,
} from './agent-question-state';

describe('generation-bound local agent question state', () => {
  beforeEach(() => resetAgentQuestionStateForTests());

  it('marks and clears only with newer evidence from the same generation', () => {
    resetLocalQuestionForGeneration('agent-1', 4);
    markLocalQuestion('agent-1', 4, 1);
    expect(isLocalAgentQuestionActive('agent-1', 4)).toBe(true);

    clearLocalQuestion('agent-1', 4, 1);
    expect(isLocalAgentQuestionActive('agent-1', 4)).toBe(true);

    clearLocalQuestion('agent-1', 4, 2);
    expect(isLocalAgentQuestionActive('agent-1', 4)).toBe(false);
    expect(getLocalAgentQuestionState('agent-1')).toMatchObject({
      active: false,
      evidenceRevision: 2,
      generation: 4,
    });
  });

  it('drops stale generations and never exposes future evidence as current', () => {
    resetLocalQuestionForGeneration('agent-1', 5);
    markLocalQuestion('agent-1', 4, 99);
    expect(getLocalAgentQuestionState('agent-1')).toMatchObject({ generation: 5, active: false });

    markLocalQuestion('agent-1', 6, 1);
    expect(getLocalAgentQuestionGeneration('agent-1', 5)).toBeUndefined();
    expect(getLocalAgentQuestionGeneration('agent-1', 6)).toBe(6);
  });

  it('resets a restarted generation before accepting its output', () => {
    markLocalQuestion('agent-1', 7, 5);
    resetLocalQuestionForGeneration('agent-1', 8);

    expect(isLocalAgentQuestionActive('agent-1', 7)).toBe(false);
    expect(isLocalAgentQuestionActive('agent-1', 8)).toBe(false);
    expect(getLocalAgentQuestionState('agent-1')).toEqual({
      active: false,
      agentId: 'agent-1',
      evidenceRevision: 0,
      generation: 8,
    });
  });

  it('removes all local evidence with the agent', () => {
    markLocalQuestion('agent-1', 1, 1);
    removeLocalQuestion('agent-1');
    expect(getLocalAgentQuestionState('agent-1')).toBeNull();
  });

  it('records only content-free transitions and stale-generation drops when enabled', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true },
    });
    resetRendererRuntimeDiagnostics();

    try {
      resetLocalQuestionForGeneration('private-agent-id', 3);
      markLocalQuestion('private-agent-id', 3, 1);
      markLocalQuestion('private-agent-id', 3, 2);
      clearLocalQuestion('private-agent-id', 3, 3);
      markLocalQuestion('private-agent-id', 2, 99);

      const diagnostics = getRendererRuntimeDiagnosticsSnapshot().promptQuestion;
      expect(diagnostics.localEnters).toBe(1);
      expect(diagnostics.localClears).toBe(1);
      expect(diagnostics.staleGenerationDrops).toBe(1);
      expect(JSON.stringify(diagnostics)).not.toContain('private-agent-id');
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
      resetRendererRuntimeDiagnostics();
    }
  });
});
