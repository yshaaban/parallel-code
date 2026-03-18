import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { AgentDef } from '../../../src/ipc/types.js';
import type { PersistedState, Project, WorkspaceSharedState } from '../../../src/store/types.js';
import type { BrowserLabScenario } from './scenarios.js';

const BROWSER_SERVER_ENTRY = path.resolve('dist-server', 'server', 'main.js');
const FRONTEND_INDEX = path.resolve('dist', 'index.html');
const REMOTE_INDEX = path.resolve('dist-remote', 'index.html');
const IGNORED_BUILD_SOURCE_DIRS = new Set([
  '.git',
  '.playwright-browser-lab',
  '.sentrux',
  'dist',
  'dist-remote',
  'dist-server',
  'node_modules',
  'release',
  'test-results',
]);
const IGNORED_BUILD_SOURCE_FILE_PATTERNS = [/\.spec\.[cm]?[jt]sx?$/u, /\.test\.[cm]?[jt]sx?$/u];
const STANDALONE_SERVER_START_TIMEOUT_MS = 20_000;
const STANDALONE_SERVER_STOP_TIMEOUT_MS = 5_000;

export interface BrowserLabServer {
  agentId: string;
  authToken: string;
  baseUrl: string;
  port: number;
  projectId: string;
  repoDir: string;
  stop: () => Promise<void>;
  taskId: string;
  testDir: string;
  userDataPath: string;
}

interface StartStandaloneBrowserServerOptions {
  rootDir?: string;
  scenario: BrowserLabScenario;
  testSlug: string;
}

interface SeededBrowserState {
  agentId: string;
  projectId: string;
  repoDir: string;
  taskId: string;
  userDataPath: string;
}

function createProject(projectId: string, repoDir: string): Project {
  return {
    id: projectId,
    name: 'Browser Lab Project',
    path: repoDir,
    color: '#2f8fdd',
    baseBranch: 'main',
    branchPrefix: 'browser-lab',
  };
}

function createLegacyState(
  project: Project,
  taskId: string,
  agentId: string,
  taskName: string,
  agentDef: AgentDef,
): PersistedState {
  return {
    projects: [project],
    lastProjectId: project.id,
    lastAgentId: agentDef.id,
    taskOrder: [taskId],
    collapsedTaskOrder: [],
    tasks: {
      [taskId]: {
        id: taskId,
        name: taskName,
        projectId: project.id,
        branchName: 'browser-lab/e2e',
        worktreePath: project.path,
        notes: '',
        lastPrompt: '',
        shellCount: 0,
        agentId,
        shellAgentIds: [],
        agentDef,
      },
    },
    terminals: {},
    activeTaskId: taskId,
    sidebarVisible: true,
    completedTaskDate: '2026-03-17',
    completedTaskCount: 0,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    customAgents: [agentDef],
  };
}

function createWorkspaceState(
  project: Project,
  taskId: string,
  agentId: string,
  taskName: string,
  agentDef: AgentDef,
): WorkspaceSharedState {
  return {
    projects: [project],
    taskOrder: [taskId],
    collapsedTaskOrder: [],
    tasks: {
      [taskId]: {
        id: taskId,
        name: taskName,
        projectId: project.id,
        branchName: 'browser-lab/e2e',
        worktreePath: project.path,
        notes: '',
        lastPrompt: '',
        shellCount: 0,
        agentId,
        shellAgentIds: [],
        agentDef,
      },
    },
    terminals: {},
    completedTaskDate: '2026-03-17',
    completedTaskCount: 0,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    customAgents: [agentDef],
  };
}

async function assertStandaloneBuildExists(): Promise<void> {
  await Promise.all([
    access(BROWSER_SERVER_ENTRY),
    access(FRONTEND_INDEX),
    access(REMOTE_INDEX),
  ]).catch(() => {
    throw new Error(
      'Standalone browser build artifacts are missing. Run `npm run build:frontend && npm run build:remote && npm run build:server` before Playwright tests.',
    );
  });

  await Promise.all([
    assertBuildArtifactIsFresh(
      FRONTEND_INDEX,
      ['src', 'electron', 'package.json', 'tsconfig.json'],
      'frontend',
    ),
    assertBuildArtifactIsFresh(REMOTE_INDEX, ['src/remote', 'package.json'], 'remote'),
    assertBuildArtifactIsFresh(
      BROWSER_SERVER_ENTRY,
      ['server', 'electron', 'src/ipc', 'src/domain', 'package.json', 'tsconfig.json'],
      'server',
    ),
  ]);
}

async function assertBuildArtifactIsFresh(
  buildArtifactPath: string,
  sourcePaths: readonly string[],
  label: 'frontend' | 'remote' | 'server',
): Promise<void> {
  const [buildArtifactStats, latestSourceFile] = await Promise.all([
    stat(buildArtifactPath),
    getLatestSourceFile(sourcePaths.map((entry) => path.resolve(entry))),
  ]);

  if (!latestSourceFile || latestSourceFile.mtimeMs <= buildArtifactStats.mtimeMs) {
    return;
  }

  throw new Error(
    [
      `Standalone ${label} build artifact is stale.`,
      `Newest source: ${path.relative(process.cwd(), latestSourceFile.filePath)}`,
      `Built artifact: ${path.relative(process.cwd(), buildArtifactPath)}`,
      'Run `npm run build:frontend && npm run build:remote && npm run build:server` before Playwright tests.',
    ].join(' '),
  );
}

async function getLatestSourceFile(
  sourcePaths: readonly string[],
): Promise<{ filePath: string; mtimeMs: number } | null> {
  let latestFile: { filePath: string; mtimeMs: number } | null = null;

  for (const sourcePath of sourcePaths) {
    const candidate = await getLatestSourceFileEntry(sourcePath);
    if (!candidate) {
      continue;
    }

    if (!latestFile || candidate.mtimeMs > latestFile.mtimeMs) {
      latestFile = candidate;
    }
  }

  return latestFile;
}

