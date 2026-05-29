import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DiscoveredProject, DiscoveredProjectSource } from '../../src/ipc/types.js';
import { normalizeProjectPathKey } from '../../src/lib/project-path-key.js';
import { resolveExistingDirectory, statIfExists } from './path-utils.js';

export type { DiscoveredProject, DiscoveredProjectSource };

const MAX_RECENT_PROJECTS = 10;
const MAX_DISCOVERED_PROJECTS = 30;
const MAX_CODEX_SESSION_FILES = 200;
const CLAUDE_PROJECT_JSONL_SCAN_LIMIT = 16;
const CLAUDE_PROJECT_READ_CONCURRENCY = 16;
const CLAUDE_ENCODED_PATH_LOOKUP_MAX_STATS = 160;
const CODEX_HEAD_READ_CONCURRENCY = 24;
const CODEX_SESSION_WALK_MAX_DEPTH = 8;
const CODEX_SESSION_WALK_MAX_DIRS = 600;
const PROJECT_BASE_GIT_SCAN_MAX_DEPTH = 3;
const PROJECT_BASE_GIT_SCAN_MAX_VISITED_DIRS = 240;
const PROJECT_SCAN_MAX_CHILD_DIRS = 240;
const SHALLOW_GIT_SCAN_DIRS = ['projects', 'code', 'repos', 'src', 'work', 'dev'];
const DISCOVERED_PROJECTS_CACHE_TTL_MS = 60_000;
const REPO_ROOT_LOOKUP_MAX_DEPTH = 12;
const PROJECT_SCAN_SKIP_DIR_NAMES = new Set([
  'build',
  'coverage',
  'dist',
  'dist-remote',
  'dist-server',
  'node_modules',
  'out',
  'target',
  'vendor',
]);
const STATIC_VOLATILE_PROJECT_ROOTS = [
  '/dev/shm',
  '/private/tmp',
  '/private/var/folders',
  '/private/var/tmp',
  '/run/user',
  '/tmp',
  '/var/folders',
  '/var/tmp',
];

// Lower number wins when two sources surface the same path with an equal recency: agent activity
// (Claude/Codex) is a stronger "you work here" signal than a bare git checkout on disk.
const SOURCE_PRIORITY: Record<DiscoveredProjectSource, number> = {
  claude: 0,
  codex: 1,
  git: 2,
};

interface DiscoveryScope {
  allowedRootKeys: string[];
}

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

function normalizePathPrefixKey(projectPath: string): string {
  return normalizeProjectPathKey(projectPath).toLowerCase();
}

function isSamePathOrDescendant(pathKey: string, rootKey: string): boolean {
  if (!rootKey || rootKey === '/') {
    return pathKey === rootKey;
  }

  return pathKey === rootKey || pathKey.startsWith(`${rootKey}/`);
}

function getVolatileProjectRootKeys(): string[] {
  const configuredTempRoots = [os.tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP];
  const roots = [...STATIC_VOLATILE_PROJECT_ROOTS, ...configuredTempRoots].filter(
    (root): root is string => typeof root === 'string' && root.trim().length > 0,
  );
  return [...new Set(roots.map((root) => normalizePathPrefixKey(root)))];
}

function hasWindowsTempSegment(pathKey: string): boolean {
  const wrappedPath = `/${pathKey.replace(/^\/+/u, '')}/`;
  return wrappedPath.includes('/appdata/local/temp/') || wrappedPath.includes('/windows/temp/');
}

export function isVolatileProjectPath(projectPath: string): boolean {
  const pathKey = normalizePathPrefixKey(projectPath);
  if (hasWindowsTempSegment(pathKey)) {
    return true;
  }

  return getVolatileProjectRootKeys().some((rootKey) => isSamePathOrDescendant(pathKey, rootKey));
}

function createDiscoveryScope(homeDir: string, projectBaseDir: string): DiscoveryScope {
  const allowedRoots = [homeDir, projectBaseDir].map((root) => normalizePathPrefixKey(root));
  return {
    allowedRootKeys: [...new Set(allowedRoots)],
  };
}

function isInsideAllowedDiscoveryRoot(projectPath: string, scope: DiscoveryScope): boolean {
  const pathKey = normalizePathPrefixKey(projectPath);
  return scope.allowedRootKeys.some((rootKey) => isSamePathOrDescendant(pathKey, rootKey));
}

