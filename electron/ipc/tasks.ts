import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  createWorktree,
  getCurrentBranch,
  getGitCommonDirectory,
  getMainBranch,
  removeWorktree,
} from './git.js';
import type { TaskWorktreeLinkRequestV1 } from './git-worktree-symlinks.js';
import { notifyAgentListChanged } from './pty.js';
import type { WorktreeSymlinkWarning } from '../../src/ipc/types.js';

const MAX_SLUG_LEN = 72;
const MAX_BRANCH_ATTEMPTS = 100;

function slug(name: string): string {
  let result = '';
  let prevWasHyphen = false;
  for (const c of name.toLowerCase()) {
    if (result.length >= MAX_SLUG_LEN) break;
    if (/[a-z0-9]/.test(c)) {
      result += c;
      prevWasHyphen = false;
    } else if (!prevWasHyphen) {
      result += '-';
      prevWasHyphen = true;
    }
  }
  return result.replace(/^-+|-+$/g, '');
}

function sanitizeBranchPrefix(prefix: string): string {
  const parts = prefix
    .split('/')
    .map(slug)
    .filter((p) => p.length > 0);
  return parts.length === 0 ? 'task' : parts.join('/');
}

function getTaskSlug(name: string): string {
  const taskSlug = slug(name);
  return taskSlug.length > 0 ? taskSlug : 'task';
}

function buildTaskBranchName(prefix: string, taskSlug: string, attempt: number): string {
  if (attempt === 0) {
    return `${prefix}/${taskSlug}`;
  }

  const suffix = `-${attempt + 1}`;
  const truncatedTaskSlug = taskSlug.slice(0, Math.max(1, MAX_SLUG_LEN - suffix.length));
  return `${prefix}/${truncatedTaskSlug.replace(/-+$/g, '') || 'task'}${suffix}`;
}

export interface PlannedManagedTaskLocation {
  branchName: string;
  worktreePath: string;
}

/**
 * Gives the durable creation owner one stable, high-entropy location for an operation. A retry
 * can verify this exact tuple instead of allocating a visually similar second worktree.
 */
export function planManagedTaskLocation(
  name: string,
  projectRoot: string,
  branchPrefix: string,
  operationId: string,
): PlannedManagedTaskLocation {
  const prefix = sanitizeBranchPrefix(branchPrefix);
  const suffix = `-${createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 12)}`;
  const taskSlug = getTaskSlug(name)
    .slice(0, Math.max(1, MAX_SLUG_LEN - suffix.length))
    .replace(/-+$/g, '');
  const branchName = `${prefix}/${taskSlug || 'task'}${suffix}`;
  return {
    branchName,
    worktreePath: `${projectRoot}/.worktrees/${branchName}`,
  };
}

function getErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const candidate = error as Error & {
    stderr?: unknown;
    stdout?: unknown;
  };
  const fragments = [error.message];
  if (typeof candidate.stderr === 'string' && candidate.stderr.length > 0) {
    fragments.push(candidate.stderr);
  }
  if (typeof candidate.stdout === 'string' && candidate.stdout.length > 0) {
    fragments.push(candidate.stdout);
  }
  return fragments.join('\n');
}

function isWorktreeNameCollision(
  error: unknown,
  branchName: string,
  worktreePath: string,
): boolean {
  const message = getErrorText(error).toLowerCase();
  const normalizedBranchName = branchName.toLowerCase();
  const normalizedWorktreePath = worktreePath.toLowerCase();
  const referencesRequestedBranchOrPath =
    message.includes(normalizedBranchName) || message.includes(normalizedWorktreePath);

  if (!referencesRequestedBranchOrPath) {
    return false;
  }

  return message.includes('already exists') || message.includes('already checked out');
}

function createTaskWorktree(
  projectRoot: string,
  branchName: string,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
  baseBranch: string | undefined,
): Promise<{
  branch: string;
  path: string;
  symlink_warnings?: WorktreeSymlinkWarning[];
}> {
  if (baseBranch === undefined) {
    return createWorktree(projectRoot, branchName, worktreeLinkRequest);
  }

  return createWorktree(projectRoot, branchName, worktreeLinkRequest, false, baseBranch);
}

