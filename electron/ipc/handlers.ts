import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from './channels.js';
import {
  spawnAgent as spawnPtyAgent,
  detachAgentOutput,
  writeToAgent,
  resizeAgent,
  pauseAgent,
  resumeAgent,
  killAgent,
  countRunningAgents,
  killAllAgents,
  getAgentMeta,
  getActiveAgentIds,
} from './pty.js';
import { ensurePlansDirectory, startPlanWatcher } from './plans.js';
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
  commitAll,
  discardUncommitted,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
  createWorktree,
  removeWorktree,
} from './git.js';
import { createTask, deleteTask } from './tasks.js';
import { listAgents } from './agents.js';
import {
  loadAppStateForEnv,
  loadArenaDataForEnv,
  saveAppStateForEnv,
  saveArenaDataForEnv,
  type StorageEnv,
} from './storage.js';
import {
  assertBoolean,
  assertInt,
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';

type HandlerArgs = Record<string, unknown> | undefined;

export type IpcHandler = (args?: HandlerArgs) => Promise<unknown> | unknown;

export interface RemoteAccessStartResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  connectedClients: number;
  url?: string;
  wifiUrl?: string | null;
  tailscaleUrl?: string | null;
  token?: string;
  port?: number;
}

export interface RemoteAccessController {
  start: (args: {
    port?: number;
    getTaskName: (taskId: string) => string;
    getAgentStatus: (agentId: string) => {
      status: 'running' | 'exited';
      exitCode: number | null;
      lastLine: string;
    };
  }) => Promise<RemoteAccessStartResult>;
  stop: () => Promise<void>;
  status: () => RemoteAccessStatus;
}

export interface WindowController {
  isFocused: () => boolean;
  isMaximized: () => boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  forceClose: () => void;
  hide: () => void;
  maximize: () => void;
  unmaximize: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  getPosition: () => { x: number; y: number };
  getSize: () => { width: number; height: number };
}

