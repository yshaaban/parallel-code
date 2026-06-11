import { normalizeRawChangedFileStatus } from '../../src/domain/git-status.js';
import type {
  BranchCommitHistoryResult,
  ReviewCommitFile,
  ReviewCommitSummary,
} from '../../src/domain/review-commit-history.js';
import { MAX_BUFFER } from './git-cache.js';
import { detectDiffBase } from './git-diff-base.js';
import { execGit } from './git-exec.js';
import { getMainBranch } from './git.js';
const FIELD_SEPARATOR = '\x1f';

interface CommitHeader {
  authoredAt: string;
  authorName: string;
  hash: string;
  parentHashes: string[];
  shortHash: string;
  subject: string;
}

interface CommitFileStats {
  files: ReviewCommitFile[];
  totalAdded: number;
  totalRemoved: number;
}

function parseCommitHeader(line: string): CommitHeader | null {
  const [hash, shortHash, authorName, authoredAt, parentHashes, subject] =
    line.split(FIELD_SEPARATOR);
  if (!hash || !shortHash || !authorName || !authoredAt) {
    return null;
  }

  return {
    authoredAt,
    authorName,
    hash,
    parentHashes: parentHashes ? parentHashes.split(' ').filter(Boolean) : [],
    shortHash,
    subject: subject ?? '',
  };
}

function parseStatNumber(value: string): number {
  if (value === '-') {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface NumstatEntry {
  lines_added: number;
  lines_removed: number;
  path: string;
}

function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const [addedValue, removedValue, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (!addedValue || !removedValue || !filePath) {
      continue;
    }

    entries.push({
      lines_added: parseStatNumber(addedValue),
      lines_removed: parseStatNumber(removedValue),
      path: filePath,
    });
  }

  return entries;
}

function parseNameStatus(output: string): Map<string, ReviewCommitFile['status']> {
  const statusByPath = new Map<string, ReviewCommitFile['status']>();
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const [statusValue, ...pathParts] = line.split('\t');
    const filePath = pathParts[pathParts.length - 1] ?? '';
    if (!statusValue || !filePath) {
      continue;
    }

    statusByPath.set(filePath, normalizeRawChangedFileStatus(statusValue[0] ?? 'M'));
  }

  return statusByPath;
}

function getCommitNumstatArgs(hash: string, firstParent: string | undefined): string[] {
  if (firstParent === undefined) {
    return ['show', '--format=', '--numstat', '--no-renames', '--root', hash];
  }

  return ['diff', '--numstat', '--no-renames', firstParent, hash];
}

function getCommitNameStatusArgs(hash: string, firstParent: string | undefined): string[] {
  if (firstParent === undefined) {
    return ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '--no-renames', hash];
  }

  return ['diff', '--name-status', '--no-renames', firstParent, hash];
}

async function getRevisionHash(projectRoot: string, revision: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', revision], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

async function getCommitHeaders(
  projectRoot: string,
  baseHash: string,
  branchName: string,
): Promise<CommitHeader[]> {
  const { stdout } = await execGit(
    [
      'log',
      '--reverse',
      `--format=%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%s`,
      `${baseHash}..${branchName}`,
    ],
    {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    },
  );

  return stdout
    .split('\n')
    .map((line) => parseCommitHeader(line))
    .filter((header): header is CommitHeader => header !== null);
}

async function getCommitFileStats(
  projectRoot: string,
  hash: string,
  parentHashes: ReadonlyArray<string>,
): Promise<CommitFileStats> {
  const firstParent = parentHashes[0];
  const numstatArgs = getCommitNumstatArgs(hash, firstParent);
  const nameStatusArgs = getCommitNameStatusArgs(hash, firstParent);
  const [numstatResult, nameStatusResult] = await Promise.all([
    execGit(numstatArgs, {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    }),
    execGit(nameStatusArgs, {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    }),
  ]);
  const statusByPath = parseNameStatus(nameStatusResult.stdout);
  const files = parseNumstat(numstatResult.stdout).map((entry) => ({
    ...entry,
    commitHash: hash,
    committed: true as const,
    status: statusByPath.get(entry.path) ?? 'M',
  }));
  return {
    files,
    totalAdded: files.reduce((sum, file) => sum + file.lines_added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.lines_removed, 0),
  };
}

export async function getBranchCommitHistory(options: {
  baseBranch?: string;
  branchName: string;
  projectRoot: string;
}): Promise<BranchCommitHistoryResult> {
  const mainBranch = await getMainBranch(options.projectRoot, options.baseBranch);
  const headHash = await getRevisionHash(options.projectRoot, options.branchName);
  const diffBase = await detectDiffBase(options.projectRoot, mainBranch, headHash);
  const baseHash = diffBase.sha;
  const headers = await getCommitHeaders(options.projectRoot, baseHash, options.branchName);
  const commits: ReviewCommitSummary[] = [];

  for (const header of headers) {
    const stats = await getCommitFileStats(options.projectRoot, header.hash, header.parentHashes);
    commits.push({
      ...header,
      files: stats.files,
      totalAdded: stats.totalAdded,
      totalRemoved: stats.totalRemoved,
    });
  }

  return {
    baseHash,
    commits,
    headHash,
    revisionId: `${baseHash}:${headHash}`,
  };
}
