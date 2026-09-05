import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodeTaskWorktreeLinkRequestV1 } from './git-worktree-symlinks.js';

const {
  checkoutBranchMock,
  createWorktreeMock,
  getCurrentBranchMock,
  getGitCommonDirectoryMock,
  getMainBranchMock,
  removeWorktreeMock,
  notifyAgentListChangedMock,
} = vi.hoisted(() => ({
  checkoutBranchMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  getCurrentBranchMock: vi.fn(),
  getGitCommonDirectoryMock: vi.fn(),
  getMainBranchMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  notifyAgentListChangedMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  checkoutBranch: checkoutBranchMock,
  createWorktree: createWorktreeMock,
  getCurrentBranch: getCurrentBranchMock,
  getGitCommonDirectory: getGitCommonDirectoryMock,
  getMainBranch: getMainBranchMock,
  removeWorktree: removeWorktreeMock,
}));

vi.mock('./pty.js', () => ({
  notifyAgentListChanged: notifyAgentListChangedMock,
}));

import {
  createCurrentBranchTask,
  createNonGitTask,
  createTask,
  deleteTask,
  importExistingWorktreeTask,
} from './tasks.js';

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
    const worktreeLinkRequest = encodeTaskWorktreeLinkRequestV1([]);
    const warning = {
      message:
        'Could not share "cache": the filesystem link could not be created and verified safely.',
      name: 'cache',
      reason: 'link_failed' as const,
    };
    createWorktreeMock.mockResolvedValue({
      branch: 'task/test',
      path: '/tmp/project/.worktrees/task/test',
      symlink_warnings: [warning],
    });

    const result = await createTask('Test', '/tmp/project', worktreeLinkRequest, 'task');

    expect(createWorktreeMock).toHaveBeenCalledWith(
      '/tmp/project',
      'task/test',
      worktreeLinkRequest,
    );
    expect(result).toMatchObject({
      branch_name: 'task/test',
      worktree_path: '/tmp/project/.worktrees/task/test',
      git_isolation: 'worktree',
      symlink_warnings: [warning],
    });
  });

  it('passes the selected base branch into managed worktree creation', async () => {
    const worktreeLinkRequest = encodeTaskWorktreeLinkRequestV1([]);
    createWorktreeMock.mockResolvedValue({
      branch: 'task/test',
      path: '/tmp/project/.worktrees/task/test',
    });

    const result = await createTask(
      'Test',
      '/tmp/project',
      worktreeLinkRequest,
      'task',
      'release/main',
    );

    expect(createWorktreeMock).toHaveBeenCalledWith(
      '/tmp/project',
      'task/test',
      worktreeLinkRequest,
      false,
      'release/main',
    );
    expect(result).toMatchObject({
      branch_name: 'task/test',
      worktree_path: '/tmp/project/.worktrees/task/test',
      git_isolation: 'worktree',
    });
  });

  it('retries with a suffixed branch name when the initial branch already exists', async () => {
    const worktreeLinkRequest = encodeTaskWorktreeLinkRequestV1([]);
    createWorktreeMock
      .mockRejectedValueOnce(
        createBranchExistsError('task/test', '/tmp/project/.worktrees/task/test'),
      )
      .mockResolvedValueOnce({
        branch: 'task/test-2',
        path: '/tmp/project/.worktrees/task/test-2',
      });

    const result = await createTask('Test', '/tmp/project', worktreeLinkRequest, 'task');

    expect(createWorktreeMock).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'task/test',
      worktreeLinkRequest,
    );
    expect(createWorktreeMock).toHaveBeenNthCalledWith(
      2,
      '/tmp/project',
      'task/test-2',
      worktreeLinkRequest,
    );
    expect(result).toMatchObject({
      branch_name: 'task/test-2',
      worktree_path: '/tmp/project/.worktrees/task/test-2',
      git_isolation: 'worktree',
    });
  });

  it('rethrows non-collision worktree errors', async () => {
    createWorktreeMock.mockRejectedValue(new Error('not a git repository'));

    await expect(
      createTask('Test', '/tmp/project', encodeTaskWorktreeLinkRequestV1([]), 'task'),
    ).rejects.toThrow('not a git repository');
    expect(createWorktreeMock).toHaveBeenCalledOnce();
  });

  it('does not retry branch ref prefix conflicts', async () => {
    createWorktreeMock.mockRejectedValue(
      new Error(
        'Cannot create branch "feature/test" because local branch "feature" already uses that ref path.',
      ),
    );

    await expect(
      createTask('Test', '/tmp/project', encodeTaskWorktreeLinkRequestV1([]), 'feature'),
    ).rejects.toThrow('Cannot create branch "feature/test"');
    expect(createWorktreeMock).toHaveBeenCalledOnce();
  });
});

