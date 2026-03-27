import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';
import {
  isTerminalFocusedInputPromptSuppressionActive,
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
} from '../app/terminal-focused-input';
import { setStore, store } from './core';
import {
  clearAgentBusyState,
  getAgentLastOutputAt,
  getAgentOutputTail,
  markAgentOutput,
  markAgentSpawned,
  isAgentIdle,
  resetAgentOutputActivityRuntimeState,
} from './agent-output-activity';
import { onAgentReady } from './agent-ready-callbacks';
import { isAgentAskingQuestion } from './agent-question-state';
import { createTestAgent } from '../test/store-test-helpers';

describe('agent-output-activity diagnostics', () => {
  const originalPerformance = globalThis.performance;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    vi.stubGlobal('performance', {
      now: (() => {
        let now = 0;
        return () => {
          now += 1;
          return now;
        };
      })(),
    } as Performance);
    resetRendererRuntimeDiagnostics();
    resetAgentOutputActivityRuntimeState();
    resetTerminalFocusedInputForTests();
    setStore('activeTaskId', null);
  });

  afterEach(() => {
    resetAgentOutputActivityRuntimeState();
    resetRendererRuntimeDiagnostics();
    resetTerminalFocusedInputForTests();
    setStore('activeTaskId', null);
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    vi.unstubAllGlobals();
    globalThis.performance = originalPerformance;
  });

  it('records immediate and deferred analysis counters and resets them', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-1');
    setStore('activeTaskId', 'task-1');
    vi.advanceTimersByTime(250);
    markAgentOutput('agent-1', encoder.encode('hello\n'), 'task-1');

    setStore('activeTaskId', null);
    vi.advanceTimersByTime(100);
    markAgentOutput('agent-1', encoder.encode('still working\n'), 'task-1');
    vi.advanceTimersByTime(50);
    markAgentOutput('agent-1', encoder.encode('still working\n'), 'task-1');
    vi.advanceTimersByTime(2_000);

    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis).toEqual(
      expect.objectContaining({
        activeAgents: 1,
        analysisCalls: 2,
        analysisSchedules: 2,
        backgroundChecks: 3,
        backgroundSkips: 1,
        deferredAnalyses: 1,
        immediateAnalyses: 1,
        lastAnalysisDurationMs: expect.any(Number),
        pendingTimers: 0,
        totalAnalysisDurationMs: expect.any(Number),
      }),
    );

    resetRendererRuntimeDiagnostics();

    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis).toEqual({
      activeAgents: 0,
      analysisCalls: 0,
      analysisSchedules: 0,
      backgroundChecks: 0,
      backgroundSkips: 0,
      deferredAnalyses: 0,
      immediateAnalyses: 0,
      lastAnalysisDurationMs: null,
      maxAnalysisDurationMs: 0,
      pendingTimers: 0,
      totalAnalysisDurationMs: 0,
    });
  });

  it('schedules deferred prompt analysis for the remaining interval instead of a full extra window', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-1');
    setStore('activeTaskId', 'task-1');

    vi.advanceTimersByTime(150);
    markAgentOutput('agent-1', encoder.encode('still working\n'), 'task-1');

    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis.analysisCalls).toBe(0);

    vi.advanceTimersByTime(49);
    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis.analysisCalls).toBe(0);

    vi.advanceTimersByTime(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis).toEqual(
      expect.objectContaining({
        analysisCalls: 1,
        deferredAnalyses: 1,
        immediateAnalyses: 0,
        pendingTimers: 0,
      }),
    );
  });

  it('skips prompt analysis for shell terminals while still tracking idle state', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('shell-1');
    setStore('activeTaskId', 'task-1');

    markAgentOutput('shell-1', encoder.encode('working...\n'), 'task-1', 'shell');
    markAgentOutput('shell-1', encoder.encode('❯ '), 'task-1', 'shell');

    expect(isAgentIdle('shell-1')).toBe(true);
    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis).toEqual({
      activeAgents: 0,
      analysisCalls: 0,
      analysisSchedules: 0,
      backgroundChecks: 0,
      backgroundSkips: 0,
      deferredAnalyses: 0,
      immediateAnalyses: 0,
      lastAnalysisDurationMs: null,
      maxAnalysisDurationMs: 0,
      pendingTimers: 0,
      totalAnalysisDurationMs: 0,
    });
  });

  it('preserves question detection when ANSI sequences are split across chunks', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-ansi');
    setStore('activeTaskId', 'task-1');
    vi.advanceTimersByTime(250);

    markAgentOutput('agent-ansi', encoder.encode('\u001b['), 'task-1');
    markAgentOutput('agent-ansi', encoder.encode('31mProceed? [y/N]'), 'task-1');
    vi.advanceTimersByTime(250);

    expect(isAgentAskingQuestion('agent-ansi')).toBe(true);
  });

  it('does not clear question state for question-like prompt lines on the fast path', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-question');
    setStore('activeTaskId', 'task-1');

    markAgentOutput('agent-question', encoder.encode('Proceed with trust? [y/N]'), 'task-1');

    expect(isAgentAskingQuestion('agent-question')).toBe(true);
    expect(isAgentIdle('agent-question')).toBe(false);
  });

  it('does not mark shortcut-only permission footers as a question when the prompt is ready', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-ready');
    setStore('activeTaskId', 'task-1');

    markAgentOutput(
      'agent-ready',
      encoder.encode(
        'What would you like to work on?\n⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ',
      ),
      'task-1',
    );

    expect(isAgentAskingQuestion('agent-ready')).toBe(false);
    expect(isAgentIdle('agent-ready')).toBe(true);
  });

  it('suppresses question detection for local typing echo on the actively typed agent', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-question');
    setStore('activeTaskId', 'task-1');
    noteTerminalFocusedInput('task-1', 'agent-question');

    markAgentOutput('agent-question', encoder.encode('Proceed with trust? [y/N]'), 'task-1');
    vi.advanceTimersByTime(250);

    expect(isAgentAskingQuestion('agent-question')).toBe(false);
    expect(isAgentIdle('agent-question')).toBe(false);
  });

  it('clears local typing suppression when the agent respawns', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');
    expect(isTerminalFocusedInputPromptSuppressionActive('agent-1')).toBe(true);

    markAgentSpawned('agent-1');

    expect(isTerminalFocusedInputPromptSuppressionActive('agent-1')).toBe(false);
  });

  it('clears stale last-output timestamps when the agent respawns', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-1');
    setStore('activeTaskId', 'task-1');

    markAgentOutput('agent-1', encoder.encode('hello\n'), 'task-1');
    expect(getAgentLastOutputAt('agent-1')).not.toBeNull();

    markAgentSpawned('agent-1');

    expect(getAgentLastOutputAt('agent-1')).toBeNull();
  });

  it('revives a stale exited agent when live output continues arriving', () => {
    const encoder = new TextEncoder();
    setStore('agents', {
      'agent-1': createTestAgent({
        exitCode: 1,
        id: 'agent-1',
        lastOutput: ['Process exited'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    });

    markAgentOutput('agent-1', encoder.encode('still running\n'), 'task-1', 'full', 0);

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: null,
        lastOutput: [],
        signal: null,
        status: 'running',
      }),
    );
  });

  it('does not revive an exited agent from output tied to an older generation', () => {
    const encoder = new TextEncoder();
    setStore('agents', {
      'agent-1': createTestAgent({
        exitCode: 1,
        generation: 2,
        id: 'agent-1',
        lastOutput: ['Process exited'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    });

    markAgentOutput('agent-1', encoder.encode('stale output\n'), 'task-1', 'full', 1);

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: 1,
        generation: 2,
        lastOutput: ['Process exited'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    );
  });

  it('ignores stale-generation output without mutating tail, activity, or question state', () => {
    const encoder = new TextEncoder();
    setStore('activeTaskId', 'task-1');
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 2,
        id: 'agent-1',
        status: 'running',
      }),
    });

    markAgentSpawned('agent-1');
    markAgentOutput('agent-1', encoder.encode('current output\n'), 'task-1', 'full', 2);
    clearAgentBusyState('agent-1');
    vi.setSystemTime(100);
    const lastOutputAtBeforeStaleChunk = getAgentLastOutputAt('agent-1');

    markAgentOutput('agent-1', encoder.encode('stale prompt? [y/N]\n'), 'task-1', 'full', 1);

    expect(getAgentOutputTail('agent-1')).toBe('current output\n');
    expect(getAgentLastOutputAt('agent-1')).toBe(lastOutputAtBeforeStaleChunk);
    expect(isAgentIdle('agent-1')).toBe(true);
    expect(isAgentAskingQuestion('agent-1')).toBe(false);
  });

  it('does not fire ready callbacks for stale-generation prompt output', () => {
    const encoder = new TextEncoder();
    const onReady = vi.fn();
    setStore('activeTaskId', 'task-1');
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 4,
        id: 'agent-1',
        status: 'running',
      }),
    });

    markAgentSpawned('agent-1');
    onAgentReady('agent-1', onReady);

    markAgentOutput('agent-1', encoder.encode('❯ '), 'task-1', 'full', 3);

    expect(onReady).not.toHaveBeenCalled();
  });

  it('clears temporary busy state without discarding recent output continuity', () => {
    const encoder = new TextEncoder();
    markAgentSpawned('agent-1');
    setStore('activeTaskId', 'task-1');

    markAgentOutput('agent-1', encoder.encode('hello\n'), 'task-1');

    expect(isAgentIdle('agent-1')).toBe(false);
    expect(getAgentOutputTail('agent-1')).toContain('hello');
    expect(getAgentLastOutputAt('agent-1')).not.toBeNull();

    clearAgentBusyState('agent-1');

    expect(isAgentIdle('agent-1')).toBe(true);
    expect(getAgentOutputTail('agent-1')).toContain('hello');
    expect(getAgentLastOutputAt('agent-1')).not.toBeNull();
  });
});
