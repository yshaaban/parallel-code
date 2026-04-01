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
  const branchName = `${prefix}/${slug(name)}`;
  const worktree = await createWorktree(projectRoot, branchName, symlinkDirs);
  return {
    id: randomUUID(),
    branch_name: worktree.branch,
    worktree_path: worktree.path,
    git_isolation: 'worktree',
  };
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
