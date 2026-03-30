import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getRecentProjectPaths } from './recent-projects.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

async function createGitProject(parentDir: string, projectName: string): Promise<string> {
  const projectPath = path.join(parentDir, projectName);
  await fs.promises.mkdir(path.join(projectPath, '.git'), { recursive: true });
  return projectPath;
}

describe('getRecentProjectPaths', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it('includes git repositories from the configured project base directory', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const workspaceDir = await createTempDir('parallel-workspace-');
    const workspaceProject = await createGitProject(workspaceDir, 'repo-from-workspace');

    const recentProjects = await getRecentProjectPaths(homeDir, workspaceDir);

    expect(recentProjects).toContain(workspaceProject);
  });

  it('includes nested git repositories from the configured project base directory', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const workspaceDir = await createTempDir('parallel-workspace-');
    const nestedParentDir = path.join(workspaceDir, 'org');
    await fs.promises.mkdir(nestedParentDir, { recursive: true });
    const nestedWorkspaceProject = await createGitProject(nestedParentDir, 'repo-from-nested-org');

    const recentProjects = await getRecentProjectPaths(homeDir, workspaceDir);

    expect(recentProjects).toContain(nestedWorkspaceProject);
  });

  it('includes the configured project base itself when it is a git repository', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const workspaceDir = await createTempDir('parallel-workspace-');
    await fs.promises.mkdir(path.join(workspaceDir, '.git'), { recursive: true });

    const recentProjects = await getRecentProjectPaths(homeDir, workspaceDir);

    expect(recentProjects).toContain(workspaceDir);
  });

  it('does not recursively scan the home directory when no dedicated project base is configured', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const nestedParentDir = path.join(homeDir, 'nested', 'org');
    await fs.promises.mkdir(nestedParentDir, { recursive: true });
    const nestedHomeProject = await createGitProject(nestedParentDir, 'repo-from-home-tree');

    const recentProjects = await getRecentProjectPaths(homeDir);

    expect(recentProjects).not.toContain(nestedHomeProject);
  });
});