export interface DialogController {
  confirm: (args: {
    message: string;
    title?: string;
    kind?: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  open: (args?: { directory?: boolean; multiple?: boolean }) => Promise<string | string[] | null>;
}

export interface ShellController {
  reveal: (filePath: string) => void;
  openFile: (worktreePath: string, filePath: string) => Promise<string | undefined>;
  openInEditor: (editorCommand: string, worktreePath: string) => Promise<void>;
}

export interface HandlerContext extends StorageEnv {
  sendToChannel: (channelId: string, msg: unknown) => void;
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  remoteAccess?: RemoteAccessController;
  window?: WindowController;
  dialog?: DialogController;
  shell?: ShellController;
}

/** Reject paths that are non-absolute or attempt directory traversal. */
function validatePath(p: unknown, label: string): asserts p is string {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject relative paths that attempt directory traversal or are absolute. */
function validateRelativePath(p: unknown, label: string): asserts p is string {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (path.isAbsolute(p)) throw new Error(`${label} must not be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject branch names that could be misinterpreted as git flags. */
function validateBranchName(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || !name) throw new Error(`${label} must be a non-empty string`);
  if (name.startsWith('-')) throw new Error(`${label} must not start with "-"`);
}

function getHomeDirectory(): string {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || '/';
}

function hasTraversalSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/).some((segment) => segment === '..');
}

function resolveUserPath(inputPath: string): string {
  const home = getHomeDirectory();
  let resolvedPath = inputPath.trim();

  if (resolvedPath === '~' || resolvedPath === '~/') {
    resolvedPath = home;
  } else if (resolvedPath.startsWith('~/')) {
    resolvedPath = path.join(home, resolvedPath.slice(2));
  }

  if (!path.isAbsolute(resolvedPath)) {
    throw new Error('path must be absolute');
  }
  if (hasTraversalSegment(resolvedPath)) {
    throw new Error('path must not contain ".."');
  }

  return path.normalize(resolvedPath);
}

function compareDirectoryNames(a: string, b: string): number {
  const aHidden = a.startsWith('.');
  const bHidden = b.startsWith('.');
  if (aHidden !== bHidden) return aHidden ? 1 : -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function requireWindow(context: HandlerContext): WindowController {
  if (!context.window) throw new Error('Window management is unavailable in this mode');
  return context.window;
}

function requireDialog(context: HandlerContext): DialogController {
  if (!context.dialog) throw new Error('Dialog operations are unavailable in this mode');
  return context.dialog;
}

function requireShell(context: HandlerContext): ShellController {
  if (!context.shell) throw new Error('Shell operations are unavailable in this mode');
  return context.shell;
}

function requireRemoteAccess(context: HandlerContext): RemoteAccessController {
  if (!context.remoteAccess) throw new Error('Remote access is unavailable in this mode');
  return context.remoteAccess;
}

interface RecentProjectCandidate {
  path: string;
  updatedAtMs: number;
}

const MAX_RECENT_PROJECTS = 10;
const MAX_CODEX_SESSION_FILES = 200;
const SHALLOW_GIT_SCAN_DIRS = ['projects', 'code', 'repos', 'src', 'work', 'dev'];

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

function normalizeAbsolutePath(candidatePath: string): string | null {
  if (typeof candidatePath !== 'string') return null;
  const trimmed = candidatePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || hasTraversalSegment(trimmed)) {
    return null;
  }
  return path.normalize(trimmed);
}

async function resolveExistingDirectory(candidatePath: string | null): Promise<string | null> {
  const normalizedPath = normalizeAbsolutePath(candidatePath ?? '');
  if (!normalizedPath) return null;
  const stats = await statIfExists(normalizedPath);
  return stats?.isDirectory() ? normalizedPath : null;
}

function sortRecentProjects(a: RecentProjectCandidate, b: RecentProjectCandidate): number {
  return b.updatedAtMs - a.updatedAtMs || a.path.localeCompare(b.path);
}

function dedupeRecentProjects(candidates: RecentProjectCandidate[]): RecentProjectCandidate[] {
  const byPath = new Map<string, RecentProjectCandidate>();
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.path);
    if (!existing || candidate.updatedAtMs > existing.updatedAtMs) {
      byPath.set(candidate.path, candidate);
    }
  }
  return [...byPath.values()].sort(sortRecentProjects);
}

// Claude project dir names are filesystem path slugs. Resolve them against the real
// filesystem so segments like "admin-frontend" stay intact, then fall back to JSONL cwd metadata.
function decodeClaudeProjectPath(encodedName: string): string | null {
  if (!encodedName.startsWith('-')) return null;

  const tokens = encodedName.slice(1).split('-');
  const memo = new Map<string, string[] | null>();

  function walk(basePath: string, index: number): string[] | null {
    const cacheKey = `${basePath}\u0000${index}`;
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;
    if (index >= tokens.length) return [];

    const startsWithDot = tokens[index] === '';
    const startIndex = startsWithDot ? index + 1 : index;
    if (startIndex >= tokens.length) {
      memo.set(cacheKey, null);
      return null;
    }

    for (let end = tokens.length; end > startIndex; end -= 1) {
      const parts = tokens.slice(startIndex, end);
      if (parts.some((part) => part === '')) continue;

      const segment = `${startsWithDot ? '.' : ''}${parts.join('-')}`;
      const candidatePath = path.join(basePath, segment);

      try {
        if (!fs.statSync(candidatePath).isDirectory()) continue;
      } catch {
        continue;
      }

      const remainder = walk(candidatePath, end);
      if (remainder) {
        const resolved = [segment, ...remainder];
        memo.set(cacheKey, resolved);
        return resolved;
      }
    }

    memo.set(cacheKey, null);
    return null;
  }

  const segments = walk(path.sep, 0);
  return segments ? path.join(path.sep, ...segments) : null;
}

async function readFileHead(filePath: string, maxBytes = 32_768): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function extractCwdFromJsonlHead(filePath: string): Promise<string | null> {
  try {
    const head = await readFileHead(filePath);
    const lines = head.split(/\r?\n/).filter((line) => line.trim().length > 0);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          cwd?: unknown;
          payload?: { cwd?: unknown } | null;
        };
        if (typeof parsed.cwd === 'string') return parsed.cwd;
        if (typeof parsed.payload?.cwd === 'string') return parsed.payload.cwd;
      } catch {
        // Ignore malformed or truncated lines and continue scanning the file head.
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveClaudeProjectDir(
  projectDirPath: string,
  encodedName: string,
): Promise<string | null> {
  const decodedPath = await resolveExistingDirectory(decodeClaudeProjectPath(encodedName));
  if (decodedPath) return decodedPath;

  try {
    const entries = await fs.promises.readdir(projectDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const cwd = await extractCwdFromJsonlHead(path.join(projectDirPath, entry.name));
      const resolvedPath = await resolveExistingDirectory(cwd);
      if (resolvedPath) return resolvedPath;
    }
  } catch {
    return null;
  }

  return null;
}

async function collectClaudeRecentProjects(homeDir: string): Promise<RecentProjectCandidate[]> {
  const projectsRoot = path.join(homeDir, '.claude', 'projects');
  const projectRootStats = await statIfExists(projectsRoot);
  if (!projectRootStats?.isDirectory()) return [];

  const entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const projectDirPath = path.join(projectsRoot, entry.name);
        const projectDirStats = await statIfExists(projectDirPath);
        if (!projectDirStats?.isDirectory()) return null;

        const projectPath = await resolveClaudeProjectDir(projectDirPath, entry.name);
        if (!projectPath) return null;

        return {
          path: projectPath,
          updatedAtMs: projectDirStats.mtimeMs,
        } satisfies RecentProjectCandidate;
      }),
  );

  return dedupeRecentProjects(
    candidates.filter((candidate): candidate is RecentProjectCandidate => candidate !== null),
  );
}

async function collectNewestJsonlFiles(
  rootDir: string,
  limit = MAX_CODEX_SESSION_FILES,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    if (files.length >= limit) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

    for (const entry of entries) {
      if (files.length >= limit) return;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function collectCodexRecentProjects(homeDir: string): Promise<RecentProjectCandidate[]> {
  const sessionRoots = [
    path.join(homeDir, '.codex', 'sessions'),
    path.join(homeDir, '.local', 'share', 'codex', 'sessions'),
  ];

  const candidates: RecentProjectCandidate[] = [];
  for (const sessionsRoot of sessionRoots) {
    const sessionFiles = await collectNewestJsonlFiles(sessionsRoot);
    for (const sessionFile of sessionFiles) {
      const sessionStats = await statIfExists(sessionFile);
      if (!sessionStats?.isFile()) continue;

      const projectPath = await resolveExistingDirectory(
        await extractCwdFromJsonlHead(sessionFile),
      );
      if (!projectPath) continue;

      candidates.push({
        path: projectPath,
        updatedAtMs: sessionStats.mtimeMs,
      });
    }
  }

  return dedupeRecentProjects(candidates);
}

async function collectGitRecentProjects(homeDir: string): Promise<RecentProjectCandidate[]> {
  const scanRoots = [
    homeDir,
    ...SHALLOW_GIT_SCAN_DIRS.map((dirName) => path.join(homeDir, dirName)),
  ];
  const uniqueScanRoots = [...new Set(scanRoots.map((dirPath) => path.normalize(dirPath)))];
  const candidates: RecentProjectCandidate[] = [];

  for (const scanRoot of uniqueScanRoots) {
    const scanRootStats = await statIfExists(scanRoot);
    if (!scanRootStats?.isDirectory()) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(scanRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const repoPath = path.join(scanRoot, entry.name);
      const gitPath = path.join(repoPath, '.git');
      const gitStats = await statIfExists(gitPath);
      if (!gitStats || (!gitStats.isDirectory() && !gitStats.isFile())) continue;

      const resolvedRepoPath = await resolveExistingDirectory(repoPath);
      if (!resolvedRepoPath) continue;

      candidates.push({
        path: resolvedRepoPath,
        updatedAtMs: gitStats.mtimeMs,
      });
    }
  }

  return dedupeRecentProjects(candidates);
}

function getAgentStatus(agentId: string): {
  status: 'running' | 'exited';
  exitCode: number | null;
  lastLine: string;
} {
  const meta = getAgentMeta(agentId);
  return {
    status: meta ? 'running' : 'exited',
    exitCode: null,
    lastLine: '',
  };
}

export function createIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  const taskNames = new Map<string, string>();

  function syncTaskNamesFromJson(json: string): void {
    try {
      const state = JSON.parse(json) as { tasks?: Record<string, { id: string; name: string }> };
      if (!state.tasks) return;
      for (const task of Object.values(state.tasks)) {
        if (task.id && task.name) taskNames.set(task.id, task.name);
      }
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  return {
    [IPC.WindowFocus]: () => null,
    [IPC.WindowBlur]: () => null,
    [IPC.WindowResized]: () => null,
    [IPC.WindowMoved]: () => null,
    [IPC.WindowCloseRequested]: () => null,
    [IPC.PlanContent]: () => null,

    [IPC.SpawnAgent]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertString(request.agentId, 'agentId');
      assertStringArray(request.args, 'args');
      if (request.cwd !== undefined) validatePath(request.cwd, 'cwd');
      const onOutput = request.onOutput as { __CHANNEL_ID__?: unknown } | undefined;
      if (typeof onOutput?.__CHANNEL_ID__ !== 'string') {
        throw new Error('onOutput.__CHANNEL_ID__ must be a string');
      }

      if (!request.isShell && request.cwd) {
        try {
          ensurePlansDirectory(request.cwd);
        } catch (error) {
          console.warn('Failed to set up plans directory:', error);
        }
      }

      const result = spawnPtyAgent(context.sendToChannel, {
        taskId: request.taskId,
        agentId: request.agentId,
        command: typeof request.command === 'string' ? request.command : '',
        args: request.args,
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env:
          request.env && typeof request.env === 'object'
            ? Object.fromEntries(
                Object.entries(request.env).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              )
            : {},
        cols: typeof request.cols === 'number' ? request.cols : 80,
        rows: typeof request.rows === 'number' ? request.rows : 24,
        isShell: request.isShell === true,
        onOutput: { __CHANNEL_ID__: onOutput.__CHANNEL_ID__ },
      });

      if (!request.isShell && request.cwd) {
        try {
          startPlanWatcher(request.taskId, request.cwd, (message) => {
            context.emitIpcEvent?.(IPC.PlanContent, message);
          });
        } catch (error) {
          console.warn('Failed to start plan watcher:', error);
        }
      }

      return result;
    },

    [IPC.WriteToAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      return writeToAgent(request.agentId, request.data);
    },

    [IPC.DetachAgentOutput]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.channelId, 'channelId');
      return detachAgentOutput(request.agentId, request.channelId);
    },

    [IPC.ResizeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
      return resizeAgent(request.agentId, request.cols, request.rows);
    },

    [IPC.PauseAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return pauseAgent(request.agentId);
    },

    [IPC.ResumeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return resumeAgent(request.agentId);
    },

    [IPC.KillAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return killAgent(request.agentId);
    },

    [IPC.CountRunningAgents]: () => countRunningAgents(),
    [IPC.KillAllAgents]: () => killAllAgents(),
    [IPC.ListAgents]: () => listAgents(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),

    [IPC.CreateTask]: async (args) => {
      const request = args ?? {};
      assertString(request.name, 'name');
      validatePath(request.projectRoot, 'projectRoot');
      assertStringArray(request.symlinkDirs, 'symlinkDirs');
      assertOptionalString(request.branchPrefix, 'branchPrefix');
      const result = await createTask(
        request.name,
        request.projectRoot,
        request.symlinkDirs,
        request.branchPrefix ?? 'task',
      );
      taskNames.set(result.id, request.name);
      return result;
    },

    [IPC.DeleteTask]: (args) => {
      const request = args ?? {};
      assertStringArray(request.agentIds, 'agentIds');
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.deleteBranch, 'deleteBranch');
      return deleteTask(
        request.agentIds,
        request.branchName,
        request.deleteBranch,
        request.projectRoot,
      );
    },

    [IPC.GetChangedFiles]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getChangedFiles(request.worktreePath);
    },

    [IPC.GetChangedFilesFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return getChangedFilesFromBranch(request.projectRoot, request.branchName);
    },

    [IPC.GetFileDiff]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiff(request.worktreePath, request.filePath);
    },

    [IPC.GetFileDiffFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiffFromBranch(request.projectRoot, request.branchName, request.filePath);
    },

    [IPC.GetGitignoredDirs]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getGitIgnoredDirs(request.projectRoot);
    },

    [IPC.GetWorktreeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getWorktreeStatus(request.worktreePath);
    },

    [IPC.CommitAll]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.message, 'message');
      return commitAll(request.worktreePath, request.message);
    },

    [IPC.DiscardUncommitted]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return discardUncommitted(request.worktreePath);
    },

    [IPC.CheckMergeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return checkMergeStatus(request.worktreePath);
    },

    [IPC.MergeTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.squash, 'squash');
      assertOptionalString(request.message, 'message');
      assertOptionalBoolean(request.cleanup, 'cleanup');
      return mergeTask(
        request.projectRoot,
        request.branchName,
        request.squash,
        request.message ?? null,
        request.cleanup ?? false,
      );
    },

    [IPC.GetBranchLog]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getBranchLog(request.worktreePath);
    },

    [IPC.PushTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return pushTask(request.projectRoot, request.branchName);
    },

    [IPC.RebaseTask]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return rebaseTask(request.worktreePath);
    },

    [IPC.GetMainBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getMainBranch(request.projectRoot);
    },

    [IPC.GetCurrentBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getCurrentBranch(request.projectRoot);
    },

    [IPC.SaveAppState]: (args) => {
      const request = args ?? {};
      assertString(request.json, 'json');
      assertOptionalString(request.sourceId, 'sourceId');
      syncTaskNamesFromJson(request.json);
      const result = saveAppStateForEnv(context, request.json);
      context.emitIpcEvent?.(IPC.SaveAppState, {
        sourceId: request.sourceId ?? null,
        savedAt: Date.now(),
      });
      return result;
    },

    [IPC.LoadAppState]: () => {
      const json = loadAppStateForEnv(context);
      if (json) syncTaskNamesFromJson(json);
      return json;
    },

    [IPC.SaveArenaData]: (args) => {
      const request = args ?? {};
      assertString(request.filename, 'filename');
      assertString(request.json, 'json');
      return saveArenaDataForEnv(context, request.filename, request.json);
    },

    [IPC.LoadArenaData]: (args) => {
      const request = args ?? {};
      assertString(request.filename, 'filename');
      return loadArenaDataForEnv(context, request.filename);
    },

    [IPC.CreateArenaWorktree]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      if (request.symlinkDirs !== undefined) assertStringArray(request.symlinkDirs, 'symlinkDirs');
      return createWorktree(
        request.projectRoot,
        request.branchName,
        request.symlinkDirs ?? [],
        true,
      );
    },

    [IPC.RemoveArenaWorktree]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return removeWorktree(request.projectRoot, request.branchName, true);
    },

    [IPC.CheckPathExists]: (args) => {
      const request = args ?? {};
      validatePath(request.path, 'path');
      return fs.existsSync(request.path);
    },

    [IPC.ListDirectory]: async (args) => {
      const request = args ?? {};
      assertString(request.path, 'path');
      const dirPath = resolveUserPath(request.path);

      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(dirPath);
      } catch (error) {
        throw new Error(`Directory not found: ${dirPath} (${getErrorMessage(error)})`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${dirPath}`);
      }

      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(compareDirectoryNames);
      } catch (error) {
        throw new Error(`Unable to read directory: ${dirPath} (${getErrorMessage(error)})`);
      }
    },