describe('createNonGitTask', () => {
  it('creates a task rooted at the project folder without git metadata', () => {
    expect(createNonGitTask('/tmp/folder')).toMatchObject({
      branch_name: '',
      project_mode: 'non-git',
      worktree_path: '/tmp/folder',
    });
  });
});

describe('createCurrentBranchTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMainBranchMock.mockResolvedValue('main');
  });

  it('uses the checked-out branch without resolving or switching the project default', async () => {
    getCurrentBranchMock.mockResolvedValue('main');

    await expect(createCurrentBranchTask('/tmp/project')).resolves.toMatchObject({
      base_branch: 'main',
      branch_name: 'main',
      worktree_path: '/tmp/project',
    });

    expect(getCurrentBranchMock).toHaveBeenCalledOnce();
    expect(checkoutBranchMock).not.toHaveBeenCalled();
    expect(getMainBranchMock).not.toHaveBeenCalled();
  });

  it('preserves the checked-out branch when the configured review base differs', async () => {
    getCurrentBranchMock.mockResolvedValue('feature/old');
    checkoutBranchMock.mockResolvedValue(undefined);

    await expect(createCurrentBranchTask('/tmp/project', 'custom/trunk')).resolves.toMatchObject({
      base_branch: 'custom/trunk',
      branch_name: 'feature/old',
      worktree_path: '/tmp/project',
    });

    expect(getCurrentBranchMock).toHaveBeenCalledOnce();
    expect(checkoutBranchMock).not.toHaveBeenCalled();
    expect(getMainBranchMock).not.toHaveBeenCalled();
  });

  it.each(['main', 'master', 'develop', 'releases/stable'])(
    'allows parallel independent tasks on %s',
    async (branch) => {
      getCurrentBranchMock.mockResolvedValue(branch);
      const results = await Promise.all([
        createCurrentBranchTask('/tmp/project'),
        createCurrentBranchTask('/tmp/project'),
      ]);
      expect(new Set(results.map((result) => result.id)).size).toBe(2);
      expect(results.map((result) => result.branch_name)).toEqual([branch, branch]);
      expect(checkoutBranchMock).not.toHaveBeenCalled();
      expect(createWorktreeMock).not.toHaveBeenCalled();
    },
  );

  it('fails without modifying Git when the checkout is detached or unreadable', async () => {
    getCurrentBranchMock.mockRejectedValueOnce(new Error('HEAD is detached'));
    await expect(createCurrentBranchTask('/tmp/project')).rejects.toThrow('HEAD is detached');
    expect(checkoutBranchMock).not.toHaveBeenCalled();
  });
});

describe('deleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notifies agent-list subscribers even when worktree cleanup fails', async () => {
    removeWorktreeMock.mockRejectedValue(new Error('remove failed'));

    await expect(deleteTask('task/delete', true, '/tmp/project')).rejects.toThrow('remove failed');

    expect(notifyAgentListChangedMock).toHaveBeenCalledTimes(1);
  });
});

describe('importExistingWorktreeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports an existing worktree from the same git common directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-import-test-'));
    const projectRoot = path.join(tempRoot, 'project');
    const worktreePath = path.join(tempRoot, 'worktree');
    const commonDir = path.join(tempRoot, '.git');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(commonDir, { recursive: true });

    getGitCommonDirectoryMock.mockResolvedValue(commonDir);
    getMainBranchMock.mockResolvedValue('main');
    getCurrentBranchMock.mockResolvedValue('task/imported');

    try {
      const result = await importExistingWorktreeTask(projectRoot, worktreePath, 'main');

      expect(getGitCommonDirectoryMock).toHaveBeenCalledWith(projectRoot);
      expect(getGitCommonDirectoryMock).toHaveBeenCalledWith(worktreePath);
      expect(result).toMatchObject({
        branch_name: 'task/imported',
        worktree_path: worktreePath,
        base_branch: 'main',
        git_isolation: 'existing-worktree',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects importing the project root as an existing worktree', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-import-test-'));
    const projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    try {
      await expect(importExistingWorktreeTask(projectRoot, projectRoot, 'main')).rejects.toThrow(
        'cannot use the project root',
      );
      expect(getGitCommonDirectoryMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects worktrees from a different git common directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-import-test-'));
    const projectRoot = path.join(tempRoot, 'project');
    const worktreePath = path.join(tempRoot, 'worktree');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    getGitCommonDirectoryMock
      .mockResolvedValueOnce(path.join(tempRoot, 'project-git'))
      .mockResolvedValueOnce(path.join(tempRoot, 'worktree-git'));

    try {
      await expect(importExistingWorktreeTask(projectRoot, worktreePath, 'main')).rejects.toThrow(
        'different git repository',
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
