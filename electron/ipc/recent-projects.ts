import fs from 'fs';
import path from 'path';
import { resolveExistingDirectory, statIfExists } from './path-utils.js';

interface RecentProjectCandidate {
  path: string;
  updatedAtMs: number;
}

const MAX_RECENT_PROJECTS = 10;
const MAX_CODEX_SESSION_FILES = 200;
const SHALLOW_GIT_SCAN_DIRS = ['projects', 'code', 'repos', 'src', 'work', 'dev'];

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

export async function getRecentProjectPaths(homeDir: string): Promise<string[]> {
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
}