    [IPC.GetHomePath]: () => {
      return getHomeDirectory();
    },

    [IPC.GetRecentProjects]: async () => {
      const homeDir = getHomeDirectory();
      const [claudeProjects, codexProjects, gitProjects] = await Promise.all([
        collectClaudeRecentProjects(homeDir).catch(() => []),
        collectCodexRecentProjects(homeDir).catch(() => []),
        collectGitRecentProjects(homeDir).catch(() => []),
      ]);

      const primaryProjects = dedupeRecentProjects([...claudeProjects, ...codexProjects]);
      const combinedPaths = primaryProjects
        .slice(0, MAX_RECENT_PROJECTS)
        .map((candidate) => candidate.path);

      if (combinedPaths.length >= MAX_RECENT_PROJECTS) {
        return combinedPaths;
      }

      const seenPaths = new Set(combinedPaths);
      for (const candidate of gitProjects) {
        if (combinedPaths.length >= MAX_RECENT_PROJECTS) break;
        if (seenPaths.has(candidate.path)) continue;
        combinedPaths.push(candidate.path);
        seenPaths.add(candidate.path);
      }

      return combinedPaths;
    },

    [IPC.WindowIsFocused]: () => requireWindow(context).isFocused(),
    [IPC.WindowIsMaximized]: () => requireWindow(context).isMaximized(),
    [IPC.WindowMinimize]: () => requireWindow(context).minimize(),
    [IPC.WindowToggleMaximize]: () => requireWindow(context).toggleMaximize(),
    [IPC.WindowClose]: () => requireWindow(context).close(),
    [IPC.WindowForceClose]: () => requireWindow(context).forceClose(),
    [IPC.WindowHide]: () => requireWindow(context).hide(),
    [IPC.WindowMaximize]: () => requireWindow(context).maximize(),
    [IPC.WindowUnmaximize]: () => requireWindow(context).unmaximize(),
    [IPC.WindowSetSize]: (args) => {
      const request = args ?? {};
      assertInt(request.width, 'width');
      assertInt(request.height, 'height');
      return requireWindow(context).setSize(request.width, request.height);
    },
    [IPC.WindowSetPosition]: (args) => {
      const request = args ?? {};
      assertInt(request.x, 'x');
      assertInt(request.y, 'y');
      return requireWindow(context).setPosition(request.x, request.y);
    },
    [IPC.WindowGetPosition]: () => requireWindow(context).getPosition(),
    [IPC.WindowGetSize]: () => requireWindow(context).getSize(),

