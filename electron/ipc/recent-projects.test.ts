import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverProjects,
  getRecentProjectPaths,
  resetDiscoveredProjectsCacheForTests,
} from './recent-projects.js';

const tempDirs: string[] = [];

afterEach(async () => {
  resetDiscoveredProjectsCacheForTests();
  await removeTempDirs();
});

async function removeTempDirs(): Promise<void> {
  const dirsToRemove = tempDirs.splice(0);
  await Promise.all(
    dirsToRemove.map((dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true })),
  );
}

async function createPlainDir(parentDir: string, name: string): Promise<string> {
  const dirPath = path.join(parentDir, name);
  await fs.promises.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function createClaudeProjectSession(homeDir: string, cwdPath: string): Promise<void> {
  // The encoded directory name is intentionally unresolvable so the cwd-from-jsonl fallback runs.
  const projectDir = path.join(homeDir, '.claude', 'projects', `proj-${path.basename(cwdPath)}`);
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectDir, 'session.jsonl'),
    `${JSON.stringify({ cwd: cwdPath })}\n`,
  );
}

async function createCodexSession(homeDir: string, cwdPath: string): Promise<void> {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(sessionsDir, `rollout-${path.basename(cwdPath)}.jsonl`),
    `${JSON.stringify({ cwd: cwdPath })}\n`,
  );
}

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

describe('discoverProjects', () => {
  it('tags discovered projects with their source (claude, codex, git)', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const claudeProject = await createPlainDir(homeDir, 'claude-app');
    const codexProject = await createPlainDir(homeDir, 'codex-app');
    const gitProject = await createGitProject(homeDir, 'git-app');
    await createClaudeProjectSession(homeDir, claudeProject);
    await createCodexSession(homeDir, codexProject);

    const discovered = await discoverProjects(homeDir, homeDir);
    const bySource = new Map(discovered.map((candidate) => [candidate.path, candidate]));

    expect(bySource.get(claudeProject)?.source).toBe('claude');
    expect(bySource.get(codexProject)?.source).toBe('codex');
    expect(bySource.get(gitProject)?.source).toBe('git');
    // Names are path basenames so the UI can render them directly.
    expect(bySource.get(claudeProject)?.name).toBe('claude-app');
  });

  it('dedupes a path seen by multiple sources, preferring agent activity over a bare checkout', async () => {
    const homeDir = await createTempDir('parallel-home-');
    // A git repo that is ALSO a recent Codex cwd.
    const sharedProject = await createGitProject(homeDir, 'shared-app');
    await createCodexSession(homeDir, sharedProject);

    const discovered = await discoverProjects(homeDir, homeDir);
    const matches = discovered.filter((candidate) => candidate.path === sharedProject);

    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('codex');
  });

  it('caches results within the TTL and recomputes on force or after expiry', async () => {
    const homeDir = await createTempDir('parallel-home-');
    await createGitProject(homeDir, 'first-app');

    const first = await discoverProjects(homeDir, homeDir, { nowMs: 1_000 });
    expect(first.map((candidate) => candidate.name)).toContain('first-app');

    // Add a second repo, then read again inside the TTL window; should serve the stale cache.
    await createGitProject(homeDir, 'second-app');
    const cached = await discoverProjects(homeDir, homeDir, { nowMs: 5_000 });
    expect(cached.map((candidate) => candidate.name)).not.toContain('second-app');

    // force bypasses the cache...
    const forced = await discoverProjects(homeDir, homeDir, { nowMs: 5_000, force: true });
    expect(forced.map((candidate) => candidate.name)).toContain('second-app');

    // ...as does crossing the TTL boundary.
    await createGitProject(homeDir, 'third-app');
    const afterTtl = await discoverProjects(homeDir, homeDir, { nowMs: 5_000 + 60_001 });
    expect(afterTtl.map((candidate) => candidate.name)).toContain('third-app');
  });

  it('lets forced discovery bypass an in-flight cached discovery', async () => {
    const homeDir = await createTempDir('parallel-home-');
    await createGitProject(homeDir, 'first-app');

    const cachedDiscovery = discoverProjects(homeDir, homeDir, { nowMs: 1_000 });
    const forcedDiscovery = discoverProjects(homeDir, homeDir, { force: true, nowMs: 2_000 });

    await Promise.all([cachedDiscovery, forcedDiscovery]);

    await createGitProject(homeDir, 'late-app');
    const stillCachedFromForcedDiscovery = await discoverProjects(homeDir, homeDir, {
      nowMs: 61_500,
    });

    expect(stillCachedFromForcedDiscovery.map((candidate) => candidate.name)).not.toContain(
      'late-app',
    );
  });

  it('collapses a repo discovered from a subdirectory to its git root', async () => {
    const homeDir = await createTempDir('parallel-home-');
    const repo = await createGitProject(homeDir, 'mono');
    const subdir = await createPlainDir(repo, 'packages');
    const nested = await createPlainDir(subdir, 'app');
    // Codex ran from a nested subdirectory; Claude from the repo root.
    await createCodexSession(homeDir, nested);
    await createClaudeProjectSession(homeDir, repo);

    const discovered = await discoverProjects(homeDir, homeDir);

    expect(discovered.filter((candidate) => candidate.path === repo)).toHaveLength(1);
    expect(discovered.some((candidate) => candidate.path === nested)).toBe(false);
  });
});