export async function createPlannedManagedTask(
  projectRoot: string,
  location: Readonly<PlannedManagedTaskLocation>,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
  baseBranch?: string,
): Promise<{
  branch_name: string;
  worktree_path: string;
  git_isolation: 'worktree';
  symlink_warnings?: WorktreeSymlinkWarning[];
}> {
  const worktree = await createTaskWorktree(
    projectRoot,
    location.branchName,
    worktreeLinkRequest,
    baseBranch,
  );
  if (worktree.branch !== location.branchName || worktree.path !== location.worktreePath) {
    throw new Error('Managed task preparation returned a different canonical location');
  }
  return {
    branch_name: worktree.branch,
    worktree_path: worktree.path,
    git_isolation: 'worktree',
    ...(worktree.symlink_warnings !== undefined
      ? { symlink_warnings: worktree.symlink_warnings }
      : {}),
  };
}

export async function createTask(
  name: string,
  projectRoot: string,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
  branchPrefix: string,
  baseBranch?: string,
): Promise<{
  id: string;
  branch_name: string;
  worktree_path: string;
  git_isolation: 'worktree';
  symlink_warnings?: WorktreeSymlinkWarning[];
}> {
  const prefix = sanitizeBranchPrefix(branchPrefix);
  const taskSlug = getTaskSlug(name);

  for (let attempt = 0; attempt < MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const branchName = buildTaskBranchName(prefix, taskSlug, attempt);
    const worktreePath = `${projectRoot}/.worktrees/${branchName}`;

    try {
      const worktree = await createTaskWorktree(
        projectRoot,
        branchName,
        worktreeLinkRequest,
        baseBranch,
      );
      return {
        id: randomUUID(),
        branch_name: worktree.branch,
        worktree_path: worktree.path,
        git_isolation: 'worktree',
        ...(worktree.symlink_warnings !== undefined
          ? { symlink_warnings: worktree.symlink_warnings }
          : {}),
      };
    } catch (error) {
      if (!isWorktreeNameCollision(error, branchName, worktreePath)) {
        throw error;
      }
    }
  }

  throw new Error(`Unable to allocate a unique task branch for "${name}"`);
}

export async function createCurrentBranchTask(
  projectRoot: string,
  configuredBaseBranch?: string,
): Promise<{
  id: string;
  branch_name: string;
  worktree_path: string;
  base_branch: string;
  git_isolation: 'current-branch';
}> {
  const currentBranch = await getCurrentBranch(projectRoot);
  // Root-backed tasks share the user's checkout, including its index and dirty files.
  // Creating another task must never switch the branch underneath existing agents.
  const baseBranch = configuredBaseBranch?.trim() || currentBranch;

  return {
    id: randomUUID(),
    branch_name: currentBranch,
    worktree_path: projectRoot,
    base_branch: baseBranch,
    git_isolation: 'current-branch',
  };
}

export function createNonGitTask(projectRoot: string): {
  id: string;
  branch_name: string;
  project_mode: 'non-git';
  worktree_path: string;
} {
  return {
    id: randomUUID(),
    branch_name: '',
    project_mode: 'non-git',
    worktree_path: projectRoot,
  };
}

function getCanonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  return fs.promises
    .stat(candidatePath)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

export async function importExistingWorktreeTask(
  projectRoot: string,
  worktreePath: string,
  configuredBaseBranch?: string,
): Promise<{
  id: string;
  branch_name: string;
  worktree_path: string;
  base_branch: string;
  git_isolation: 'existing-worktree';
}> {
  if (!(await isDirectory(worktreePath))) {
    throw new Error(`Existing worktree path does not exist: ${worktreePath}`);
  }

  if (getCanonicalPath(projectRoot) === getCanonicalPath(worktreePath)) {
    throw new Error('Existing worktree import cannot use the project root.');
  }

  const [projectCommonDir, worktreeCommonDir] = await Promise.all([
    getGitCommonDirectory(projectRoot),
    getGitCommonDirectory(worktreePath),
  ]);

  if (!projectCommonDir || !worktreeCommonDir) {
    throw new Error('Existing worktree import requires git repositories for both paths.');
  }

  if (getCanonicalPath(projectCommonDir) !== getCanonicalPath(worktreeCommonDir)) {
    throw new Error('Existing worktree belongs to a different git repository.');
  }

  const [baseBranch, branchName] = await Promise.all([
    getMainBranch(worktreePath, configuredBaseBranch),
    getCurrentBranch(worktreePath),
  ]);

  return {
    id: randomUUID(),
    branch_name: branchName,
    worktree_path: worktreePath,
    base_branch: baseBranch,
    git_isolation: 'existing-worktree',
  };
}

export async function deleteTask(
  branchName: string,
  deleteBranch: boolean,
  projectRoot: string,
  expectedWorktreePath?: string,
): Promise<void> {
  try {
    await removeWorktree(projectRoot, branchName, deleteBranch, expectedWorktreePath);
  } finally {
    notifyAgentListChanged();
  }
}
