import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkoutBranchMock,
  createWorktreeMock,
  getCurrentBranchMock,
  getMainBranchMock,
  removeWorktreeMock,
  killAgentMock,
  notifyAgentListChangedMock,
} = vi.hoisted(() => ({
  checkoutBranchMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  getCurrentBranchMock: vi.fn(),
  getMainBranchMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  killAgentMock: vi.fn(),
  notifyAgentListChangedMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  checkoutBranch: checkoutBranchMock,
  createWorktree: createWorktreeMock,
  getCurrentBranch: getCurrentBranchMock,
  getMainBranch: getMainBranchMock,
  removeWorktree: removeWorktreeMock,
}));

vi.mock('./pty.js', () => ({
  killAgent: killAgentMock,
  notifyAgentListChanged: notifyAgentListChangedMock,
}));

import { createTask } from './tasks.js';

function createBranchExistsError(
  branchName: string,
  worktreePath: string,
): Error & { stderr: string } {
  const error = new Error(
    `Command failed: git worktree add -b ${branchName} ${worktreePath}`,
  ) as Error & { stderr: string };
  error.stderr = `Preparing worktree (new branch '${branchName}')\nfatal: a branch named '${branchName}' already exists\n`;
  return error;
}

describe('createTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the first matching task branch when it is available', async () => {
    createWorktreeMock.mockResolvedValue({
      branch: 'task/test',
      path: '/tmp/project/.worktrees/task/test',
    });

    const result = await createTask('Test', '/tmp/project', [], 'task');

    expect(createWorktreeMock).toHaveBeenCalledWith('/tmp/project', 'task/test', []);
    expect(result).toMatchObject({
      branch_name: 'task/test',
      worktree_path: '/tmp/project/.worktrees/task/test',
      git_isolation: 'worktree',
    });
  });

  it('retries with a suffixed branch name when the initial branch already exists', async () => {
    createWorktreeMock
      .mockRejectedValueOnce(
        createBranchExistsError('task/test', '/tmp/project/.worktrees/task/test'),
      )
      .mockResolvedValueOnce({
        branch: 'task/test-2',
        path: '/tmp/project/.worktrees/task/test-2',
      });

    const result = await createTask('Test', '/tmp/project', [], 'task');

    expect(createWorktreeMock).toHaveBeenNthCalledWith(1, '/tmp/project', 'task/test', []);
    expect(createWorktreeMock).toHaveBeenNthCalledWith(2, '/tmp/project', 'task/test-2', []);
    expect(result).toMatchObject({
      branch_name: 'task/test-2',
      worktree_path: '/tmp/project/.worktrees/task/test-2',
      git_isolation: 'worktree',
    });
  });

  it('rethrows non-collision worktree errors', async () => {
    createWorktreeMock.mockRejectedValue(new Error('not a git repository'));

    await expect(createTask('Test', '/tmp/project', [], 'task')).rejects.toThrow(
      'not a git repository',
    );
    expect(createWorktreeMock).toHaveBeenCalledOnce();
  });
});
