import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { setStore } from '../store/core';
import {
  clearTerminalFocusedInputAgent,
  completeTerminalFocusedInputEcho,
  getTerminalFocusedInputSnapshot,
  isTerminalDenseFocusedInputProtectionActive,
  isTerminalFocusedInputActive,
  isTerminalFocusedInputEchoReservationActive,
  isTerminalFocusedInputPromptSuppressionActive,
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
  settleTerminalFocusedInput,
} from './terminal-focused-input';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';

describe('terminal-focused-input', () => {
  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFocusedInputForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFocusedInputForTests();
    Reflect.deleteProperty(globalThis, 'window');
    vi.useRealTimers();
  });

  it('tracks and settles the active focused-input task', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');

    expect(isTerminalFocusedInputActive()).toBe(true);
    expect(isTerminalFocusedInputActive('task-1', 'agent-1')).toBe(true);
    expect(isTerminalFocusedInputEchoReservationActive()).toBe(true);
    expect(isTerminalFocusedInputEchoReservationActive('task-1', 'agent-1')).toBe(true);
    expect(isTerminalFocusedInputPromptSuppressionActive('agent-1')).toBe(true);
    expect(getTerminalFocusedInputSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        agentId: 'agent-1',
        echoReservationActive: true,
        taskId: 'task-1',
      }),
    );

    settleTerminalFocusedInput('task-1', 'agent-1');

    expect(isTerminalFocusedInputActive()).toBe(false);
    expect(isTerminalFocusedInputEchoReservationActive()).toBe(false);
    expect(getTerminalFocusedInputSnapshot()).toEqual({
      active: false,
      agentId: null,
      ageMs: 0,
      echoReservationActive: false,
      echoReservationRemainingMs: 0,
      remainingMs: 0,
      taskId: null,
    });
  });

  it('expires the active focused-input window automatically', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');

    vi.advanceTimersByTime(241);

    expect(isTerminalFocusedInputActive()).toBe(false);
    expect(isTerminalFocusedInputEchoReservationActive()).toBe(false);
  });

  it('expires the focused first-echo reservation before the broader focused-input window', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');

    vi.advanceTimersByTime(161);

    expect(isTerminalFocusedInputActive()).toBe(true);
    expect(isTerminalFocusedInputEchoReservationActive()).toBe(false);
  });

  it('clears only the echo reservation on the first focused write while keeping prompt suppression active', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');

    completeTerminalFocusedInputEcho('task-1', 'agent-1');

    expect(isTerminalFocusedInputActive('task-1', 'agent-1')).toBe(true);
    expect(isTerminalFocusedInputEchoReservationActive('task-1', 'agent-1')).toBe(false);
    expect(isTerminalFocusedInputPromptSuppressionActive('agent-1')).toBe(true);
  });

  it('clears focused-input suppression for a specific agent', () => {
    noteTerminalFocusedInput('task-1', 'agent-1');

    clearTerminalFocusedInputAgent('agent-1');

    expect(isTerminalFocusedInputActive('task-1', 'agent-1')).toBe(false);
    expect(isTerminalFocusedInputEchoReservationActive('task-1', 'agent-1')).toBe(false);
    expect(isTerminalFocusedInputPromptSuppressionActive('agent-1')).toBe(false);
  });

  it('only enables dense focused-input protection in High Load Mode at or above the dense threshold', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      label: 'terminal-focused-input-dense-threshold',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    noteTerminalFocusedInput('task-1', 'agent-1');

    expect(isTerminalDenseFocusedInputProtectionActive(3)).toBe(false);
    expect(isTerminalDenseFocusedInputProtectionActive(4)).toBe(true);
  });
});
