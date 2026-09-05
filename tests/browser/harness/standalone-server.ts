import { type ChildProcessByStdio, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertBrowserServerBuildArtifactsExist,
  assertBrowserServerBuildArtifactsAreFresh,
  shouldCheckBrowserServerBuildArtifacts,
} from '../../../server/build-artifacts.js';
import { rewriteDistServerRelativeImports } from '../../../server/rewrite-dist-server-relative-imports.mjs';
import { createTestShellEnv } from '../../../src/lib/test-shell-env.js';
import type { AgentDef } from '../../../src/ipc/types.js';
import {
  buildProjectGitIsolationFields,
  buildTaskGitIsolationFields,
} from '../../../src/store/task-git-isolation.js';
import type {
  PersistedState,
  PersistedTask,
  Project,
  TaskGitIsolationMode,
  WorkspaceSharedState,
} from '../../../src/store/types.js';
import type { BrowserLabScenario } from './scenarios.js';
import {
  parseStandaloneServerReadyOutput,
  spawnStandaloneServerProcess,
  stopStandaloneServerProcessWithRetry,
  waitForStandaloneServerReady,
} from '../../../scripts/lib/standalone-server-process.mjs';

export { parseStandaloneServerReadyOutput };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_SERVER_DIR = path.join(PROJECT_ROOT, 'dist-server');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const DIST_REMOTE_DIR = path.join(PROJECT_ROOT, 'dist-remote');
const BROWSER_SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist-server', 'server', 'main.js');
const TASK_NOTES_ENTITLEMENT_ENTRY = path.join(
  PROJECT_ROOT,
  'dist-server',
  'electron',
  'ipc',
  'task-notes-writer-entitlements.js',
);
const STANDALONE_SERVER_START_TIMEOUT_MS = 20_000;
const STANDALONE_SERVER_STOP_TIMEOUT_MS = 5_000;
const STANDALONE_SERVER_FORCE_KILL_SETTLE_MS = 1_000;
const STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS = 8_192;
const STATIC_ARTIFACT_COPY_RETRY_DELAY_MS = 50;
const STATIC_ARTIFACT_COPY_RETRIES = 5;
const BROWSER_LAB_DEFAULT_TASK_GIT_ISOLATION = 'worktree' satisfies TaskGitIsolationMode;

export interface BrowserLabServer {
  agentId: string;
  agentIds: string[];
  authToken: string;
  baseUrl: string;
  getLifecycleSnapshot: () => BrowserLabServerLifecycleSnapshot;
  port: number;
  projectId: string;
  repoDir: string;
  stop: () => Promise<void>;
  taskId: string;
  taskIds: string[];
  testDir: string;
  userDataPath: string;
}

class StandaloneBrowserServerSetupCleanupError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super('Standalone browser server setup and cleanup failed');
    this.name = 'StandaloneBrowserServerSetupCleanupError';
    this.errors = errors;
  }
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
  agentIds: string[];
  branchName: string;
  projectId: string;
  repoDir: string;
  taskId: string;
  taskIds: string[];
  userDataPath: string;
}

interface StaticBrowserArtifactSnapshot {
  distDir: string;
  distRemoteDir: string;
}

type StandaloneBrowserServerProcess = ChildProcessByStdio<null, Readable, Readable>;

function createProject(projectId: string, repoDir: string): Project {
  return {
    id: projectId,
    name: 'Browser Lab Project',
    path: repoDir,
    color: '#2f8fdd',
    baseBranch: 'main',
    branchPrefix: 'browser-lab',
    ...buildProjectGitIsolationFields({
      defaultTaskGitIsolation: BROWSER_LAB_DEFAULT_TASK_GIT_ISOLATION,
    }),
  };
}

function createPersistedBrowserLabTask(
  project: Project,
  taskId: string,
  agentId: string,
  taskName: string,
  agentDef: AgentDef,
  gitLocation: { branchName: string; worktreePath: string },
  taskGitIsolation: TaskGitIsolationMode,
): PersistedTask {
  return {
    id: taskId,
    name: taskName,
    projectId: project.id,
    branchName: gitLocation.branchName,
    worktreePath: gitLocation.worktreePath,
    notes: '',
    lastPrompt: '',
    shellCount: 0,
    agentId,
    shellAgentIds: [],
    agentDef,
    taskMode: 'agent',
    ...buildTaskGitIsolationFields({ gitIsolation: taskGitIsolation }),
  };
}

