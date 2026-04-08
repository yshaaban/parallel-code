import { randomUUID } from 'crypto';
import {
  checkoutBranch,
  createWorktree,
  getCurrentBranch,
  getMainBranch,
  removeWorktree,
} from './git.js';
import { killAgent, notifyAgentListChanged } from './pty.js';

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

export async function createTask(
  name: string,
  projectRoot: string,
  symlinkDirs: string[],
  branchPrefix: string,
): Promise<{
  id: string;
  branch_name: string;
  worktree_path: string;
  git_isolation: 'worktree';
}> {
  const prefix = sanitizeBranchPrefix(branchPrefix);
  const taskSlug = getTaskSlug(name);

  for (let attempt = 0; attempt < MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const branchName = buildTaskBranchName(prefix, taskSlug, attempt);
    const worktreePath = `${projectRoot}/.worktrees/${branchName}`;

    try {
      const worktree = await createWorktree(projectRoot, branchName, symlinkDirs);
      return {
        id: randomUUID(),
        branch_name: worktree.branch,
        worktree_path: worktree.path,
        git_isolation: 'worktree',
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
  const baseBranch = await getMainBranch(projectRoot, configuredBaseBranch);
  const currentBranch = await getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    await checkoutBranch(projectRoot, baseBranch);
  }

  const branchName = await getCurrentBranch(projectRoot);

  return {
    id: randomUUID(),
    branch_name: branchName,
    worktree_path: projectRoot,
    base_branch: baseBranch,
    git_isolation: 'current-branch',
  };
}

export async function deleteTask(
  agentIds: string[],
  branchName: string,
  deleteBranch: boolean,
  projectRoot: string,
): Promise<void> {
  for (const agentId of agentIds) {
    try {
      killAgent(agentId);
    } catch {
      /* already dead */
    }
  }
  await removeWorktree(projectRoot, branchName, deleteBranch);
  notifyAgentListChanged();
}
