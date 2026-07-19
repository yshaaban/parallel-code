import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

  it('passes the selected base branch into managed worktree creation', async () => {
    createWorktreeMock.mockResolvedValue({
      branch: 'task/test',
      path: '/tmp/project/.worktrees/task/test',
    });

    const result = await createTask('Test', '/tmp/project', [], 'task', 'release/main');

    expect(createWorktreeMock).toHaveBeenCalledWith(
      '/tmp/project',
      'task/test',
      [],
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

  it('does not retry branch ref prefix conflicts', async () => {
    createWorktreeMock.mockRejectedValue(
      new Error(
        'Cannot create branch "feature/test" because local branch "feature" already uses that ref path.',
      ),
    );

    await expect(createTask('Test', '/tmp/project', [], 'feature')).rejects.toThrow(
      'Cannot create branch "feature/test"',
    );
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

  it('uses the pre-checkout branch when the project root is already on the base branch', async () => {
    getCurrentBranchMock.mockResolvedValue('main');

    await expect(createCurrentBranchTask('/tmp/project')).resolves.toMatchObject({
      base_branch: 'main',
      branch_name: 'main',
      worktree_path: '/tmp/project',
    });

    expect(getCurrentBranchMock).toHaveBeenCalledOnce();
    expect(checkoutBranchMock).not.toHaveBeenCalled();
  });

  it('returns the resolved base branch without a fallible read after checkout', async () => {
    getCurrentBranchMock.mockResolvedValue('feature/old');
    checkoutBranchMock.mockResolvedValue(undefined);

    await expect(createCurrentBranchTask('/tmp/project')).resolves.toMatchObject({
      base_branch: 'main',
      branch_name: 'main',
      worktree_path: '/tmp/project',
    });

    expect(getCurrentBranchMock).toHaveBeenCalledOnce();
    expect(checkoutBranchMock).toHaveBeenCalledWith('/tmp/project', 'main');
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