async function getLatestSourceFileEntry(
  sourcePath: string,
): Promise<{ filePath: string; mtimeMs: number } | null> {
  const stats = await stat(sourcePath).catch(() => null);
  if (!stats) {
    return null;
  }

  if (stats.isFile()) {
    if (shouldIgnoreBuildSourceFile(sourcePath)) {
      return null;
    }

    return { filePath: sourcePath, mtimeMs: stats.mtimeMs };
  }

  if (!stats.isDirectory()) {
    return null;
  }

  let latestFile: { filePath: string; mtimeMs: number } | null = null;
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreBuildSourceEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(sourcePath, entry.name);
    let candidate: { filePath: string; mtimeMs: number } | null = null;
    if (entry.isDirectory()) {
      candidate = await getLatestSourceFileEntry(entryPath);
    } else if (!shouldIgnoreBuildSourceFile(entryPath)) {
      candidate = await getLatestSourceFileEntry(entryPath);
    }
    if (!candidate) {
      continue;
    }

    if (!latestFile || candidate.mtimeMs > latestFile.mtimeMs) {
      latestFile = candidate;
    }
  }

  return latestFile;
}

function shouldIgnoreBuildSourceEntry(entryName: string): boolean {
  return IGNORED_BUILD_SOURCE_DIRS.has(entryName);
}

function shouldIgnoreBuildSourceFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/gu, '/');
  return IGNORED_BUILD_SOURCE_FILE_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve a standalone browser-lab port')));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function getStandaloneStateDir(userDataPath: string): string {
  return `${userDataPath}-dev`;
}

async function createSeedRepo(parentDir: string): Promise<string> {
  const repoDir = path.join(parentDir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# Browser Lab Fixture\n', 'utf8');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Browser Lab'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'browser-lab@example.com'], { cwd: repoDir });
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'browser lab seed'], { cwd: repoDir });
  return repoDir;
}

async function writeSeededStateFiles(
  stateDir: string,
  legacyState: PersistedState,
  workspaceState: WorkspaceSharedState,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(stateDir, 'state.json'), JSON.stringify(legacyState), 'utf8'),
    writeFile(
      path.join(stateDir, 'workspace-state.json'),
      JSON.stringify({
        revision: 1,
        state: workspaceState,
      }),
      'utf8',
    ),
  ]);
}

async function seedBrowserState(
  parentDir: string,
  scenario: BrowserLabScenario,
): Promise<SeededBrowserState> {
  const repoDir = await createSeedRepo(parentDir);
  const userDataPath = path.join(parentDir, 'user-data');
  const stateDir = getStandaloneStateDir(userDataPath);
  const projectId = 'project-browser-lab';
  const taskId = 'task-browser-lab';
  const agentId = 'agent-browser-lab';
  const project = createProject(projectId, repoDir);
  const legacyState = createLegacyState(
    project,
    taskId,
    agentId,
    scenario.taskName,
    scenario.agentDef,
  );
  const workspaceState = createWorkspaceState(
    project,
    taskId,
    agentId,
    scenario.taskName,
    scenario.agentDef,
  );

  await writeSeededStateFiles(stateDir, legacyState, workspaceState);

  return {
    agentId,
    projectId,
    repoDir,
    taskId,
    userDataPath,
  };
}

async function waitForServerReady(process: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for the standalone browser server to start'));
    }, STANDALONE_SERVER_START_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeout);
      process.stdout.off('data', handleStdout);
      process.off('exit', handleExit);
    }

    function handleStdout(chunk: Buffer): void {
      const text = chunk.toString();
      if (text.includes('Parallel Code server listening on')) {
        cleanup();
        resolve();
      }
    }

    function handleExit(code: number | null): void {
      cleanup();
      reject(new Error(`Standalone browser server exited early with code ${code ?? 'null'}`));
    }

    process.stdout.on('data', handleStdout);
    process.on('exit', handleExit);
  });
}

function stopStandaloneProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      process.off('exit', finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL');
      }
    }, STANDALONE_SERVER_STOP_TIMEOUT_MS);

    process.once('exit', finish);
    const signaled = process.kill('SIGTERM');
    if (!signaled) {
      finish();
    }
  });
}

function createTestSlug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/giu, '-')
      .replace(/(^-|-$)/gu, '')
      .slice(0, 60) || 'browser-lab'
  );
}

export async function startStandaloneBrowserServer(
  options: StartStandaloneBrowserServerOptions,
): Promise<BrowserLabServer> {
  await assertStandaloneBuildExists();

  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : await mkdtemp(
        path.join(os.tmpdir(), `parallel-code-browser-lab-${createTestSlug(options.testSlug)}-`),
      );
  const testDir = path.join(rootDir, createTestSlug(options.testSlug));
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });

  const seededState = await seedBrowserState(testDir, options.scenario);
  const authToken = `browser-lab-token-${randomUUID()}`;
  const port = await reservePort();
  const serverProcess = spawn(process.execPath, [BROWSER_SERVER_ENTRY], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      AUTH_TOKEN: authToken,
      PARALLEL_CODE_USER_DATA_DIR: seededState.userDataPath,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServerReady(serverProcess);

  return {
    agentId: seededState.agentId,
    authToken,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    projectId: seededState.projectId,
    repoDir: seededState.repoDir,
    taskId: seededState.taskId,
    testDir,
    userDataPath: seededState.userDataPath,
    stop: async () => {
      await stopStandaloneProcess(serverProcess);
      await rm(testDir, { recursive: true, force: true });
    },
  };
}
