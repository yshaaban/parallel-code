import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { AgentDef } from '../../../src/ipc/types.js';
import type { PersistedState, Project, WorkspaceSharedState } from '../../../src/store/types.js';
import type { BrowserLabScenario } from './scenarios.js';

const BROWSER_SERVER_ENTRY = path.resolve('dist-server', 'server', 'main.js');
const FRONTEND_INDEX = path.resolve('dist', 'index.html');
const REMOTE_INDEX = path.resolve('dist-remote', 'index.html');

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

  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(legacyState), 'utf8');
  await writeFile(
    path.join(stateDir, 'workspace-state.json'),
    JSON.stringify({
      revision: 1,
      state: workspaceState,
    }),
    'utf8',
  );

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
    }, 20_000);

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
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
    }, 5_000);

    process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    process.kill('SIGTERM');
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
