import { render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalViewMock = vi.hoisted(() => vi.fn(() => <div>Terminal view</div>));

vi.mock('../components/TerminalView', () => ({
  TerminalView: terminalViewMock,
}));

vi.mock('../components/ChangedFilesList', () => ({
  ChangedFilesList: () => <div>Changed files</div>,
}));

vi.mock('../components/DiffViewerDialog', () => ({
  DiffViewerDialog: () => null,
}));

vi.mock('../lib/ipc', () => ({
  fireAndForget: vi.fn(),
}));

vi.mock('../store/notification', () => ({
  showNotification: vi.fn(),
}));

import { BattleScreen } from './BattleScreen';
import { resetForNewMatch, setPrompt, startBattle } from './store';

describe('BattleScreen', () => {
  beforeEach(async () => {
    await resetForNewMatch();
    setPrompt('Ship the feature');
    startBattle([
      {
        agentId: 'agent-1',
        branchName: null,
        command: 'claude -p "{prompt}" --dangerously-skip-permissions',
        endTime: null,
        exitCode: null,
        id: 'competitor-1',
        name: 'Claude',
        preflightIssues: [
          {
            code: 'quiet_noninteractive_output',
            message: 'This CLI can stay quiet until it finishes even when it is still working.',
            severity: 'warning',
          },
        ],
        startTime: Date.now(),
        status: 'running',
        worktreePath: null,
      },
    ]);
  });

  afterEach(async () => {
    await resetForNewMatch();
  });

  it('shows the quiet-execution note for competitors that had a preflight warning', () => {
    render(() => <BattleScreen />);

    expect(
      screen.getByText('This CLI can stay quiet until it finishes even when it is still working.'),
    ).toBeTruthy();
  });

  it('materializes direct executable invocations without shell wrapping', () => {
    render(() => <BattleScreen />);

    const calls = terminalViewMock.mock.calls as unknown as Array<
      [{ command: string; args: string[] }]
    >;
    expect(
      calls.some(
        ([props]) =>
          props.command === 'claude' &&
          props.args.length === 3 &&
          props.args[0] === '-p' &&
          props.args[1] === 'Ship the feature' &&
          props.args[2] === '--dangerously-skip-permissions',
      ),
    ).toBe(true);
  });
});