function createSeededTaskEntries(
  project: Project,
  scenario: BrowserLabScenario,
  branchName: string,
): Array<{ agentId: string; task: PersistedTask; taskId: string }> {
  const taskNames = [scenario.taskName, ...(scenario.additionalTaskNames ?? [])];
  const taskGitIsolation = scenario.taskGitIsolation ?? BROWSER_LAB_DEFAULT_TASK_GIT_ISOLATION;

  return taskNames.map((taskName, index) => {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const taskId = `task-browser-lab${suffix}`;
    const agentId = `agent-browser-lab${suffix}`;

    const gitLocation = scenario.resolveTaskGitLocation?.(project.path, index) ?? {
      branchName,
      worktreePath: project.path,
    };

    return {
      agentId,
      taskId,
      task: createPersistedBrowserLabTask(
        project,
        taskId,
        agentId,
        taskName,
        scenario.agentDef,
        gitLocation,
        taskGitIsolation,
      ),
    };
  });
}

function createLegacyState(
  project: Project,
  taskEntries: Array<{ task: PersistedTask; taskId: string }>,
  agentDef: AgentDef,
  includeCustomAgent: boolean,
): PersistedState {
  const taskOrder = taskEntries.map((entry) => entry.taskId);
  const firstTaskId = taskOrder[0] ?? 'task-browser-lab';

  return {
    projects: [project],
    lastProjectId: project.id,
    lastAgentId: agentDef.id,
    taskOrder,
    collapsedTaskOrder: [],
    tasks: Object.fromEntries(taskEntries.map((entry) => [entry.taskId, entry.task])),
    terminals: {},
    activeTaskId: firstTaskId,
    sidebarVisible: true,
    completedTaskDate: '2026-03-17',
    completedTaskCount: 0,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    customAgents: includeCustomAgent ? [agentDef] : [],
  };
}

function createWorkspaceState(
  project: Project,
  taskEntries: Array<{ task: PersistedTask; taskId: string }>,
  agentDef: AgentDef,
  includeCustomAgent: boolean,
): WorkspaceSharedState {
  const taskOrder = taskEntries.map((entry) => entry.taskId);

  return {
    projects: [project],
    taskOrder,
    collapsedTaskOrder: [],
    tasks: Object.fromEntries(taskEntries.map((entry) => [entry.taskId, entry.task])),
    terminals: {},
    completedTaskDate: '2026-03-17',
    completedTaskCount: 0,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    customAgents: includeCustomAgent ? [agentDef] : [],
  };
}

function getStandaloneBuildArtifactOptions(): {
  projectRoot: string;
  serverEntryPath: string;
} {
  return {
    projectRoot: PROJECT_ROOT,
    serverEntryPath: BROWSER_SERVER_ENTRY,
  };
}

async function assertStandaloneBuildExists(): Promise<void> {
  await assertBrowserServerBuildArtifactsExist(getStandaloneBuildArtifactOptions());
}

async function assertStandaloneBuildArtifactsAreFresh(): Promise<void> {
  await assertBrowserServerBuildArtifactsAreFresh(getStandaloneBuildArtifactOptions());
}

async function ensureStandaloneServerImportsAreRunnable(): Promise<void> {
  const result = await rewriteDistServerRelativeImports({
    distServerDir: DIST_SERVER_DIR,
  });
  if (result.unresolvedEntries.length === 0) {
    return;
  }

  const unresolvedImportLines = result.unresolvedEntries.flatMap((entry) =>
    entry.unresolvedSpecifiers.map(
      (specifier) => `${path.relative(PROJECT_ROOT, entry.filePath)} -> ${specifier}`,
    ),
  );
  throw new Error(
    [
      'Failed to normalize one or more emitted dist-server relative imports before standalone startup.',
      ...unresolvedImportLines,
    ].join('\n'),
  );
}

