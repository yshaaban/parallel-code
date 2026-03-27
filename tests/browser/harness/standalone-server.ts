import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBrowserServerBuildArtifactsAreFresh } from '../../../server/build-artifacts.js';
import type { AgentDef } from '../../../src/ipc/types.js';
import type { PersistedState, Project, WorkspaceSharedState } from '../../../src/store/types.js';
import type { BrowserLabScenario } from './scenarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BROWSER_SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist-server', 'server', 'main.js');
const STANDALONE_SERVER_START_TIMEOUT_MS = 20_000;
const STANDALONE_SERVER_STOP_TIMEOUT_MS = 5_000;
const STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS = 8_192;

export interface BrowserLabServer {
  agentId: string;
  authToken: string;
  baseUrl: string;
  getLifecycleSnapshot: () => BrowserLabServerLifecycleSnapshot;
  port: number;
  projectId: string;
  repoDir: string;
  stop: () => Promise<void>;
  taskId: string;
  testDir: string;
  userDataPath: string;
}

export interface BrowserLabServerLifecycleSnapshot {
  exitCode: number | null;
  exitObserved: boolean;
  exitedAtMs: number | null;
  pid: number;
  signalCode: NodeJS.Signals | null;
  startedAtMs: number;
  stderrTail: string;
  stdoutTail: string;
  unexpectedExit: boolean;
}

interface StartStandaloneBrowserServerOptions {
  rootDir?: string;
  scenario: BrowserLabScenario;
  testSlug: string;
  validateBrowserBuildArtifacts?: boolean;
}

export interface SeededBrowserState {
  agentId: string;
  branchName: string;
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
  branchName: string,
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
        branchName,
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
  branchName: string,
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
        branchName,
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
  await assertBrowserServerBuildArtifactsAreFresh({
    projectRoot: PROJECT_ROOT,
    serverEntryPath: BROWSER_SERVER_ENTRY,
  });
}

export function getStandaloneStateDir(userDataPath: string): string {
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

function getCurrentBranchName(repoDir: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
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

export async function seedBrowserState(
  parentDir: string,
  scenario: BrowserLabScenario,
): Promise<SeededBrowserState> {
  const repoDir = await createSeedRepo(parentDir);
  await scenario.seedRepo?.(repoDir);
  const userDataPath = path.join(parentDir, 'user-data');
  const stateDir = getStandaloneStateDir(userDataPath);
  const projectId = 'project-browser-lab';
  const taskId = 'task-browser-lab';
  const agentId = 'agent-browser-lab';
  const project = createProject(projectId, repoDir);
  const branchName = getCurrentBranchName(repoDir);
  const legacyState = createLegacyState(
    project,
    taskId,
    agentId,
    scenario.taskName,
    scenario.agentDef,
    branchName,
  );
  const workspaceState = createWorkspaceState(
    project,
    taskId,
    agentId,
    scenario.taskName,
    scenario.agentDef,
    branchName,
  );

  await writeSeededStateFiles(stateDir, legacyState, workspaceState);

  return {
    agentId,
    branchName,
    projectId,
    repoDir,
    taskId,
    userDataPath,
  };
}

async function waitForServerReady(
  process: ChildProcessWithoutNullStreams,
): Promise<{ baseUrl: string; port: number }> {
  return new Promise<{ baseUrl: string; port: number }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the standalone browser server to start'));
    }, STANDALONE_SERVER_START_TIMEOUT_MS);
    let stdoutText = '';
    let stderrText = '';

    function cleanup(): void {
      clearTimeout(timeout);
      process.stdout.off('data', handleStdout);
      process.stderr.off('data', handleStderr);
      process.off('exit', handleExit);
    }

    function handleStdout(chunk: Buffer): void {
      stdoutText = appendStandaloneServerOutput(stdoutText, chunk.toString());
      const ready = parseStandaloneServerReadyOutput(stdoutText);
      if (!ready) {
        return;
      }

      cleanup();
      resolve(ready);
    }

    function handleStderr(chunk: Buffer): void {
      stderrText += chunk.toString();
    }

    function handleExit(code: number | null): void {
      cleanup();
      const stderrSummary = stderrText.trim();
      reject(
        new Error(
          stderrSummary
            ? `Standalone browser server exited early with code ${code ?? 'null'}: ${stderrSummary}`
            : `Standalone browser server exited early with code ${code ?? 'null'}`,
        ),
      );
    }

    process.stdout.on('data', handleStdout);
    process.stderr.on('data', handleStderr);
    process.on('exit', handleExit);
  });
}

