import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAppStartupStatusForTests } from '../app/app-startup-status';
import {
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
  setTerminalStartupPhase,
} from '../store/terminal-startup';
import { TerminalStartupChip } from './TerminalStartupChip';

describe('TerminalStartupChip', () => {
  beforeEach(() => {
    resetAppStartupStatusForTests();
    resetTerminalStartupStateForTests();
  });

  it('renders the aggregate terminal startup summary', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    registerTerminalStartupCandidate('task-2:agent-2', 'task-2');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');

    render(() => <TerminalStartupChip />);

    expect(screen.getByText('Initializing 2 terminals')).toBeDefined();
    expect(screen.getByText('1 restoring · 1 queued')).toBeDefined();
  });
});
