import { normalizeBaseBranch } from '../../src/lib/base-branch.js';
import { normalizeTaskBaseBranch } from '../../src/store/task-git-isolation.js';
import type { PersistedProjectLookup, PersistedTaskLookup } from '../../src/store/types.js';

export interface ParsedPersistedTaskLookupState {
  projects: PersistedProjectLookup[];
  tasks: Record<string, PersistedTaskLookup>;
}

function createEmptyParsedPersistedTaskLookupState(): ParsedPersistedTaskLookupState {
  return {
    projects: [],
    tasks: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePersistedProjectLookup(value: unknown): PersistedProjectLookup | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id === 'string' && typeof value.path === 'string') {
    if (value.projectMode === 'non-git') {
      return {
        id: value.id,
        path: value.path,
        projectMode: 'non-git',
      };
    }

    const baseBranch =
      typeof value.baseBranch === 'string' ? normalizeBaseBranch(value.baseBranch) : undefined;
    const project: PersistedProjectLookup = {
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      id: value.id,
      path: value.path,
    };
    if (
      value.defaultTaskGitIsolation === 'worktree' ||
      value.defaultTaskGitIsolation === 'current-branch'
    ) {
      project.defaultTaskGitIsolation = value.defaultTaskGitIsolation;
    } else if (value.defaultDirectMode === true) {
      project.defaultTaskGitIsolation = 'current-branch';
    }

    return project;
  }

  return null;
}

function parsePersistedTaskLookup(taskId: string, value: unknown): PersistedTaskLookup | null {
  if (!isRecord(value)) {
    return null;
  }

  const task: PersistedTaskLookup = {};
  let hasKnownField = false;
  const isNonGitTask = value.projectMode === 'non-git';
  if (typeof value.branchName === 'string') {
    task.branchName = value.branchName;
    hasKnownField = true;
  }
  if (typeof value.id === 'string') {
    task.id = value.id;
    hasKnownField = true;
  }
  if (typeof value.name === 'string') {
    task.name = value.name;
    hasKnownField = true;
  }
  if (typeof value.projectId === 'string') {
    task.projectId = value.projectId;
    hasKnownField = true;
  }
  if (isNonGitTask) {
    task.projectMode = 'non-git';
    hasKnownField = true;
  }
  if (typeof value.githubUrl === 'string') {
    task.githubUrl = value.githubUrl;
    hasKnownField = true;
  }
  if (typeof value.worktreePath === 'string') {
    task.worktreePath = value.worktreePath;
    hasKnownField = true;
  }

  if (!isNonGitTask) {
    const baseBranch = normalizeTaskBaseBranch({
      baseBranch: typeof value.baseBranch === 'string' ? value.baseBranch : undefined,
    });
    if (baseBranch !== undefined) {
      task.baseBranch = baseBranch;
      hasKnownField = true;
    }
    if (
      value.gitIsolation === 'worktree' ||
      value.gitIsolation === 'current-branch' ||
      value.gitIsolation === 'existing-worktree'
    ) {
      task.gitIsolation = value.gitIsolation;
      hasKnownField = true;
    } else if (value.directMode === true) {
      task.gitIsolation = 'current-branch';
      hasKnownField = true;
    }
    if (value.worktreeOwnership === 'managed' || value.worktreeOwnership === 'external') {
      task.worktreeOwnership = value.worktreeOwnership;
      hasKnownField = true;
    }
  }

  if (task.id === undefined && hasKnownField && taskId.length > 0) {
    task.id = taskId;
  }

  return Object.keys(task).length > 0 ? task : null;
}

function parsePersistedProjects(value: unknown): PersistedProjectLookup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((project) => parsePersistedProjectLookup(project))
    .filter((project): project is PersistedProjectLookup => project !== null);
}

function parsePersistedTasks(value: unknown): Record<string, PersistedTaskLookup> {
  if (!isRecord(value)) {
    return {};
  }

  const tasks: Record<string, PersistedTaskLookup> = {};
  for (const [taskId, taskValue] of Object.entries(value)) {
    const task = parsePersistedTaskLookup(taskId, taskValue);
    if (task) {
      tasks[taskId] = task;
    }
  }
  return tasks;
}

export function parsePersistedTaskLookupStateFromRoot(
  root: Record<string, unknown> | null,
): ParsedPersistedTaskLookupState {
  if (!root) {
    return createEmptyParsedPersistedTaskLookupState();
  }

  return {
    projects: parsePersistedProjects(root.projects),
    tasks: parsePersistedTasks(root.tasks),
  };
}

export function parsePersistedTaskLookupState(savedJson: string): ParsedPersistedTaskLookupState {
  try {
    const parsed: unknown = JSON.parse(savedJson);
    if (!isRecord(parsed)) {
      return createEmptyParsedPersistedTaskLookupState();
    }

    return parsePersistedTaskLookupStateFromRoot(parsed);
  } catch {
    return createEmptyParsedPersistedTaskLookupState();
  }
}