    [IPC.DialogConfirm]: async (args) => {
      const request = (args ?? {}) as {
        message?: unknown;
        title?: unknown;
        kind?: unknown;
        okLabel?: unknown;
        cancelLabel?: unknown;
      };
      assertString(request.message, 'message');
      if (request.title !== undefined) assertString(request.title, 'title');
      if (request.kind !== undefined) assertString(request.kind, 'kind');
      if (request.okLabel !== undefined) assertString(request.okLabel, 'okLabel');
      if (request.cancelLabel !== undefined) assertString(request.cancelLabel, 'cancelLabel');
      return requireDialog(context).confirm({
        message: request.message,
        title: request.title,
        kind: request.kind,
        okLabel: request.okLabel,
        cancelLabel: request.cancelLabel,
      });
    },

    [IPC.DialogOpen]: async (args) => {
      const request = (args ?? {}) as { directory?: unknown; multiple?: unknown };
      if (request.directory !== undefined) assertBoolean(request.directory, 'directory');
      if (request.multiple !== undefined) assertBoolean(request.multiple, 'multiple');
      return requireDialog(context).open({
        directory: request.directory as boolean | undefined,
        multiple: request.multiple as boolean | undefined,
      });
    },

    [IPC.ShellReveal]: (args) => {
      const request = args ?? {};
      validatePath(request.filePath, 'filePath');
      return requireShell(context).reveal(request.filePath);
    },

    [IPC.ShellOpenFile]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return requireShell(context).openFile(request.worktreePath, request.filePath);
    },

    [IPC.ShellOpenInEditor]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      if (typeof request.editorCommand !== 'string' || !request.editorCommand.trim()) {
        throw new Error('editorCommand must be a non-empty string');
      }
      const cmd = request.editorCommand.trim();
      if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(cmd)) {
        throw new Error('editorCommand must not contain shell metacharacters');
      }
      return requireShell(context).openInEditor(cmd, request.worktreePath);
    },

    [IPC.StartRemoteServer]: async (args) => {
      const request = (args ?? {}) as { port?: unknown };
      if (request.port !== undefined) assertInt(request.port, 'port');
      return requireRemoteAccess(context).start({
        port: request.port as number | undefined,
        getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
        getAgentStatus,
      });
    },

    [IPC.StopRemoteServer]: async () => requireRemoteAccess(context).stop(),
    [IPC.GetRemoteStatus]: () => requireRemoteAccess(context).status(),
  };
}