function taskNotesProofIdentity(writerTrain: 'desktop' | 'remote', seed: number) {
  const digest = (offset: number) => ((seed + offset) % 16).toString(16).repeat(64);
  return {
    artifactDigest: digest(1),
    commandManifestDigest: digest(2),
    dependencyEdgeDigest: digest(3),
    fixtureSeedDigest: digest(4),
    formatVersion: 1,
    proofDigest: digest(5),
    relevantTreeDigest: digest(6),
    sourceManifestDigest: digest(7),
    toolchainDigest: digest(8),
    writerTrain,
  };
}

async function writeTaskNotesTestLauncher(testDir: string): Promise<string> {
  const launcherPath = path.join(testDir, 'task-notes-proof-launcher.mjs');
  const desktop = taskNotesProofIdentity('desktop', 1);
  const remote = taskNotesProofIdentity('remote', 2);
  const source = [
    `import { startConfiguredBrowserServer } from ${JSON.stringify(pathToFileURL(BROWSER_SERVER_ENTRY).href)};`,
    `import { createTaskNotesWriterEntitlements } from ${JSON.stringify(pathToFileURL(TASK_NOTES_ENTITLEMENT_ENTRY).href)};`,
    `const desktop = ${JSON.stringify(desktop)};`,
    `const remote = ${JSON.stringify(remote)};`,
    'await startConfiguredBrowserServer({',
    '  taskNotesWriterEntitlements: createTaskNotesWriterEntitlements({',
    '    desktop: { reportIdentity: desktop, promotionIdentity: desktop },',
    '    remote: { reportIdentity: remote, promotionIdentity: remote },',
    '  }),',
    '});',
    '',
  ].join('\n');
  await writeFile(launcherPath, source, 'utf8');
  return launcherPath;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  const fileStats = await stat(filePath).catch(() => null);
  return Boolean(fileStats?.isFile() && fileStats.size > 0);
}

async function assertNonEmptyFile(filePath: string): Promise<void> {
  if (await isNonEmptyFile(filePath)) {
    return;
  }

  throw new Error(`Expected a non-empty browser artifact at ${filePath}`);
}

async function copyStaticArtifactDirectory(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  await rm(destinationDir, { recursive: true, force: true });
  await mkdir(path.dirname(destinationDir), { recursive: true });
  await cp(sourceDir, destinationDir, { recursive: true });
  await assertNonEmptyFile(path.join(destinationDir, 'index.html'));
}

async function copyStaticBrowserArtifacts(testDir: string): Promise<StaticBrowserArtifactSnapshot> {
  const artifactRootDir = path.join(testDir, 'static-artifacts');
  const snapshot = {
    distDir: path.join(artifactRootDir, 'dist'),
    distRemoteDir: path.join(artifactRootDir, 'dist-remote'),
  };

  for (let attempt = 1; attempt <= STATIC_ARTIFACT_COPY_RETRIES; attempt += 1) {
    try {
      await assertNonEmptyFile(path.join(DIST_DIR, 'index.html'));
      await assertNonEmptyFile(path.join(DIST_REMOTE_DIR, 'index.html'));
      await Promise.all([
        copyStaticArtifactDirectory(DIST_DIR, snapshot.distDir),
        copyStaticArtifactDirectory(DIST_REMOTE_DIR, snapshot.distRemoteDir),
      ]);
      return snapshot;
    } catch (error) {
      if (attempt === STATIC_ARTIFACT_COPY_RETRIES) {
        throw error;
      }

      await delay(STATIC_ARTIFACT_COPY_RETRY_DELAY_MS);
    }
  }

  return snapshot;
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
  const project = createProject(projectId, repoDir);
  const branchName = getCurrentBranchName(repoDir);
  const taskEntries = createSeededTaskEntries(project, scenario, branchName);
  const taskIds = taskEntries.map((entry) => entry.taskId);
  const agentIds = taskEntries.map((entry) => entry.agentId);
  const taskId = taskIds[0] ?? 'task-browser-lab';
  const agentId = agentIds[0] ?? 'agent-browser-lab';
  const includeCustomAgent = scenario.agentCatalogSource !== 'built-in';
  const legacyState = createLegacyState(
    project,
    taskEntries,
    scenario.agentDef,
    includeCustomAgent,
  );
  const workspaceState = createWorkspaceState(
    project,
    taskEntries,
    scenario.agentDef,
    includeCustomAgent,
  );

  await writeSeededStateFiles(stateDir, legacyState, workspaceState);

  return {
    agentId,
    agentIds,
    branchName,
    projectId,
    repoDir,
    taskId,
    taskIds,
    userDataPath,
  };
}

