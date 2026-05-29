import fs from 'fs';
import path from 'path';
import type { DiscoveredProject, DiscoveredProjectSource } from '../../src/ipc/types.js';
import { normalizeProjectPathKey } from '../../src/lib/project-path-key.js';
import { resolveExistingDirectory, statIfExists } from './path-utils.js';

export type { DiscoveredProject, DiscoveredProjectSource };

const MAX_RECENT_PROJECTS = 10;
const MAX_DISCOVERED_PROJECTS = 30;
const MAX_CODEX_SESSION_FILES = 200;
const CODEX_HEAD_READ_CONCURRENCY = 24;
const PROJECT_BASE_GIT_SCAN_MAX_DEPTH = 3;
const SHALLOW_GIT_SCAN_DIRS = ['projects', 'code', 'repos', 'src', 'work', 'dev'];
const DISCOVERED_PROJECTS_CACHE_TTL_MS = 60_000;
const REPO_ROOT_LOOKUP_MAX_DEPTH = 12;

// Lower number wins when two sources surface the same path with an equal recency: agent activity
// (Claude/Codex) is a stronger "you work here" signal than a bare git checkout on disk.
const SOURCE_PRIORITY: Record<DiscoveredProjectSource, number> = {
  claude: 0,
  codex: 1,
  git: 2,
};

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
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

function decodeClaudeProjectPath(encodedName: string): string | null {
  if (!encodedName.startsWith('-')) {
    return null;
  }

  const tokens = encodedName.slice(1).split('-');
  const memo = new Map<string, string[] | null>();

  function walk(basePath: string, index: number): string[] | null {
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

      try {
        if (!fs.statSync(candidatePath).isDirectory()) {
          continue;
        }
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
  const decodedPath = await resolveExistingDirectory(decodeClaudeProjectPath(encodedName));
  if (decodedPath) {
    return decodedPath;
  }

  const entries = await readDirectoryEntries(projectDirPath);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const cwd = await extractCwdFromJsonlHead(path.join(projectDirPath, entry.name));
    const resolvedPath = await resolveExistingDirectory(cwd);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

async function collectClaudeRecentProjects(homeDir: string): Promise<DiscoveredProject[]> {
  const projectsRoot = path.join(homeDir, '.claude', 'projects');
  const projectRootStats = await statIfExists(projectsRoot);
  if (!projectRootStats?.isDirectory()) {
    return [];
  }

  const entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<DiscoveredProject | null> => {
        const projectDirPath = path.join(projectsRoot, entry.name);
        const projectDirStats = await statIfExists(projectDirPath);
        if (!projectDirStats?.isDirectory()) {
          return null;
        }

        const projectPath = await resolveClaudeProjectDir(projectDirPath, entry.name);
        if (!projectPath) {
          return null;
        }
        const repoPath = await resolveRepoRootOrSelf(projectPath);

        return {
          path: repoPath,
          name: projectName(repoPath),
          source: 'claude',
          updatedAtMs: projectDirStats.mtimeMs,
        };
      }),
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

  async function walk(dirPath: string): Promise<void> {
    if (files.length >= limit) {
      return;
    }

    const entries = await readDirectoryEntries(dirPath);
    if (entries.length === 0) {
      return;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
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

async function collectCodexRecentProjects(homeDir: string): Promise<DiscoveredProject[]> {
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
        if (!projectPath) {
          return null;
        }
        const repoPath = await resolveRepoRootOrSelf(projectPath);

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

async function collectGitProjectCandidate(repoPath: string): Promise<DiscoveredProject | null> {
  const gitPath = path.join(repoPath, '.git');
  const gitStats = await statIfExists(gitPath);
  if (!gitStats || (!gitStats.isDirectory() && !gitStats.isFile())) {
    return null;
  }

  const resolvedRepoPath = await resolveExistingDirectory(repoPath);
  if (!resolvedRepoPath) {
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
): Promise<DiscoveredProject[]> {
  const scanRootStats = await statIfExists(scanRoot);
  if (!scanRootStats?.isDirectory()) {
    return [];
  }

  const entries = await readDirectoryEntries(scanRoot);

  const candidates: DiscoveredProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const candidate = await collectGitProjectCandidate(path.join(scanRoot, entry.name));
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function collectGitRecentProjectsFromProjectBase(
  projectBaseDir: string,
): Promise<DiscoveredProject[]> {
  const candidates: DiscoveredProject[] = [];
  const seenPaths = new Set<string>();

  async function appendCandidate(candidatePath: string): Promise<boolean> {
    const candidate = await collectGitProjectCandidate(candidatePath);
    if (!candidate || seenPaths.has(candidate.path)) {
      return false;
    }

    seenPaths.add(candidate.path);
    candidates.push(candidate);
    return true;
  }

  async function walk(dirPath: string, remainingDepth: number): Promise<void> {
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

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      await walk(path.join(dirPath, entry.name), remainingDepth - 1);
    }
  }

  await walk(projectBaseDir, PROJECT_BASE_GIT_SCAN_MAX_DEPTH);
  return candidates;
}

async function collectGitRecentProjects(
  homeDir: string,
  projectBaseDir: string,
): Promise<DiscoveredProject[]> {
  const scanRoots = [
    homeDir,
    ...SHALLOW_GIT_SCAN_DIRS.map((dirName) => path.join(homeDir, dirName)),
  ];
  const uniqueScanRoots = [...new Set(scanRoots.map((dirPath) => path.normalize(dirPath)))];
  const shallowCandidates = await Promise.all(
    uniqueScanRoots.map((scanRoot) => collectGitRecentProjectsFromImmediateChildren(scanRoot)),
  );
  const normalizedHomeDir = path.normalize(homeDir);
  const normalizedProjectBaseDir = path.normalize(projectBaseDir);
  let projectBaseCandidates: DiscoveredProject[] = [];
  if (normalizedProjectBaseDir !== normalizedHomeDir) {
    projectBaseCandidates = await collectGitRecentProjectsFromProjectBase(projectBaseDir);
  }

  return dedupeDiscoveredProjects([...shallowCandidates.flat(), ...projectBaseCandidates]);
}

async function computeDiscoveredProjects(
  homeDir: string,
  projectBaseDir: string,
): Promise<DiscoveredProject[]> {
  const [claudeProjects, codexProjects, gitProjects] = await Promise.all([
    collectClaudeRecentProjects(homeDir).catch(() => []),
    collectCodexRecentProjects(homeDir).catch(() => []),
    collectGitRecentProjects(homeDir, projectBaseDir).catch(() => []),
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
