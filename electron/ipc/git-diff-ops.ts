import { execFile, spawn } from 'child_process';
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

async function getBranchHead(projectRoot: string, branchName: string): Promise<string> {
  return resolveRevisionHash(projectRoot, branchName);
}

interface BranchDiffContext {
  branchHead: string;
  mainBranch: string;
  mainBranchHead: string;
  mergeBase: string;
}

async function getBranchDiffContext(
  projectRoot: string,
  branchName: string,
  branchHead: string,
): Promise<BranchDiffContext> {
  const mainBranch = await detectMainBranch(projectRoot);
  const mainBranchHead = await resolveRevisionHash(projectRoot, mainBranch);

  return withGitQueryCache(
    `branch-diff-context:${cacheKey(projectRoot)}:${mainBranch}:${mainBranchHead}:${branchName}:${branchHead}`,
    async () => {
      let mergeBase = mainBranchHead;

      try {
        const { stdout } = await exec('git', ['merge-base', mainBranchHead, branchHead], {
          cwd: projectRoot,
        });
        const resolvedMergeBase = stdout.trim();
        if (resolvedMergeBase) {
          mergeBase = resolvedMergeBase;
        }
      } catch {
        // use detected main branch
      }

      return {
        branchHead,
        mainBranch,
        mainBranchHead,
        mergeBase,
      };
    },
  );
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

interface GitSafeFileReadResult {
  content: string;
  exists: boolean;
  isBinary: boolean;
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

async function readGitFileIfSafe(
  cwd: string,
  revision: string,
  filePath: string,
): Promise<GitSafeFileReadResult> {
  try {
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        'git',
        ['show', `${revision}:${filePath}`],
        { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER },
        (error, nextStdout) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(nextStdout as Buffer);
        },
      );
    });

    if (looksBinaryBuffer(stdout)) {
      return {
        content: '',
        exists: true,
        isBinary: true,
      };
    }

    return {
      content: stdout.toString('utf8'),
      exists: true,
      isBinary: false,
    };
  } catch {
    return {
      content: '',
      exists: false,
      isBinary: false,
    };
  }
}

interface GitBatchFileReadRequest {
  filePath: string;
  revision: string;
}

function parseGitBatchReadOutput(
  specs: ReadonlyArray<string>,
  stdout: Buffer,
): GitSafeFileReadResult[] | null {
  const results: GitSafeFileReadResult[] = [];
  let offset = 0;

  for (const spec of specs) {
    const lineEnd = stdout.indexOf(0x0a, offset);
    if (lineEnd < 0) {
      return null;
    }

    const header = stdout.toString('utf8', offset, lineEnd);
    offset = lineEnd + 1;

    if (header === `${spec} missing`) {
      results.push({
        content: '',
        exists: false,
        isBinary: false,
      });
      continue;
    }

    const match = /^(?:[0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match) {
      return null;
    }

    const sizeToken = match[1];
    if (sizeToken === undefined) {
      return null;
    }

    const size = Number.parseInt(sizeToken, 10);
    if (!Number.isFinite(size) || size < 0 || offset + size > stdout.length) {
      return null;
    }

    const contentBuffer = stdout.subarray(offset, offset + size);
    offset += size;

    if (offset >= stdout.length || stdout[offset] !== 0x0a) {
      return null;
    }
    offset += 1;

    if (looksBinaryBuffer(contentBuffer)) {
      results.push({
        content: '',
        exists: true,
        isBinary: true,
      });
      continue;
    }

    results.push({
      content: contentBuffer.toString('utf8'),
      exists: true,
      isBinary: false,
    });
  }

  return offset === stdout.length ? results : null;
}

async function readGitFilesIfSafe(
  cwd: string,
  requests: ReadonlyArray<GitBatchFileReadRequest>,
): Promise<GitSafeFileReadResult[] | null> {
  if (requests.length === 0) {
    return [];
  }

  const specs = requests.map(({ revision, filePath }) => `${revision}:${filePath}`);
  const maxBytes = MAX_BUFFER * requests.length;

  return new Promise((resolve) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let settled = false;

    function finish(result: GitSafeFileReadResult[] | null): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutLength += bufferChunk.length;
      if (stdoutLength > maxBytes) {
        child.kill();
        finish(null);
        return;
      }
      stdoutChunks.push(bufferChunk);
    });

    child.on('error', () => {
      finish(null);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }

      const stdout = Buffer.concat(stdoutChunks);
      finish(parseGitBatchReadOutput(specs, stdout));
    });

    child.stdin.end(`${specs.join('\n')}\n`);
  });
}

