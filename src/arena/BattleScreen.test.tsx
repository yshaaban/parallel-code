import { render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/TerminalView', () => ({
  TerminalView: () => <div>Terminal view</div>,
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
});
