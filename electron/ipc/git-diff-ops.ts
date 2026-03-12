import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { detectMainBranch } from './git-branch.js';
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

function toDiffLines(content: string): string[] {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

export async function getChangedFiles(worktreePath: string): Promise<GitChangedFile[]> {
  return withGitQueryCache(`changed-files:${cacheKey(worktreePath)}`, async () => {
    if (!(await worktreeExists(worktreePath))) {
      throw new NotFoundError(`Worktree not found: ${worktreePath}`);
    }

    const headHash = await pinHead(worktreePath);
    const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

    let diffStr = '';
    try {
      const { stdout } = await exec('git', ['diff', '--raw', '--numstat', base, headHash], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      diffStr = stdout;
    } catch {
      // no committed diff
    }

    const { statusMap: committedStatusMap, numstatMap: committedNumstatMap } =
      parseDiffRawNumstat(diffStr);

    let statusStr = '';
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      statusStr = stdout;
    } catch {
      // no uncommitted status
    }

    const uncommittedPaths = new Map<string, string>();
    const untrackedPaths = new Set<string>();
    for (const line of statusStr.split('\n')) {
      if (line.length < 3) continue;
      const normalizedPath = normalizeStatusPath(line.slice(3));
      if (!normalizedPath) continue;

      if (line.startsWith('??')) {
        untrackedPaths.add(normalizedPath);
        uncommittedPaths.set(normalizedPath, '?');
        continue;
      }

      const wtStatus = line[1];
      const indexStatus = line[0];
      const statusLetter = wtStatus && wtStatus !== ' ' ? wtStatus : (indexStatus ?? 'M');
      uncommittedPaths.set(normalizedPath, statusLetter);
    }

    const files: GitChangedFile[] = [];
    const seen = new Set<string>();

    for (const [filePath, [added, removed]] of committedNumstatMap) {
      const status = committedStatusMap.get(filePath) ?? 'M';
      const committed = !uncommittedPaths.has(filePath);
      seen.add(filePath);
      files.push({
        path: filePath,
        lines_added: added,
        lines_removed: removed,
        status,
        committed,
      });
    }

    const uncommittedNumstat = new Map<string, [number, number]>();
    const hasTrackedUncommitted = [...uncommittedPaths.keys()].some(
      (filePath) => !seen.has(filePath) && !untrackedPaths.has(filePath),
    );
    if (hasTrackedUncommitted) {
      try {
        const { stdout } = await exec('git', ['diff', '--numstat', 'HEAD'], {
          cwd: worktreePath,
          maxBuffer: MAX_BUFFER,
        });
        for (const line of stdout.split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;

          const rawAdded = parts[0];
          const rawRemoved = parts[1];
          const rawPath = parts[parts.length - 1];
          if (!rawAdded || !rawRemoved || !rawPath) continue;

          const added = parseInt(rawAdded, 10);
          const removed = parseInt(rawRemoved, 10);
          if (isNaN(added) || isNaN(removed)) continue;

          const normalizedPath = normalizeStatusPath(rawPath);
          if (normalizedPath) {
            uncommittedNumstat.set(normalizedPath, [added, removed]);
          }
        }
      } catch {
        // best-effort stats
      }
    }

    for (const [filePath, statusLetter] of uncommittedPaths) {
      if (seen.has(filePath)) continue;

      let added = 0;
      let removed = 0;

      if (untrackedPaths.has(filePath)) {
        const fullPath = path.join(worktreePath, filePath);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isFile() && stat.size < MAX_BUFFER) {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const lines = content.split('\n');
            added = content.endsWith('\n') ? lines.length - 1 : lines.length;
          }
        } catch {
          // unreadable untracked file
        }
      } else {
        const stats = uncommittedNumstat.get(filePath);
        if (stats) {
          [added, removed] = stats;
        }
      }

      files.push({
        path: filePath,
        lines_added: added,
        lines_removed: removed,
        status: statusLetter,
        committed: false,
      });
    }

    files.sort((a, b) => {
      if (a.committed !== b.committed) return a.committed ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return files;
  });
}

export async function getFileDiff(worktreePath: string, filePath: string): Promise<FileDiffResult> {
  const headHash = await pinHead(worktreePath);
  const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    // file did not exist at base
  }

  let newContent = '';
  let committedContent = '';
  let fileExistsOnDisk = false;
  let fileContentReadable = false;

  try {
    const { stdout } = await exec('git', ['show', `${headHash}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    committedContent = stdout;
  } catch {
    // file not in HEAD
  }

  const fullPath = path.join(worktreePath, filePath);
  let diskContent = '';
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.isFile()) {
      fileExistsOnDisk = true;
      if (stat.size < MAX_BUFFER) {
        diskContent = await fs.promises.readFile(fullPath, 'utf8');
        fileContentReadable = true;
      }
    }
  } catch {
    // file absent on disk
  }

  const isUncommittedDeletion = !fileExistsOnDisk && committedContent !== '';
  const hasUncommittedChanges =
    committedContent !== '' &&
    fileExistsOnDisk &&
    fileContentReadable &&
    diskContent !== committedContent;

  if (isUncommittedDeletion) {
    newContent = '';
    if (!oldContent && committedContent) {
      oldContent = committedContent;
    }
  } else if (hasUncommittedChanges) {
    newContent = diskContent;
  } else if (committedContent) {
    newContent = committedContent;
  } else {
    newContent = diskContent;
  }

  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', base, headHash, '--', filePath], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    if (stdout.trim()) diff = stdout;
  } catch {
    // empty diff
  }

  if (!diff && fileExistsOnDisk && !oldContent && fileContentReadable) {
    const lines = toDiffLines(newContent);
    let pseudo = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      pseudo += `+${line}\n`;
    }
    diff = pseudo;
  }

  if (!diff && isUncommittedDeletion && oldContent) {
    const lines = toDiffLines(oldContent);
    let pseudo = `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n`;
    for (const line of lines) {
      pseudo += `-${line}\n`;
    }
    diff = pseudo;
  }

  return { diff, oldContent, newContent };
}

export async function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<GitChangedFile[]> {
  return withGitQueryCache(
    `changed-files-branch:${cacheKey(projectRoot)}:${branchName}`,
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

  let diff = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', `${mainBranch}...${branchName}`, '--', filePath],
      { cwd: projectRoot, maxBuffer: MAX_BUFFER },
    );
    diff = stdout;
  } catch {
    // empty diff
  }

  let mergeBase = mainBranch;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, branchName], {
      cwd: projectRoot,
    });
    if (stdout.trim()) mergeBase = stdout.trim();
  } catch {
    // use main branch
  }

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${mergeBase}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    // file missing at merge base
  }

  let newContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${branchName}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    newContent = stdout;
  } catch {
    // file missing on branch
  }

  return { diff, oldContent, newContent };
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
