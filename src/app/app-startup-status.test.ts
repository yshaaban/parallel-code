import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAppStartupPresentation,
  clearAppStartupStatus,
  completeAppStartupPresentation,
  getAppStartupSummary,
  isAppStartupPresentationPending,
  resetAppStartupStatusForTests,
  setAppStartupStatus,
} from './app-startup-status';
import {
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
  setTerminalStartupPhase,
} from '../store/terminal-startup';

describe('app-startup-status', () => {
  beforeEach(() => {
    resetAppStartupStatusForTests();
    resetTerminalStartupStateForTests();
  });

  it('surfaces terminal-only startup when no app lifecycle status is active', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');

    expect(getAppStartupSummary()).toMatchObject({
      detail: '1 restoring',
      label: 'Preparing terminal…',
    });
  });

  it('combines app lifecycle progress with the terminal startup summary', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'attaching');
    setAppStartupStatus('restoring', 'Loading workspace state');

    expect(getAppStartupSummary()).toMatchObject({
      detail: 'Loading workspace state · 1 attaching',
      label: 'Restoring your workspace…',
    });
  });

  it('falls back to terminal-only startup after the app lifecycle status clears', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'binding');
    setAppStartupStatus('finalizing', 'Finalizing startup');

    clearAppStartupStatus();

    expect(getAppStartupSummary()).toMatchObject({
      detail: '1 connecting',
      label: 'Preparing terminal…',
    });
  });

  it('tracks the startup presentation pending window from begin to complete', () => {
    expect(isAppStartupPresentationPending()).toBe(false);

    beginAppStartupPresentation();
    expect(isAppStartupPresentationPending()).toBe(true);

    completeAppStartupPresentation();
    expect(isAppStartupPresentationPending()).toBe(false);
  });

  it('completes presentation pending when the startup status clears', () => {
    beginAppStartupPresentation();
    setAppStartupStatus('bootstrapping', 'Loading workspace');

    clearAppStartupStatus();

    expect(isAppStartupPresentationPending()).toBe(false);
  });

  it('survives repeated begin/complete churn deterministically', () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      beginAppStartupPresentation();
      expect(isAppStartupPresentationPending()).toBe(true);
      completeAppStartupPresentation();
      expect(isAppStartupPresentationPending()).toBe(false);
    }
  });

  it('reset seam clears presentation pending', () => {
    beginAppStartupPresentation();

    resetAppStartupStatusForTests();

    expect(isAppStartupPresentationPending()).toBe(false);
  });
});
