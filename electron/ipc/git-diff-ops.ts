import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  getChangedFileStatusCategory,
  type ChangedFileStatus,
} from '../../src/domain/git-status.js';
import { isBinaryDiff } from '../../src/lib/diff-parser.js';
import { detectMainBranch } from './git-branch.js';
import { looksBinaryBuffer } from './git-binary.js';
import {
  cacheKey,
  getCachedMergeBase,
  MAX_BUFFER,
  setCachedMergeBase,
  withGitQueryCache,
} from './git-cache.js';
import { normalizeStatusPath, parseDiffRawNumstat, parseNumstat } from './git-status-parser.js';
import { worktreeExists } from './git-worktree.js';
import type { FileDiffResult, GitChangedFile, ProjectDiffResult } from './git-types.js';
import { NotFoundError } from './errors.js';

const exec = promisify(execFile);

async function detectMergeBase(repoRoot: string, head?: string): Promise<string> {
  const cached = getCachedMergeBase(repoRoot);
  if (cached) return cached;

  const mainBranch = await detectMainBranch(repoRoot);
  let result: string;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, head ?? 'HEAD'], {
      cwd: repoRoot,
    });
    const hash = stdout.trim();
    result = hash || mainBranch;
  } catch {
    result = mainBranch;
  }

  setCachedMergeBase(repoRoot, result);
  return result;
}

async function pinHead(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return 'HEAD';
  }
}

async function resolveRevisionHash(cwd: string, revision: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', revision], { cwd });
    return stdout.trim() || revision;
  } catch {
    return revision;
  }
}

