import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { IPC } from '../../electron/ipc/channels';
import { resetForNewMatch, resetForRematch, setCwd, startBattle } from './store';

describe('Arena cleanup ordering', () => {
  beforeEach(async () => {
    invokeMock.mockResolvedValue(undefined);
    await resetForNewMatch();
    invokeMock.mockClear();
  });

  it.each([
    ['new match', resetForNewMatch],
    ['rematch', resetForRematch],
  ])(
    'waits for agent termination before removing worktrees during %s reset',
    async (_name, reset) => {
      setCwd('/tmp/project');
      startBattle([
        {
          agentId: 'arena-agent-1',
          branchName: 'arena/competitor-1',
          command: 'codex',
          endTime: null,
          exitCode: null,
          id: 'competitor-1',
          name: 'Codex',
          startTime: Date.now(),
          status: 'running',
          worktreePath: '/tmp/project/.worktrees/arena/competitor-1',
        },
      ]);

      await reset();

      expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.KillAgent, {
        agentId: 'arena-agent-1',
      });
      expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.RemoveArenaWorktree, {
        branchName: 'arena/competitor-1',
        projectRoot: '/tmp/project',
      });
    },
  );
});
