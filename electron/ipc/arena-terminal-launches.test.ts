import { afterEach, describe, expect, it } from 'vitest';

import {
  consumeArenaTerminalLaunch,
  registerArenaTerminalLaunch,
  resetArenaTerminalLaunchesForTest,
  revokeArenaTerminalLaunches,
} from './arena-terminal-launches.js';

afterEach(() => resetArenaTerminalLaunchesForTest());

describe('Arena terminal launch capabilities', () => {
  function register() {
    return registerArenaTerminalLaunch({
      agentId: 'agent-1',
      branchName: 'arena/one',
      projectRoot: '/tmp/project',
      root: '/tmp/project/.worktrees/arena-one',
      taskId: 'competitor-1',
    });
  }

  it('is one-shot and bound to the backend-created root and exact identities', () => {
    const token = register();
    expect(
      consumeArenaTerminalLaunch({
        agentId: 'agent-1',
        cwd: '/tmp/project/.worktrees/arena-one',
        taskId: 'competitor-1',
        token,
      }),
    ).toEqual({ root: '/tmp/project/.worktrees/arena-one' });
    expect(
      consumeArenaTerminalLaunch({
        agentId: 'agent-1',
        cwd: '/tmp/project/.worktrees/arena-one',
        taskId: 'competitor-1',
        token,
      }),
    ).toBeNull();
  });

  it.each([
    { agentId: 'other', cwd: '/tmp/project/.worktrees/arena-one', taskId: 'competitor-1' },
    { agentId: 'agent-1', cwd: '/tmp/other', taskId: 'competitor-1' },
    { agentId: 'agent-1', cwd: '/tmp/project/.worktrees/arena-one', taskId: 'other' },
  ])('rejects a mismatched launch selector without consuming the capability', (selector) => {
    const token = register();
    expect(consumeArenaTerminalLaunch({ ...selector, token })).toBeNull();
    expect(
      consumeArenaTerminalLaunch({
        agentId: 'agent-1',
        cwd: '/tmp/project/.worktrees/arena-one',
        taskId: 'competitor-1',
        token,
      }),
    ).toEqual({ root: '/tmp/project/.worktrees/arena-one' });
  });

  it('revokes unconsumed launches before Arena worktree removal', () => {
    const token = register();
    revokeArenaTerminalLaunches('/tmp/project', 'arena/one');
    expect(
      consumeArenaTerminalLaunch({
        agentId: 'agent-1',
        cwd: '/tmp/project/.worktrees/arena-one',
        taskId: 'competitor-1',
        token,
      }),
    ).toBeNull();
  });
});