export async function waitForServerReady(
  process: StandaloneBrowserServerProcess,
): Promise<{ baseUrl: string; port: number }> {
  const ready = await waitForStandaloneServerReady(process, {
    outputBufferMaxChars: STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS,
    timeoutMs: STANDALONE_SERVER_START_TIMEOUT_MS,
  });
  return { baseUrl: ready.baseUrl, port: ready.port };
}

function appendStandaloneServerOutput(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS) {
    return next;
  }

  return next.slice(-STANDALONE_SERVER_READY_OUTPUT_BUFFER_MAX_CHARS);
}

function createInitialLifecycleSnapshot(
  process: StandaloneBrowserServerProcess,
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

export function stopStandaloneProcess(process: StandaloneBrowserServerProcess): Promise<void> {
  return stopStandaloneServerProcessWithRetry(process, {
    forceKillAfterMs: STANDALONE_SERVER_STOP_TIMEOUT_MS,
    forceKillSettleMs: STANDALONE_SERVER_FORCE_KILL_SETTLE_MS,
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
  const shouldValidateBrowserBuildArtifacts =
    options.validateBrowserBuildArtifacts ?? shouldCheckBrowserServerBuildArtifacts(process.env);
  await assertStandaloneBuildExists();
  if (shouldValidateBrowserBuildArtifacts) {
    await assertStandaloneBuildArtifactsAreFresh();
  }
  await ensureStandaloneServerImportsAreRunnable();

  const ownsRootDir = options.rootDir === undefined;
  let rootDir: string | null = options.rootDir ? path.resolve(options.rootDir) : null;
  let testDir: string | null = null;
  let serverProcess: StandaloneBrowserServerProcess | null = null;
  try {
    rootDir ??= await mkdtemp(
      path.join(os.tmpdir(), `parallel-code-browser-lab-${createTestSlug(options.testSlug)}-`),
    );
    testDir = path.join(rootDir, createTestSlug(options.testSlug));
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });

    const staticArtifacts = await copyStaticBrowserArtifacts(testDir);
    const seededState = await seedBrowserState(testDir, options.scenario);
    const authToken = `browser-lab-token-${randomUUID()}`;
    const skipBrowserBuildArtifactCheck = options.validateBrowserBuildArtifacts === false;
    const serverLauncher = await writeTaskNotesTestLauncher(testDir);
    serverProcess = spawnStandaloneServerProcess(process.execPath, [serverLauncher], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ...(options.scenario.prependRepoBinToPath
          ? {
              PATH: `${path.join(seededState.repoDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
            }
          : {}),
        AUTH_TOKEN: authToken,
        PARALLEL_CODE_USER_DATA_DIR: seededState.userDataPath,
        ...createTestShellEnv(seededState.userDataPath),
        ...(skipBrowserBuildArtifactCheck
          ? { PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1' }
          : {}),
        PARALLEL_CODE_BROWSER_DIST_DIR: staticArtifacts.distDir,
        PARALLEL_CODE_BROWSER_DIST_REMOTE_DIR: staticArtifacts.distRemoteDir,
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
      agentIds: seededState.agentIds,
      authToken,
      baseUrl: ready.baseUrl,
      getLifecycleSnapshot: () => ({ ...lifecycleSnapshot }),
      port: ready.port,
      projectId: seededState.projectId,
      repoDir: seededState.repoDir,
      taskId: seededState.taskId,
      taskIds: seededState.taskIds,
      testDir,
      userDataPath: seededState.userDataPath,
      stop: async () => {
        if (serverProcess) {
          stopRequested = true;
          await stopStandaloneProcess(serverProcess);
        }
        const cleanupDir = ownsRootDir ? rootDir : testDir;
        if (cleanupDir) {
          await rm(cleanupDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let serverStopped = serverProcess === null;
    if (serverProcess) {
      try {
        await stopStandaloneProcess(serverProcess);
        serverStopped = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const cleanupDir = ownsRootDir ? rootDir : testDir;
    if (serverStopped && cleanupDir) {
      try {
        await rm(cleanupDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new StandaloneBrowserServerSetupCleanupError([error, ...cleanupErrors]);
    }
    throw error;
  }
}