async function readComparedBranchFiles(
  projectRoot: string,
  branchContext: BranchDiffContext,
  filePath: string,
): Promise<[GitSafeFileReadResult, GitSafeFileReadResult]> {
  const batchFiles = await readGitFilesIfSafe(projectRoot, [
    { revision: branchContext.mergeBase, filePath },
    { revision: branchContext.branchHead, filePath },
  ]);
  if (batchFiles?.length === 2) {
    const [oldFile, newFile] = batchFiles;
    if (oldFile && newFile) {
      return [oldFile, newFile];
    }
  }

  return Promise.all([
    readGitFileIfSafe(projectRoot, branchContext.mergeBase, filePath),
    readGitFileIfSafe(projectRoot, branchContext.branchHead, filePath),
  ]);
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

function getSingleFileModeLine(status: 'A' | 'D' | 'M'): string {
  switch (status) {
    case 'A':
      return 'new file mode 100644';
    case 'D':
      return 'deleted file mode 100644';
    case 'M':
      return '';
  }
}

function wrapSingleFileDiffBlock(filePath: string, diff: string, status: 'A' | 'D'): string {
  const trimmedDiff = trimBoundaryNewlines(diff);
  if (!trimmedDiff) {
    return '';
  }

  if (trimmedDiff.startsWith('diff --git ')) {
    return trimmedDiff;
  }

  return `diff --git a/${filePath} b/${filePath}\n${getSingleFileModeLine(status)}\n${trimmedDiff}`;
}

function wrapBinaryDiffBlock(filePath: string, diff: string, status: 'A' | 'D' | 'M'): string {
  const trimmedDiff = trimBoundaryNewlines(diff);
  if (!trimmedDiff) {
    return '';
  }

  if (trimmedDiff.startsWith('diff --git ')) {
    return trimmedDiff;
  }

  const modeLine = getSingleFileModeLine(status);
  const modePrefix = modeLine ? `${modeLine}\n` : '';
  return `diff --git a/${filePath} b/${filePath}\n${modePrefix}${trimmedDiff}`;
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
  status: 'A' | 'D' | 'M' = 'M',
): FileDiffResult {
  const binaryDiff = diff.trim() || fallbackDiff || createBinaryDiffMarker(filePath, options);
  return {
    diff: wrapBinaryDiffBlock(filePath, binaryDiff, status),
    oldContent: '',
    newContent: '',
  };
}

async function getComparedBranchFileDiff(
  projectRoot: string,
  branchContext: BranchDiffContext,
  filePath: string,
): Promise<FileDiffResult> {
  const [diff, [oldFile, newFile]] = await Promise.all([
    execGitStdout(projectRoot, [
      'diff',
      branchContext.mergeBase,
      branchContext.branchHead,
      '--',
      filePath,
    ]),
    readComparedBranchFiles(projectRoot, branchContext, filePath),
  ]);

  if (isBinaryDiff(diff) || oldFile.isBinary || newFile.isBinary) {
    return createBinaryFileDiffResult(
      filePath,
      {
        fileExistsOnDisk: newFile.exists,
        hasHistoricVersion: oldFile.exists,
      },
      diff,
      `Binary files a/${filePath} and b/${filePath} differ`,
      'M',
    );
  }

  const oldContent = oldFile.content;
  const newContent = newFile.content;
  let normalizedDiff = diff.trim();

  if (!normalizedDiff && !oldFile.exists && newFile.exists) {
    normalizedDiff = wrapSingleFileDiffBlock(
      filePath,
      createAddedPseudoDiff(filePath, newFile.content),
      'A',
    );
  }

  if (!normalizedDiff && oldFile.exists && !newFile.exists) {
    normalizedDiff = wrapSingleFileDiffBlock(
      filePath,
      createDeletedPseudoDiff(filePath, oldFile.content),
      'D',
    );
  }

  return { diff: normalizedDiff, oldContent, newContent };
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
      undefined,
      'A',
    );
  }

  const newContent = diskFile.readable ? diskFile.content : '';
  return {
    diff: diskFile.readable
      ? wrapSingleFileDiffBlock(filePath, createAddedPseudoDiff(filePath, diskFile.content), 'A')
      : '',
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
      undefined,
      'D',
    );
  }

  const oldContent = headFile.content;
  return {
    diff:
      workingTreeDiff.trim() ||
      wrapSingleFileDiffBlock(filePath, createDeletedPseudoDiff(filePath, oldContent), 'D'),
    oldContent,
    newContent: '',
  };
}