function toDiffLines(content: string): string[] {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

function buildPseudoDiff(
  content: string,
  options: {
    hunkHeader: (lineCount: number) => string;
    linePrefix: '+' | '-';
    newHeader: string;
    oldHeader: string;
  },
): string {
  const lines = toDiffLines(content);
  const header = `${options.oldHeader}\n${options.newHeader}\n${options.hunkHeader(lines.length)}\n`;
  if (lines.length === 0) {
    return header;
  }

  const body = lines.map((line) => `${options.linePrefix}${line}`).join('\n');
  return `${header}${body}\n`;
}

async function execGitStdout(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

async function readGitTextFile(
  cwd: string,
  revision: string,
  filePath: string,
): Promise<{ content: string; exists: boolean }> {
  try {
    const { stdout } = await exec('git', ['show', `${revision}:${filePath}`], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return {
      content: stdout,
      exists: true,
    };
  } catch {
    return {
      content: '',
      exists: false,
    };
  }
}

async function getPathFingerprint(filePath: string): Promise<string> {
  try {
    const stats = await fs.promises.stat(filePath);
    return `${stats.isFile() ? 'file' : 'other'}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function createAddedPseudoDiff(filePath: string, newContent: string): string {
  return buildPseudoDiff(newContent, {
    hunkHeader(lineCount) {
      return `@@ -0,0 +1,${lineCount} @@`;
    },
    linePrefix: '+',
    newHeader: `+++ b/${filePath}`,
    oldHeader: '--- /dev/null',
  });
}

function createDeletedPseudoDiff(filePath: string, oldContent: string): string {
  return buildPseudoDiff(oldContent, {
    hunkHeader(lineCount) {
      return `@@ -1,${lineCount} +0,0 @@`;
    },
    linePrefix: '-',
    newHeader: '+++ /dev/null',
    oldHeader: `--- a/${filePath}`,
  });
}

function collectNormalizedPaths(stdout: string, getRawPath: (line: string) => string): Set<string> {
  const normalizedPaths = new Set<string>();
  for (const line of stdout.split('\n')) {
    const normalizedPath = normalizeStatusPath(getRawPath(line));
    if (normalizedPath) {
      normalizedPaths.add(normalizedPath);
    }
  }
  return normalizedPaths;
}

async function listUntrackedPaths(worktreePath: string): Promise<Set<string>> {
  const stdout = await execGitStdout(worktreePath, ['ls-files', '--others', '--exclude-standard']);
  return collectNormalizedPaths(stdout, (line) => line);
}

async function listConflictPaths(worktreePath: string): Promise<Set<string>> {
  const stdout = await execGitStdout(worktreePath, ['ls-files', '-u']);
  return collectNormalizedPaths(stdout, (line) => line.split('\t').pop() ?? '');
}

async function detectWorktreeFileStatus(
  worktreePath: string,
  filePath: string,
): Promise<ChangedFileStatus | undefined> {
  const trackedDiff = await execGitStdout(worktreePath, [
    'diff',
    '--raw',
    '--numstat',
    'HEAD',
    '--',
    filePath,
  ]);
  const { statusMap } = parseDiffRawNumstat(trackedDiff);
  const trackedStatus = statusMap.get(filePath);
  if (trackedStatus) {
    return trackedStatus;
  }

  const untrackedPaths = await listUntrackedPaths(worktreePath);
  if (untrackedPaths.has(filePath)) {
    return '?';
  }

  return undefined;
}

function getChangedFileCounts(
  numstatMap: ReadonlyMap<string, [number, number]>,
  filePath: string,
): [number, number] {
  return numstatMap.get(filePath) ?? [0, 0];
}

function getChangedFileCacheKey(
  prefix: string,
  repositoryPath: string,
  revision: string,
  filePath: string,
  cacheToken: string,
  status?: ChangedFileStatus,
): string {
  return `${prefix}:${cacheKey(repositoryPath)}:${revision}:${filePath}:${status ?? 'auto'}:${cacheToken}`;
}

function createChangedFile(
  filePath: string,
  status: ChangedFileStatus,
  counts: [number, number],
  committed: boolean,
): GitChangedFile {
  const [lines_added, lines_removed] = counts;
  return {
    path: filePath,
    lines_added,
    lines_removed,
    status,
    committed,
  };
}

async function readTextFileIfSafe(
  filePath: string,
): Promise<{ content: string; exists: boolean; isBinary: boolean; readable: boolean }> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return { content: '', exists: false, isBinary: false, readable: false };
    }

    if (stats.size >= MAX_BUFFER) {
      return { content: '', exists: true, isBinary: false, readable: false };
    }

    const buffer = await fs.promises.readFile(filePath);
    if (looksBinaryBuffer(buffer)) {
      return { content: '', exists: true, isBinary: true, readable: false };
    }

    return {
      content: buffer.toString('utf8'),
      exists: true,
      isBinary: false,
      readable: true,
    };
  } catch {
    return { content: '', exists: false, isBinary: false, readable: false };
  }
}

function createBinaryDiffMarker(
  filePath: string,
  options: { fileExistsOnDisk: boolean; hasHistoricVersion: boolean },
): string {
  if (!options.hasHistoricVersion) {
    return `Binary files /dev/null and b/${filePath} differ`;
  }

  if (!options.fileExistsOnDisk) {
    return `Binary files a/${filePath} and /dev/null differ`;
  }

  return `Binary files a/${filePath} and b/${filePath} differ`;
}

export async function getChangedFiles(worktreePath: string): Promise<GitChangedFile[]> {
  return withGitQueryCache(`changed-files:${cacheKey(worktreePath)}`, async () => {
    if (!(await worktreeExists(worktreePath))) {
      throw new NotFoundError(`Worktree not found: ${worktreePath}`);
    }

    const headHash = await pinHead(worktreePath);
    const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);
    const [committedDiff, trackedUncommittedDiff, untrackedPaths, conflictPaths] =
      await Promise.all([
        execGitStdout(worktreePath, ['diff', '--raw', '--numstat', base, headHash]),
        execGitStdout(worktreePath, ['diff', '--raw', '--numstat', 'HEAD']),
        listUntrackedPaths(worktreePath),
        listConflictPaths(worktreePath),
      ]);

    const { statusMap: committedStatusMap, numstatMap: committedNumstatMap } =
      parseDiffRawNumstat(committedDiff);
    const { statusMap: uncommittedStatusMap, numstatMap: uncommittedNumstatMap } =
      parseDiffRawNumstat(trackedUncommittedDiff);

    const files: GitChangedFile[] = [];
    const seen = new Set<string>();

    for (const filePath of new Set([...committedStatusMap.keys(), ...committedNumstatMap.keys()])) {
      const [added, removed] = getChangedFileCounts(committedNumstatMap, filePath);
      const status = conflictPaths.has(filePath) ? 'U' : (committedStatusMap.get(filePath) ?? 'M');
      const committed = !uncommittedStatusMap.has(filePath) && !untrackedPaths.has(filePath);
      seen.add(filePath);
      files.push(createChangedFile(filePath, status, [added, removed], committed));
    }

    for (const filePath of new Set([
      ...uncommittedStatusMap.keys(),
      ...uncommittedNumstatMap.keys(),
    ])) {
      if (seen.has(filePath)) continue;
      if (untrackedPaths.has(filePath)) continue;
      const [added, removed] = getChangedFileCounts(uncommittedNumstatMap, filePath);
      files.push(
        createChangedFile(
          filePath,
          conflictPaths.has(filePath) ? 'U' : (uncommittedStatusMap.get(filePath) ?? 'M'),
          [added, removed],
          false,
        ),
      );
    }

    const untrackedFiles = await Promise.all(
      [...untrackedPaths].map(async (filePath) => {
        const fullPath = path.join(worktreePath, filePath);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (!stat.isFile()) {
            return null;
          }

          let added = 0;
          if (stat.size < MAX_BUFFER) {
            const buffer = await fs.promises.readFile(fullPath);
            if (!looksBinaryBuffer(buffer)) {
              const content = buffer.toString('utf8');
              const lines = content.split('\n');
              added = content.endsWith('\n') ? lines.length - 1 : lines.length;
            }
          }

          return createChangedFile(filePath, '?', [added, 0], false);
        } catch {
          return null;
        }
      }),
    );

    for (const file of untrackedFiles) {
      if (file) {
        files.push(file);
      }
    }

    files.sort((a, b) => {
      if (a.committed !== b.committed) return a.committed ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return files;
  });
}

interface GetFileDiffOptions {
  status?: ChangedFileStatus;
}

async function getTrackedFileDiff(
  worktreePath: string,
  headHash: string,
  filePath: string,
): Promise<FileDiffResult> {
  const fullPath = path.join(worktreePath, filePath);
  const [workingTreeDiff, headFile, diskFile] = await Promise.all([
    execGitStdout(worktreePath, ['diff', 'HEAD', '--', filePath]),
    readGitTextFile(worktreePath, headHash, filePath),
    readTextFileIfSafe(fullPath),
  ]);

  if (isBinaryDiff(workingTreeDiff) || diskFile.isBinary) {
    return {
      diff:
        workingTreeDiff.trim() ||
        createBinaryDiffMarker(filePath, {
          fileExistsOnDisk: diskFile.exists,
          hasHistoricVersion: headFile.exists,
        }),
      oldContent: '',
      newContent: '',
    };
  }

  const oldContent = headFile.content;
  const newContent = diskFile.exists && diskFile.readable ? diskFile.content : '';
  let diff = workingTreeDiff.trim();

  if (!diff && !headFile.exists && diskFile.readable) {
    diff = createAddedPseudoDiff(filePath, diskFile.content);
  }

  if (!diff && headFile.exists && !diskFile.exists) {
    diff = createDeletedPseudoDiff(filePath, headFile.content);
  }

  return { diff, oldContent, newContent };
}

function createBinaryFileDiffResult(
  filePath: string,
  options: { fileExistsOnDisk: boolean; hasHistoricVersion: boolean },
  diff: string,
  fallbackDiff?: string,
): FileDiffResult {
  return {
    diff: diff.trim() || fallbackDiff || createBinaryDiffMarker(filePath, options),
    oldContent: '',
    newContent: '',
  };
}

async function getAddedFileDiff(worktreePath: string, filePath: string): Promise<FileDiffResult> {
  const fullPath = path.join(worktreePath, filePath);
  const diskFile = await readTextFileIfSafe(fullPath);
  if (diskFile.isBinary) {
    return createBinaryFileDiffResult(
      filePath,
      {
        fileExistsOnDisk: diskFile.exists,
        hasHistoricVersion: false,
      },
      '',
    );
  }

  const newContent = diskFile.readable ? diskFile.content : '';
  return {
    diff: diskFile.readable ? createAddedPseudoDiff(filePath, diskFile.content) : '',
    oldContent: '',
    newContent,
  };
}

async function getDeletedFileDiff(
  worktreePath: string,
  headHash: string,
  filePath: string,
): Promise<FileDiffResult> {
  const [workingTreeDiff, headFile] = await Promise.all([
    execGitStdout(worktreePath, ['diff', 'HEAD', '--', filePath]),
    readGitTextFile(worktreePath, headHash, filePath),
  ]);

  if (isBinaryDiff(workingTreeDiff)) {
    return createBinaryFileDiffResult(
      filePath,
      {
        fileExistsOnDisk: false,
        hasHistoricVersion: headFile.exists,
      },
      workingTreeDiff,
    );
  }

  const oldContent = headFile.content;
  return {
    diff: workingTreeDiff.trim() || createDeletedPseudoDiff(filePath, oldContent),
    oldContent,
    newContent: '',
  };
}

export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  options: GetFileDiffOptions = {},
): Promise<FileDiffResult> {
  const headHash = await pinHead(worktreePath);
  const fileStatus = options.status ?? (await detectWorktreeFileStatus(worktreePath, filePath));
  const fullPath = path.join(worktreePath, filePath);
  const fingerprint = await getPathFingerprint(fullPath);

  return withGitQueryCache(
    getChangedFileCacheKey('file-diff', worktreePath, headHash, filePath, fingerprint, fileStatus),
    async () => {
      const category = fileStatus ? getChangedFileStatusCategory(fileStatus) : 'modified';

      switch (category) {
        case 'added':
          return getAddedFileDiff(worktreePath, filePath);
        case 'deleted':
          return getDeletedFileDiff(worktreePath, headHash, filePath);
        case 'modified':
          return getTrackedFileDiff(worktreePath, headHash, filePath);
      }
    },
  );
}

export async function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<GitChangedFile[]> {
  const branchHead = await resolveRevisionHash(projectRoot, branchName);
  return withGitQueryCache(
    `changed-files-branch:${cacheKey(projectRoot)}:${branchName}:${branchHead}`,
    async () => {
      const mainBranch = await detectMainBranch(projectRoot);

      let diffStr = '';
      try {
        const { stdout } = await exec(
          'git',
          ['diff', '--raw', '--numstat', `${mainBranch}...${branchName}`],
          { cwd: projectRoot, maxBuffer: MAX_BUFFER },
        );
        diffStr = stdout;
      } catch {
        return [];
      }

      const { statusMap, numstatMap } = parseDiffRawNumstat(diffStr);
      const files: GitChangedFile[] = [];

      for (const [filePath, [added, removed]] of numstatMap) {
        files.push({
          path: filePath,
          lines_added: added,
          lines_removed: removed,
          status: statusMap.get(filePath) ?? 'M',
          committed: true,
        });
      }

      for (const [filePath, status] of statusMap) {
        if (numstatMap.has(filePath)) continue;
        files.push({
          path: filePath,
          lines_added: 0,
          lines_removed: 0,
          status,
          committed: true,
        });
      }

      files.sort((a, b) => a.path.localeCompare(b.path));
      return files;
    },
  );
}

export async function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
): Promise<FileDiffResult> {
  const mainBranch = await detectMainBranch(projectRoot);
  const branchHead = await resolveRevisionHash(projectRoot, branchName);
  let mergeBase = mainBranch;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, branchName], {
      cwd: projectRoot,
    });
    if (stdout.trim()) mergeBase = stdout.trim();
  } catch {
    // use main branch
  }

  return withGitQueryCache(
    getChangedFileCacheKey(
      'file-diff-branch',
      projectRoot,
      `${mergeBase}:${branchHead}`,
      filePath,
      branchName,
    ),
    async () => {
      const [diff, oldFile, newFile] = await Promise.all([
        execGitStdout(projectRoot, ['diff', mergeBase, branchName, '--', filePath]),
        readGitTextFile(projectRoot, mergeBase, filePath),
        readGitTextFile(projectRoot, branchName, filePath),
      ]);

      if (isBinaryDiff(diff)) {
        return createBinaryFileDiffResult(
          filePath,
          {
            fileExistsOnDisk: newFile.exists,
            hasHistoricVersion: oldFile.exists,
          },
          diff,
          `Binary files a/${filePath} and b/${filePath} differ`,
        );
      }

      const oldContent = oldFile.content;
      const newContent = newFile.content;
      let normalizedDiff = diff.trim();

      if (!normalizedDiff && !oldFile.exists && newFile.exists) {
        normalizedDiff = createAddedPseudoDiff(filePath, newFile.content);
      }

      if (!normalizedDiff && oldFile.exists && !newFile.exists) {
        normalizedDiff = createDeletedPseudoDiff(filePath, oldFile.content);
      }

      return { diff: normalizedDiff, oldContent, newContent };
    },
  );
}

function trimBoundaryNewlines(block: string): string {
  return block.replace(/^\n+|\n+$/g, '');
}

function joinDiffBlocks(blocks: ReadonlyArray<string>): string {
  return blocks
    .map((block) => trimBoundaryNewlines(block))
    .filter((block) => block.length > 0)
    .join('\n');
}

function wrapUntrackedDiffBlock(filePath: string, diff: string): string {
  const trimmedDiff = trimBoundaryNewlines(diff);
  if (!trimmedDiff) {
    return '';
  }

  if (trimmedDiff.startsWith('diff --git ')) {
    return trimmedDiff;
  }

  return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n${trimmedDiff}`;
}

export async function getAllFileDiffs(worktreePath: string): Promise<string> {
  const headHash = await pinHead(worktreePath);
  const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);
  const trackedDiff = await execGitStdout(worktreePath, ['diff', base]);
  const changedFiles = await getChangedFiles(worktreePath);
  const untrackedFiles = changedFiles.filter((file) => file.status === '?');
  const untrackedDiffs = await Promise.all(
    untrackedFiles.map(async (file) => {
      const result = await getFileDiff(worktreePath, file.path, {
        status: file.status,
      });
      return wrapUntrackedDiffBlock(file.path, result.diff);
    }),
  );

  return joinDiffBlocks([trackedDiff, ...untrackedDiffs]);
}

export async function getAllFileDiffsFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<string> {
  const mainBranch = await detectMainBranch(projectRoot);
  return execGitStdout(projectRoot, ['diff', `${mainBranch}...${branchName}`]);
}

export async function getProjectDiff(
  worktreePath: string,
  mode: 'all' | 'staged' | 'unstaged' | 'branch',
): Promise<ProjectDiffResult> {
  let files: GitChangedFile[];

  switch (mode) {
    case 'all':
      files = await getChangedFiles(worktreePath);
      break;
    case 'staged': {
      const { stdout } = await exec('git', ['diff', '--cached', '--numstat'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      files = parseNumstat(stdout, 'staged');
      break;
    }
    case 'unstaged': {
      const { stdout } = await exec('git', ['diff', '--numstat'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      files = parseNumstat(stdout, 'unstaged');
      break;
    }
    case 'branch': {
      const headHash = await pinHead(worktreePath);
      const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);
      const { stdout } = await exec('git', ['diff', '--raw', '--numstat', base, headHash], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      const { statusMap, numstatMap } = parseDiffRawNumstat(stdout);

      files = Array.from(numstatMap, ([filePath, [lines_added, lines_removed]]) => ({
        path: filePath,
        lines_added,
        lines_removed,
        status: statusMap.get(filePath) ?? 'M',
        committed: true,
      }));

      for (const [filePath, status] of statusMap) {
        if (numstatMap.has(filePath)) continue;
        files.push({
          path: filePath,
          lines_added: 0,
          lines_removed: 0,
          status,
          committed: true,
        });
      }
      break;
    }
  }

  return {
    files,
    totalAdded: files.reduce((sum, file) => sum + file.lines_added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.lines_removed, 0),
  };
}
