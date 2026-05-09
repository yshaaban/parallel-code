import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { loadArenaHistory, loadArenaPresets } from './persistence';
import { arenaStore, loadHistory, loadPresets } from './store';

describe('arena persistence', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadHistory([]);
    loadPresets([]);
  });

  it('loads only validated arena presets from persisted JSON', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([
        {
          id: 'preset-1',
          name: 'Preset 1',
          competitors: [
            { name: 'Alpha', command: 'alpha {prompt}' },
            { name: 'Broken', command: false },
          ],
        },
        {
          id: 'preset-bad',
          name: 'Missing competitors',
        },
        null,
      ]),
    );

    await loadArenaPresets();

    expect(invokeMock).toHaveBeenCalledWith(IPC.LoadArenaData, {
      filename: 'arena-presets.json',
    });
    expect(arenaStore.presets).toEqual([
      {
        id: 'preset-1',
        name: 'Preset 1',
        competitors: [{ name: 'Alpha', command: 'alpha {prompt}' }],
      },
    ]);
  });

  it('loads legacy arena history while dropping malformed matches and competitors', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([
        {
          id: 'match-1',
          date: '2026-05-09T00:00:00.000Z',
          prompt: 'Fix startup',
          competitors: [
            {
              name: 'Alpha',
              command: 'alpha {prompt}',
              timeMs: 1200,
              exitCode: 0,
              rating: 5,
            },
            {
              name: 'Broken',
              command: 42,
            },
          ],
        },
        {
          id: 'match-bad',
          date: '2026-05-09T00:00:00.000Z',
          prompt: 'Missing competitors',
        },
        null,
      ]),
    );

    await loadArenaHistory();

    expect(invokeMock).toHaveBeenCalledWith(IPC.LoadArenaData, {
      filename: 'arena-history.json',
    });
    expect(arenaStore.history).toEqual([
      {
        id: 'match-1',
        date: '2026-05-09T00:00:00.000Z',
        prompt: 'Fix startup',
        cwd: null,
        competitors: [
          {
            name: 'Alpha',
            command: 'alpha {prompt}',
            timeMs: 1200,
            exitCode: 0,
            rating: 5,
            worktreePath: null,
            branchName: null,
            merged: false,
            terminalOutput: null,
          },
        ],
      },
    ]);
  });
});
