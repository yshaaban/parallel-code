import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, saveArenaPresetsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveArenaPresetsMock: vi.fn(async () => undefined),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../components/ProjectSelect', () => ({
  ProjectSelect: () => <div>Project select</div>,
}));

vi.mock('./persistence', () => ({
  saveArenaPresets: saveArenaPresetsMock,
}));

vi.mock('../store/store', () => ({
  getProject: (projectId: string) =>
    projectId === 'project-1' ? { id: 'project-1', path: '/repo' } : null,
  store: {
    projects: [{ id: 'project-1', path: '/repo' }],
  },
}));

import { ConfigScreen } from './ConfigScreen';
import { arenaStore, resetForNewMatch, setCwd, setPrompt, updateCompetitor } from './store';

describe('ConfigScreen', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetForNewMatch();
    updateCompetitor(arenaStore.competitors[0].id, {
      command: 'claude -p "{prompt}" --dangerously-skip-permissions',
      name: 'Claude',
    });
    updateCompetitor(arenaStore.competitors[1].id, {
      command: 'gemini -p "{prompt}" --yolo',
      name: 'Gemini',
    });
    setPrompt('Fix the build');
    setCwd('/repo');
  });

  afterEach(async () => {
    await resetForNewMatch();
  });

  it('disables Fight when a competitor fails preflight', async () => {
    invokeMock.mockImplementation(async (channel, args) => {
      if (channel === 'inspect_arena_competitor') {
        if (args.commandTemplate.startsWith('gemini')) {
          return {
            executable: 'gemini',
            issues: [
              {
                code: 'missing_gemini_api_key',
                message: 'Gemini requires GEMINI_API_KEY in the app/server environment.',
                severity: 'error',
              },
            ],
            status: 'missing_auth',
          };
        }

        return {
          executable: 'claude',
          issues: [
            {
              code: 'quiet_noninteractive_output',
              message: 'This CLI can stay quiet until it finishes even when it is still working.',
              severity: 'warning',
            },
          ],
          status: 'ready',
        };
      }

      throw new Error(`Unexpected IPC channel: ${String(channel)}`);
    });

    render(() => <ConfigScreen />);

    await waitFor(() => {
      expect(
        screen.getByText('Gemini requires GEMINI_API_KEY in the app/server environment.'),
      ).toBeTruthy();
    });

    expect((screen.getByRole('button', { name: 'Fight!' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('disables Fight immediately while competitor preflight is rechecking', () => {
    let resolveInspect:
      | ((value: { executable: string; issues: never[]; status: 'ready' }) => void)
      | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInspect = resolve;
        }),
    );

    render(() => <ConfigScreen />);

    expect(screen.getAllByText('Checking competitor availability…').length).toBe(2);
    expect((screen.getByRole('button', { name: 'Fight!' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    if (resolveInspect) {
      resolveInspect({
        executable: 'claude',
        issues: [],
        status: 'ready',
      });
    }
  });

  it('keeps the match-history entrypoint visible on the config screen', () => {
    invokeMock.mockResolvedValue({
      executable: 'claude',
      issues: [],
      status: 'ready',
    });

    render(() => <ConfigScreen />);

    expect(screen.getByRole('button', { name: 'View match history' })).toBeTruthy();
  });

  it('keeps Fight enabled when preflight only returns warnings', async () => {
    invokeMock.mockResolvedValue({
      executable: 'claude',
      issues: [
        {
          code: 'quiet_noninteractive_output',
          message: 'This CLI can stay quiet until it finishes even when it is still working.',
          severity: 'warning',
        },
      ],
      status: 'ready',
    });

    render(() => <ConfigScreen />);

    await waitFor(() => {
      expect(
        screen.getAllByText(
          'This CLI can stay quiet until it finishes even when it is still working.',
        ).length,
      ).toBeGreaterThan(0);
    });

    expect((screen.getByRole('button', { name: 'Fight!' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
