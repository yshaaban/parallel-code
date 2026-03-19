import { beforeEach, describe, expect, it } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import {
  clearTerminalStartupEntry,
  getTaskTerminalStartupSummary,
  getTerminalStartupSummary,
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
  setTerminalStartupPhase,
} from './terminal-startup';

describe('terminal-startup', () => {
  beforeEach(() => {
    resetTerminalStartupStateForTests();
  });

  it('summarizes queued, attaching, and restoring terminal startup work', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    registerTerminalStartupCandidate('task-1:agent-2', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'attaching');
    setTerminalStartupPhase('task-1:agent-2', 'restoring');

    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 1,
      bindingCount: 0,
      detail: '1 restoring · 1 attaching',
      label: 'Initializing 2 terminals',
      pendingCount: 2,
      queuedCount: 0,
      restoringCount: 1,
    });
    expect(getTaskTerminalStartupSummary('task-1')).toEqual({
      count: 2,
      label: 'Initializing 2 terminals',
      phase: 'restoring',
    });
  });

  it('clears startup state when the last pending terminal finishes', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');

    clearTerminalStartupEntry('task-1:agent-1');

    expect(getTerminalStartupSummary()).toBeNull();
    expect(getTaskTerminalStartupSummary('task-1')).toBeNull();
  });

  it('clears startup state through the shared store test reset helper', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');

    resetStoreForTest();

    expect(getTerminalStartupSummary()).toBeNull();
  });

  it('ignores phase and clear updates for missing or unchanged entries', () => {
    setTerminalStartupPhase('missing-task:missing-agent', 'attaching');
    clearTerminalStartupEntry('missing-task:missing-agent');

    expect(getTerminalStartupSummary()).toBeNull();

    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    const queuedSummary = getTerminalStartupSummary();

    setTerminalStartupPhase('task-1:agent-1', 'queued');
    clearTerminalStartupEntry('missing-task:missing-agent');

    expect(getTerminalStartupSummary()).toEqual(queuedSummary);
  });
});
