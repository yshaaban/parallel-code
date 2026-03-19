import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAppStartupStatus,
  getAppStartupSummary,
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

  it('returns the terminal startup summary when no app lifecycle status is active', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');

    expect(getAppStartupSummary()).toMatchObject({
      detail: '1 restoring',
      label: 'Restoring terminal output…',
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

  it('clears the app lifecycle status without disturbing terminal startup state', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setAppStartupStatus('finalizing', 'Finalizing startup');

    clearAppStartupStatus();

    expect(getAppStartupSummary()).toMatchObject({
      detail: '1 queued',
      label: 'Preparing terminal…',
    });
  });
});