export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  options: GetFileDiffOptions = {},
): Promise<FileDiffResult> {
  const fileStatus = options.status ?? (await detectWorktreeFileStatus(worktreePath, filePath));
  const category = fileStatus ? getChangedFileStatusCategory(fileStatus) : 'modified';
  const fullPath = path.join(worktreePath, filePath);
  const fingerprint = await getPathFingerprint(fullPath);

  if (category === 'added') {
    return withGitQueryCache(
      getChangedFileCacheKey(
        'file-diff',
        worktreePath,
        'worktree-added',
        filePath,
        fingerprint,
        fileStatus,
      ),
      async () => getAddedFileDiff(worktreePath, filePath),
    );
  }

  const headHash = await pinHead(worktreePath);

  return withGitQueryCache(
    getChangedFileCacheKey('file-diff', worktreePath, headHash, filePath, fingerprint, fileStatus),
    async () => {
      switch (category) {
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
  const branchHead = await getBranchHead(projectRoot, branchName);
  const branchContext = await getBranchDiffContext(projectRoot, branchName, branchHead);
  const branchDiffRevision = `${branchContext.mergeBase}:${branchContext.branchHead}`;
  return withGitQueryCache(
    `changed-files-branch:${cacheKey(projectRoot)}:${branchName}:${branchDiffRevision}`,
    async () => {
      let diffStr = '';
      try {
        const { stdout } = await exec(
          'git',
          [
            'diff',
            '--raw',
            '--numstat',
            `${branchContext.mainBranch}...${branchContext.branchHead}`,
          ],
          { cwd: projectRoot, maxBuffer: MAX_BUFFER },
        );
        diffStr = stdout;
      } catch {
        return [];
      }

      const { statusMap, numstatMap } = parseDiffRawNumstat(diffStr);
      const files: GitChangedFile[] = [];

      for (const [filePath, [added, removed]] of numstatMap) {
        files.push(
          createChangedFile(filePath, statusMap.get(filePath) ?? 'M', [added, removed], true),
        );
      }

      for (const [filePath, status] of statusMap) {
        if (numstatMap.has(filePath)) continue;
        files.push(createChangedFile(filePath, status, [0, 0], true));
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
  options: GetFileDiffOptions = {},
): Promise<FileDiffResult> {
  const branchHead = await getBranchHead(projectRoot, branchName);
  const fileStatus = options.status;
  const category = fileStatus ? getChangedFileStatusCategory(fileStatus) : 'modified';
  const branchContext = await getBranchDiffContext(projectRoot, branchName, branchHead);
  const branchDiffRevision = `${branchContext.mergeBase}:${branchContext.branchHead}`;

  if (category === 'added') {
    return withGitQueryCache(
      getChangedFileCacheKey(
        'file-diff-branch',
        projectRoot,
        branchDiffRevision,
        filePath,
        branchName,
        fileStatus,
      ),
      async () => {
        const [oldFile, newFile] = await readComparedBranchFiles(
          projectRoot,
          branchContext,
          filePath,
        );
        if (oldFile.exists || !newFile.exists) {
          return getComparedBranchFileDiff(projectRoot, branchContext, filePath);
        }

        if (newFile.isBinary) {
          return createBinaryFileDiffResult(
            filePath,
            {
              fileExistsOnDisk: newFile.exists,
              hasHistoricVersion: false,
            },
            '',
            `Binary files /dev/null and b/${filePath} differ`,
            'A',
          );
        }

        return {
          diff: newFile.exists
            ? wrapSingleFileDiffBlock(
                filePath,
                createAddedPseudoDiff(filePath, newFile.content),
                'A',
              )
            : '',
          oldContent: '',
          newContent: newFile.content,
        };
      },
    );
  }

  if (category === 'deleted') {
    return withGitQueryCache(
      getChangedFileCacheKey(
        'file-diff-branch',
        projectRoot,
        branchDiffRevision,
        filePath,
        branchName,
        fileStatus,
      ),
      async () => {
        const [oldFile, newFile] = await readComparedBranchFiles(
          projectRoot,
          branchContext,
          filePath,
        );
        if (!oldFile.exists || newFile.exists) {
          return getComparedBranchFileDiff(projectRoot, branchContext, filePath);
        }

        if (oldFile.isBinary) {
          return createBinaryFileDiffResult(
            filePath,
            {
              fileExistsOnDisk: false,
              hasHistoricVersion: oldFile.exists,
            },
            '',
            `Binary files a/${filePath} and /dev/null differ`,
            'D',
          );
        }

        return {
          diff: wrapSingleFileDiffBlock(
            filePath,
            createDeletedPseudoDiff(filePath, oldFile.content),
            'D',
          ),
          oldContent: oldFile.content,
          newContent: '',
        };
      },
    );
  }

  return withGitQueryCache(
    getChangedFileCacheKey(
      'file-diff-branch',
      projectRoot,
      branchDiffRevision,
      filePath,
      branchName,
      fileStatus,
    ),
    async () => getComparedBranchFileDiff(projectRoot, branchContext, filePath),
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
      return result.diff;
    }),
  );

  return joinDiffBlocks([trackedDiff, ...untrackedDiffs]);
}

export async function getAllFileDiffsFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<string> {
  const branchHead = await getBranchHead(projectRoot, branchName);
  const branchContext = await getBranchDiffContext(projectRoot, branchName, branchHead);
  return execGitStdout(projectRoot, [
    'diff',
    `${branchContext.mainBranch}...${branchContext.branchHead}`,
  ]);
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