function appendStandaloneServerOutput(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS) {
    return next;
  }

  return next.slice(-STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS);
}

function createInitialLifecycleSnapshot(
  process: ChildProcessWithoutNullStreams,
): BrowserLabServerLifecycleSnapshot {
  return {
    exitCode: null,
    exitObserved: false,
    exitedAtMs: null,
    pid: process.pid ?? -1,
    signalCode: null,
    startedAtMs: Date.now(),
    stderrTail: '',
    stdoutTail: '',
    unexpectedExit: false,
  };
}

export function parseStandaloneServerReadyOutput(
  output: string,
): { baseUrl: string; port: number } | null {
  const lines = output.split(/\r?\n/u);
  const completedLineCount = output.endsWith('\n') ? lines.length : lines.length - 1;
  for (const line of lines.slice(0, completedLineCount)) {
    const match = line.match(/^Parallel Code server listening on (https?:\/\/\S+)$/u);
    if (!match) {
      continue;
    }

    const url = new URL(match[1]);
    const port = Number(url.port);
    if (!url.port || !Number.isInteger(port) || port <= 0) {
      throw new Error(`Failed to parse standalone browser server port from ${match[1]}`);
    }

    return {
      baseUrl: `${url.protocol}//${url.host}`,
      port,
    };
  }

  return null;
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
  if (options.validateBrowserBuildArtifacts !== false) {
    await assertStandaloneBuildExists();
  }

  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : await mkdtemp(
        path.join(os.tmpdir(), `parallel-code-browser-lab-${createTestSlug(options.testSlug)}-`),
      );
  const testDir = path.join(rootDir, createTestSlug(options.testSlug));
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });

  let serverProcess: ChildProcessWithoutNullStreams | null = null;
  try {
    const seededState = await seedBrowserState(testDir, options.scenario);
    const authToken = `browser-lab-token-${randomUUID()}`;
    const skipBrowserBuildArtifactCheck = options.validateBrowserBuildArtifacts === false;
    serverProcess = spawn(process.execPath, [BROWSER_SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AUTH_TOKEN: authToken,
        PARALLEL_CODE_USER_DATA_DIR: seededState.userDataPath,
        ...(skipBrowserBuildArtifactCheck
          ? { PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1' }
          : {}),
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lifecycleSnapshot = createInitialLifecycleSnapshot(serverProcess);
    let stopRequested = false;
    const handleServerStdout = (chunk: Buffer): void => {
      lifecycleSnapshot.stdoutTail = appendStandaloneServerOutput(
        lifecycleSnapshot.stdoutTail,
        chunk.toString(),
      );
    };
    const handleServerStderr = (chunk: Buffer): void => {
      lifecycleSnapshot.stderrTail = appendStandaloneServerOutput(
        lifecycleSnapshot.stderrTail,
        chunk.toString(),
      );
    };
    const handleServerExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      lifecycleSnapshot.exitObserved = true;
      lifecycleSnapshot.exitCode = code;
      lifecycleSnapshot.signalCode = signal;
      lifecycleSnapshot.exitedAtMs = Date.now();
      lifecycleSnapshot.unexpectedExit = !stopRequested;
    };
    serverProcess.stdout.on('data', handleServerStdout);
    serverProcess.stderr.on('data', handleServerStderr);
    serverProcess.once('exit', handleServerExit);

    const ready = await waitForServerReady(serverProcess);

    return {
      agentId: seededState.agentId,
      authToken,
      baseUrl: ready.baseUrl,
      getLifecycleSnapshot: () => ({ ...lifecycleSnapshot }),
      port: ready.port,
      projectId: seededState.projectId,
      repoDir: seededState.repoDir,
      taskId: seededState.taskId,
      testDir,
      userDataPath: seededState.userDataPath,
      stop: async () => {
        if (serverProcess) {
          stopRequested = true;
          await stopStandaloneProcess(serverProcess);
        }
        await rm(testDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (serverProcess) {
      await stopStandaloneProcess(serverProcess);
    }
    await rm(testDir, { recursive: true, force: true });
    throw error;
  }
}
