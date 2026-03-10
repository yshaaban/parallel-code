import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const { spawnAgentMock, ensurePlansDirectoryMock, startPlanWatcherMock } = vi.hoisted(() => ({
  spawnAgentMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    spawnAgent: spawnAgentMock,
  };
});

vi.mock('./plans.js', async () => {
  const actual = await vi.importActual<typeof import('./plans.js')>('./plans.js');
  return {
    ...actual,
    ensurePlansDirectory: ensurePlansDirectoryMock,
    startPlanWatcher: startPlanWatcherMock,
  };
});

import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Hydra spawn handling', () => {
  it('routes Hydra spawns through the internal adapter bootstrap', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.SpawnAgent]?.({
      taskId: 'task-1',
      agentId: 'agent-1',
      adapter: 'hydra',
      command: 'hydra',
      args: ['agents=codex,claude'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: {
        PARALLEL_CODE_HYDRA_STARTUP_MODE: 'smart',
      },
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: process.execPath,
        isInternalNodeProcess: true,
        args: expect.arrayContaining([
          expect.stringContaining('hydra-adapter'),
          '--hydra-command',
          'hydra',
          '--startup-mode',
          'smart',
          '--operator-arg',
          'agents=codex,claude',
        ]),
      }),
    );
  });

  it('keeps non-Hydra spawns on the generic PTY path', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.SpawnAgent]?.({
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'codex',
      args: ['resume', '--last'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        command: 'codex',
        args: ['resume', '--last'],
        isInternalNodeProcess: false,
      }),
    );
  });
});