function isDiscoverableProjectPath(projectPath: string, scope: DiscoveryScope): boolean {
  return isInsideAllowedDiscoveryRoot(projectPath, scope) && !isVolatileProjectPath(projectPath);
}

function sortDiscoveredProjects(a: DiscoveredProject, b: DiscoveredProject): number {
  return (
    b.updatedAtMs - a.updatedAtMs ||
    SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] ||
    a.path.localeCompare(b.path)
  );
}

function shouldReplaceDiscoveredProject(
  candidate: DiscoveredProject,
  existing: DiscoveredProject | undefined,
): boolean {
  if (!existing) {
    return true;
  }

  if (candidate.updatedAtMs !== existing.updatedAtMs) {
    return candidate.updatedAtMs > existing.updatedAtMs;
  }

  return SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[existing.source];
}

function dedupeDiscoveredProjects(candidates: DiscoveredProject[]): DiscoveredProject[] {
  const byPath = new Map<string, DiscoveredProject>();
  for (const candidate of candidates) {
    const pathKey = normalizeProjectPathKey(candidate.path);
    const existing = byPath.get(pathKey);
    if (shouldReplaceDiscoveredProject(candidate, existing)) {
      byPath.set(pathKey, candidate);
    }
  }
  return [...byPath.values()].sort(sortDiscoveredProjects);
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const entries = items.map((item, index) => [index, item] as const);
  const results = new Array<TResult>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const entry = entries[cursor];
      cursor += 1;
      if (entry === undefined) {
        return;
      }
      const [index, item] = entry;
      results[index] = await mapper(item);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function readDirectoryEntries(dirPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareDirectoryEntryNames(a: fs.Dirent, b: fs.Dirent): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

function compareDirectoryEntryNamesDescending(a: fs.Dirent, b: fs.Dirent): number {
  return b.name.localeCompare(a.name, undefined, { numeric: true });
}

function isProjectScanDirectory(entry: fs.Dirent): boolean {
  return (
    entry.isDirectory() &&
    !entry.name.startsWith('.') &&
    !PROJECT_SCAN_SKIP_DIR_NAMES.has(entry.name.toLowerCase())
  );
}

function getProjectScanDirectories(entries: fs.Dirent[]): fs.Dirent[] {
  return entries
    .filter(isProjectScanDirectory)
    .sort(compareDirectoryEntryNames)
    .slice(0, PROJECT_SCAN_MAX_CHILD_DIRS);
}

function getClaudeProjectSessionFiles(entries: fs.Dirent[]): fs.Dirent[] {
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .sort(compareDirectoryEntryNamesDescending)
    .slice(0, CLAUDE_PROJECT_JSONL_SCAN_LIMIT);
}

// Walk up from a discovered cwd to its git repository root via cheap `.git` stat checks. Snapping
// to the root collapses the same repo discovered from different tools (e.g. Claude at the root,
// Codex from a subdirectory) into a single proposal. Non-repo folders return themselves.
async function resolveRepoRootOrSelf(dirPath: string): Promise<string> {
  let current = dirPath;
  for (let depth = 0; depth <= REPO_ROOT_LOOKUP_MAX_DEPTH; depth += 1) {
    const gitStats = await statIfExists(path.join(current, '.git'));
    if (gitStats && (gitStats.isDirectory() || gitStats.isFile())) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirPath;
}

async function decodeClaudeProjectPath(encodedName: string): Promise<string | null> {
  if (!encodedName.startsWith('-')) {
    return null;
  }

  const tokens = encodedName.slice(1).split('-');
  const memo = new Map<string, string[] | null>();
  let statLookupCount = 0;

  async function walk(basePath: string, index: number): Promise<string[] | null> {
    const cacheKey = JSON.stringify([basePath, index]);
    const cached = memo.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    if (index >= tokens.length) {
      return [];
    }

    const startsWithDot = tokens[index] === '';
    const startIndex = startsWithDot ? index + 1 : index;
    if (startIndex >= tokens.length) {
      memo.set(cacheKey, null);
      return null;
    }

    for (let end = tokens.length; end > startIndex; end -= 1) {
      const parts = tokens.slice(startIndex, end);
      if (parts.some((part) => part === '')) {
        continue;
      }

      const segment = `${startsWithDot ? '.' : ''}${parts.join('-')}`;
      const candidatePath = path.join(basePath, segment);
      if (statLookupCount >= CLAUDE_ENCODED_PATH_LOOKUP_MAX_STATS) {
        memo.set(cacheKey, null);
        return null;
      }

      statLookupCount += 1;
      const stats = await statIfExists(candidatePath);
      if (!stats?.isDirectory()) {
        continue;
      }

      const remainder = await walk(candidatePath, end);
      if (remainder) {
        const resolved = [segment, ...remainder];
        memo.set(cacheKey, resolved);
        return resolved;
      }
    }

    memo.set(cacheKey, null);
    return null;
  }

  const firstToken = tokens[0] ?? '';
  const windowsDriveRoot =
    process.platform === 'win32' && /^[A-Za-z]:$/u.test(firstToken)
      ? `${firstToken}${path.sep}`
      : null;
  const basePath = windowsDriveRoot ?? path.sep;
  const startIndex = windowsDriveRoot ? 1 : 0;
  const segments = await walk(basePath, startIndex);
  if (!segments) {
    return null;
  }

  return path.join(basePath, ...segments);
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
        if (typeof parsed.cwd === 'string') {
          return parsed.cwd;
        }
        if (typeof parsed.payload?.cwd === 'string') {
          return parsed.payload.cwd;
        }
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
  const entries = await readDirectoryEntries(projectDirPath);
  for (const entry of getClaudeProjectSessionFiles(entries)) {
    const cwd = await extractCwdFromJsonlHead(path.join(projectDirPath, entry.name));
    const resolvedPath = await resolveExistingDirectory(cwd);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  const decodedPath = await resolveExistingDirectory(await decodeClaudeProjectPath(encodedName));
  if (decodedPath) {
    return decodedPath;
  }

  return null;
}

async function collectClaudeRecentProjects(
  homeDir: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject[]> {
  const projectsRoot = path.join(homeDir, '.claude', 'projects');
  const projectRootStats = await statIfExists(projectsRoot);
  if (!projectRootStats?.isDirectory()) {
    return [];
  }

  const entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  const projectEntries = entries
    .filter((entry) => entry.isDirectory())
    .sort(compareDirectoryEntryNamesDescending);
  const candidates = await mapWithConcurrency(
    projectEntries,
    CLAUDE_PROJECT_READ_CONCURRENCY,
    async (entry): Promise<DiscoveredProject | null> => {
      const projectDirPath = path.join(projectsRoot, entry.name);
      const projectDirStats = await statIfExists(projectDirPath);
      if (!projectDirStats?.isDirectory()) {
        return null;
      }

      const projectPath = await resolveClaudeProjectDir(projectDirPath, entry.name);
      if (!projectPath || !isDiscoverableProjectPath(projectPath, scope)) {
        return null;
      }

      const repoPath = await resolveRepoRootOrSelf(projectPath);
      if (!isDiscoverableProjectPath(repoPath, scope)) {
        return null;
      }

      return {
        path: repoPath,
        name: projectName(repoPath),
        source: 'claude',
        updatedAtMs: projectDirStats.mtimeMs,
      };
    },
  );

  return dedupeDiscoveredProjects(
    candidates.filter((candidate): candidate is DiscoveredProject => candidate !== null),
  );
}

async function collectNewestJsonlFiles(
  rootDir: string,
  limit = MAX_CODEX_SESSION_FILES,
): Promise<string[]> {
  const files: string[] = [];
  let visitedDirCount = 0;

  async function walk(dirPath: string, remainingDepth: number): Promise<void> {
    if (
      files.length >= limit ||
      remainingDepth < 0 ||
      visitedDirCount >= CODEX_SESSION_WALK_MAX_DIRS
    ) {
      return;
    }

    visitedDirCount += 1;
    const entries = await readDirectoryEntries(dirPath);
    if (entries.length === 0) {
      return;
    }

    entries.sort(compareDirectoryEntryNamesDescending);

    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, remainingDepth - 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir, CODEX_SESSION_WALK_MAX_DEPTH);
  return files;
}

async function collectCodexRecentProjects(
  homeDir: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject[]> {
  const sessionRoots = [
    path.join(homeDir, '.codex', 'sessions'),
    path.join(homeDir, '.local', 'share', 'codex', 'sessions'),
  ];

  const candidates: DiscoveredProject[] = [];
  for (const sessionsRoot of sessionRoots) {
    const sessionFiles = await collectNewestJsonlFiles(sessionsRoot);
    // Read session-file heads concurrently; this is the dominant cost of discovery, and the
    // files are independent, so a bounded pool keeps startup snappy without exhausting FDs.
    const resolved = await mapWithConcurrency(
      sessionFiles,
      CODEX_HEAD_READ_CONCURRENCY,
      async (sessionFile): Promise<DiscoveredProject | null> => {
        const sessionStats = await statIfExists(sessionFile);
        if (!sessionStats?.isFile()) {
          return null;
        }

        const projectPath = await resolveExistingDirectory(
          await extractCwdFromJsonlHead(sessionFile),
        );
        if (!projectPath || !isDiscoverableProjectPath(projectPath, scope)) {
          return null;
        }

        const repoPath = await resolveRepoRootOrSelf(projectPath);
        if (!isDiscoverableProjectPath(repoPath, scope)) {
          return null;
        }

        return {
          path: repoPath,
          name: projectName(repoPath),
          source: 'codex',
          updatedAtMs: sessionStats.mtimeMs,
        };
      },
    );

    for (const candidate of resolved) {
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return dedupeDiscoveredProjects(candidates);
}

async function collectGitProjectCandidate(
  repoPath: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject | null> {
  const gitPath = path.join(repoPath, '.git');
  const gitStats = await statIfExists(gitPath);
  if (!gitStats || (!gitStats.isDirectory() && !gitStats.isFile())) {
    return null;
  }

  const resolvedRepoPath = await resolveExistingDirectory(repoPath);
  if (!resolvedRepoPath) {
    return null;
  }

  if (!isDiscoverableProjectPath(resolvedRepoPath, scope)) {
    return null;
  }

  return {
    path: resolvedRepoPath,
    name: projectName(resolvedRepoPath),
    source: 'git',
    updatedAtMs: gitStats.mtimeMs,
  };
}

async function collectGitRecentProjectsFromImmediateChildren(
  scanRoot: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject[]> {
  if (!isDiscoverableProjectPath(scanRoot, scope)) {
    return [];
  }

  const scanRootStats = await statIfExists(scanRoot);
  if (!scanRootStats?.isDirectory()) {
    return [];
  }

  const entries = await readDirectoryEntries(scanRoot);

  const candidates: DiscoveredProject[] = [];
  for (const entry of getProjectScanDirectories(entries)) {
    const candidate = await collectGitProjectCandidate(path.join(scanRoot, entry.name), scope);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function collectGitRecentProjectsFromProjectBase(
  projectBaseDir: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject[]> {
  if (!isDiscoverableProjectPath(projectBaseDir, scope)) {
    return [];
  }

  const candidates: DiscoveredProject[] = [];
  const seenPaths = new Set<string>();
  let visitedDirCount = 0;

  async function appendCandidate(candidatePath: string): Promise<boolean> {
    const candidate = await collectGitProjectCandidate(candidatePath, scope);
    if (!candidate) {
      return false;
    }

    const candidatePathKey = normalizeProjectPathKey(candidate.path);
    if (seenPaths.has(candidatePathKey)) {
      return false;
    }

    seenPaths.add(candidatePathKey);
    candidates.push(candidate);
    return true;
  }

  async function walk(dirPath: string, remainingDepth: number): Promise<void> {
    if (visitedDirCount >= PROJECT_BASE_GIT_SCAN_MAX_VISITED_DIRS) {
      return;
    }

    visitedDirCount += 1;
    const dirStats = await statIfExists(dirPath);
    if (!dirStats?.isDirectory()) {
      return;
    }

    if (remainingDepth < 0) {
      return;
    }

    if (await appendCandidate(dirPath)) {
      return;
    }

    const entries = await readDirectoryEntries(dirPath);
    if (entries.length === 0) {
      return;
    }

    for (const entry of getProjectScanDirectories(entries)) {
      await walk(path.join(dirPath, entry.name), remainingDepth - 1);
    }
  }

  await walk(projectBaseDir, PROJECT_BASE_GIT_SCAN_MAX_DEPTH);
  return candidates;
}

async function collectGitRecentProjects(
  homeDir: string,
  projectBaseDir: string,
  scope: DiscoveryScope,
): Promise<DiscoveredProject[]> {
  const scanRoots = [
    homeDir,
    ...SHALLOW_GIT_SCAN_DIRS.map((dirName) => path.join(homeDir, dirName)),
  ];
  const uniqueScanRoots = [...new Set(scanRoots.map((dirPath) => path.normalize(dirPath)))];
  const shallowCandidates = await Promise.all(
    uniqueScanRoots.map((scanRoot) =>
      collectGitRecentProjectsFromImmediateChildren(scanRoot, scope),
    ),
  );
  const normalizedHomeDir = path.normalize(homeDir);
  const normalizedProjectBaseDir = path.normalize(projectBaseDir);
  let projectBaseCandidates: DiscoveredProject[] = [];
  if (normalizedProjectBaseDir !== normalizedHomeDir) {
    projectBaseCandidates = await collectGitRecentProjectsFromProjectBase(projectBaseDir, scope);
  }

  return dedupeDiscoveredProjects([...shallowCandidates.flat(), ...projectBaseCandidates]);
}

async function computeDiscoveredProjects(
  homeDir: string,
  projectBaseDir: string,
): Promise<DiscoveredProject[]> {
  const scope = createDiscoveryScope(homeDir, projectBaseDir);
  const [claudeProjects, codexProjects, gitProjects] = await Promise.all([
    collectClaudeRecentProjects(homeDir, scope).catch(() => []),
    collectCodexRecentProjects(homeDir, scope).catch(() => []),
    collectGitRecentProjects(homeDir, projectBaseDir, scope).catch(() => []),
  ]);

  // Claude + Codex (active agent work) lead, sorted by recency; bare git checkouts fill the rest.
  const primaryProjects = dedupeDiscoveredProjects([...claudeProjects, ...codexProjects]);
  const primaryPaths = new Set(
    primaryProjects.map((candidate) => normalizeProjectPathKey(candidate.path)),
  );
  const gitOnlyProjects = gitProjects.filter(
    (candidate) => !primaryPaths.has(normalizeProjectPathKey(candidate.path)),
  );

  return [...primaryProjects, ...gitOnlyProjects].slice(0, MAX_DISCOVERED_PROJECTS);
}

interface DiscoveredProjectsCacheEntry {
  key: string;
  value: DiscoveredProject[];
  computedAtMs: number;
}

let discoveredProjectsCache: DiscoveredProjectsCacheEntry | null = null;
let discoveredProjectsInFlight: { key: string; promise: Promise<DiscoveredProject[]> } | null =
  null;
let discoveredProjectsRequestId = 0;

interface DiscoverProjectsOptions {
  force?: boolean;
  nowMs?: number;
}

/**
 * Discover candidate projects from Claude/Codex agent state and on-disk git repositories.
 * Results are cached per (home, projectBase) with a short TTL and coalesce concurrent callers, so
 * a startup prefetch keeps the add-project proposal instant without re-scanning on every open.
 */
export async function discoverProjects(
  homeDir: string,
  projectBaseDir = homeDir,
  options: DiscoverProjectsOptions = {},
): Promise<DiscoveredProject[]> {
  const key = JSON.stringify([homeDir, projectBaseDir]);
  const nowMs = options.nowMs ?? Date.now();

  if (
    !options.force &&
    discoveredProjectsCache &&
    discoveredProjectsCache.key === key &&
    nowMs - discoveredProjectsCache.computedAtMs < DISCOVERED_PROJECTS_CACHE_TTL_MS
  ) {
    return discoveredProjectsCache.value;
  }

  if (!options.force && discoveredProjectsInFlight && discoveredProjectsInFlight.key === key) {
    return discoveredProjectsInFlight.promise;
  }

  const requestId = ++discoveredProjectsRequestId;
  const promise = computeDiscoveredProjects(homeDir, projectBaseDir)
    .then((value) => {
      if (requestId === discoveredProjectsRequestId) {
        discoveredProjectsCache = { key, value, computedAtMs: nowMs };
      }
      return value;
    })
    .finally(() => {
      if (discoveredProjectsInFlight?.promise === promise) {
        discoveredProjectsInFlight = null;
      }
    });

  discoveredProjectsInFlight = { key, promise };
  return promise;
}

export function resetDiscoveredProjectsCacheForTests(): void {
  discoveredProjectsCache = null;
  discoveredProjectsInFlight = null;
  discoveredProjectsRequestId = 0;
}

export async function getRecentProjectPaths(
  homeDir: string,
  projectBaseDir = homeDir,
): Promise<string[]> {
  const discovered = await discoverProjects(homeDir, projectBaseDir);
  return discovered.slice(0, MAX_RECENT_PROJECTS).map((candidate) => candidate.path);
}
