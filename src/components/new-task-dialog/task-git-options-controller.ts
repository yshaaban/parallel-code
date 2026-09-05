import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import { IPC } from '../../../electron/ipc/channels';
import type { GitBranchInfo, WorktreeSymlinkCandidate } from '../../ipc/types';
import { findBranchRefPrefixConflict, formatBranchRefPrefixConflict } from '../../lib/branch-name';
import { invokeWithAbortSignal } from '../../lib/ipc';
import type { ProjectMode } from '../../store/types';

type TaskBranchListStatus = 'idle' | 'loading' | 'ready' | 'error';
export type TaskIgnoredDirsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

interface IgnoredDirDiscoveryState {
  candidates: WorktreeSymlinkCandidate[];
  error: string | null;
  status: TaskIgnoredDirsStatus;
  truncated: boolean;
}

interface CreateTaskGitOptionsControllerOptions {
  active: Accessor<boolean>;
  branchPreview: Accessor<string>;
  createsManagedWorktree: Accessor<boolean>;
  projectBaseBranch: Accessor<string | undefined>;
  projectId: Accessor<string | null>;
  projectMode: Accessor<ProjectMode>;
  projectRoot: Accessor<string | undefined>;
}

interface TaskGitOptionsController {
  branchListStatus: Accessor<TaskBranchListStatus>;
  branchPickerStatus: Accessor<string>;
  branchPreviewConflictMessage: Accessor<string | undefined>;
  branchQuery: Accessor<string>;
  formatBranchOption: (branch: GitBranchInfo) => string;
  ignoredDirs: Accessor<string[]>;
  ignoredDirsError: Accessor<string | null>;
  ignoredDirsStatus: Accessor<TaskIgnoredDirsStatus>;
  ignoredDirsTruncated: Accessor<boolean>;
  reloadBranches: () => void;
  reloadIgnoredDirs: () => void;
  selectedBaseBranch: Accessor<string | null>;
  selectedBaseBranchAvailable: Accessor<boolean>;
  selectedBaseBranchForSubmit: Accessor<string | undefined>;
  selectedDirs: Accessor<Set<string>>;
  selectedProjectBaseBranchLabel: Accessor<string>;
  setBranchQuery: (query: string) => void;
  setSelectedBaseBranch: (branch: string | null) => void;
  toggleSelectedDir: (dir: string) => void;
  visibleBranchOptions: Accessor<GitBranchInfo[]>;
}

function getBackendErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : '';
  return message || 'Unknown backend error';
}

export function createTaskGitOptionsController(
  options: CreateTaskGitOptionsControllerOptions,
): TaskGitOptionsController {
  const [branchOptions, setBranchOptions] = createSignal<GitBranchInfo[]>([]);
  const [branchListStatus, setBranchListStatus] = createSignal<TaskBranchListStatus>('idle');
  const [branchListError, setBranchListError] = createSignal<string | null>(null);
  const [branchQuery, setBranchQuery] = createSignal('');
  const [selectedBaseBranch, setSelectedBaseBranch] = createSignal<string | null>(null);
  const [branchReloadId, setBranchReloadId] = createSignal(0);
  const [ignoredDirDiscovery, setIgnoredDirDiscovery] = createSignal<IgnoredDirDiscoveryState>({
    candidates: [],
    error: null,
    status: 'idle',
    truncated: false,
  });
  const [selectedDirs, setSelectedDirs] = createSignal<Set<string>>(new Set());
  const [ignoredDirsReloadId, setIgnoredDirsReloadId] = createSignal(0);

  createEffect(() => {
    branchReloadId();
    const active = options.active();
    const projectId = options.projectId();
    const projectRoot = options.projectRoot();
    const projectMode = options.projectMode();
    const projectBaseBranch = options.projectBaseBranch();
    setBranchQuery('');
    setSelectedBaseBranch(projectBaseBranch ?? null);
    setBranchOptions([]);
    setBranchListError(null);

    if (!active || !projectId || !projectRoot || projectMode === 'non-git') {
      setBranchListStatus('idle');
      return;
    }

    const requestController = new AbortController();
    setBranchListStatus('loading');
    void invokeWithAbortSignal(IPC.ListBranches, requestController.signal, { projectRoot })
      .then((result) => {
        if (requestController.signal.aborted) return;

        const branches = Array.isArray(result.branches) ? result.branches : [];
        const fallbackBranch = result.defaultBranch || branches[0]?.name || null;
        setBranchOptions(branches);
        setSelectedBaseBranch(projectBaseBranch ?? fallbackBranch);
        setBranchListError(null);
        setBranchListStatus('ready');
      })
      .catch((error: unknown) => {
        if (requestController.signal.aborted) return;

        setBranchOptions([]);
        setBranchListError(getBackendErrorMessage(error));
        setBranchListStatus('error');
      });

    onCleanup(() => {
      requestController.abort();
    });
  });

  createEffect(() => {
    ignoredDirsReloadId();
    const active = options.active();
    const projectId = options.projectId();
    const projectRoot = options.projectRoot();
    const projectMode = options.projectMode();
    const createsManagedWorktree = options.createsManagedWorktree();
    setIgnoredDirDiscovery({ candidates: [], error: null, status: 'idle', truncated: false });
    setSelectedDirs(new Set<string>());

    if (
      !active ||
      !projectId ||
      !projectRoot ||
      projectMode === 'non-git' ||
      !createsManagedWorktree
    ) {
      return;
    }

    const requestController = new AbortController();
    setIgnoredDirDiscovery({ candidates: [], error: null, status: 'loading', truncated: false });
    void invokeWithAbortSignal(IPC.GetGitignoredDirs, requestController.signal, { projectRoot })
      .then((result) => {
        if (requestController.signal.aborted) return;

        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        setIgnoredDirDiscovery({
          candidates,
          error: null,
          status: 'ready',
          truncated: result.truncated === true,
        });
        setSelectedDirs(
          new Set(candidates.filter((candidate) => candidate.isDefault).map(({ name }) => name)),
        );
      })
      .catch((error: unknown) => {
        if (requestController.signal.aborted) return;

        setSelectedDirs(new Set<string>());
        setIgnoredDirDiscovery({
          candidates: [],
          error: getBackendErrorMessage(error),
          status: 'unavailable',
          truncated: false,
        });
      });

    onCleanup(() => {
      requestController.abort();
    });
  });

  const ignoredDirs = createMemo(() =>
    ignoredDirDiscovery().candidates.map((candidate) => candidate.name),
  );
  const ignoredDirsError = createMemo(() => ignoredDirDiscovery().error);
  const ignoredDirsStatus = createMemo(() => ignoredDirDiscovery().status);
  const ignoredDirsTruncated = createMemo(() => ignoredDirDiscovery().truncated);

  const filteredBranchOptions = createMemo(() => {
    const query = branchQuery().trim().toLowerCase();
    if (!query) {
      return branchOptions();
    }

    return branchOptions().filter((branch) => branch.name.toLowerCase().includes(query));
  });

  const visibleBranchOptions = createMemo(() => {
    const selected = selectedBaseBranch();
    const filtered = filteredBranchOptions();
    if (!selected || filtered.some((branch) => branch.name === selected)) {
      return filtered;
    }

    const selectedBranch = branchOptions().find((branch) => branch.name === selected);
    return selectedBranch ? [selectedBranch, ...filtered] : filtered;
  });

  const selectedBaseBranchAvailable = createMemo(() => {
    const selected = selectedBaseBranch();
    if (!selected || branchListStatus() !== 'ready') {
      return true;
    }

    return branchOptions().some((branch) => branch.name === selected);
  });

  const selectedBaseBranchForSubmit = createMemo(() => selectedBaseBranch()?.trim() || undefined);

  const selectedProjectBaseBranchLabel = createMemo(() => {
    const baseBranch = selectedBaseBranch() ?? options.projectBaseBranch();
    return baseBranch ? `base branch (${baseBranch})` : 'base branch (detected on create)';
  });

  const branchPickerStatus = createMemo(() => {
    switch (branchListStatus()) {
      case 'idle':
        return '';
      case 'loading':
        return 'Loading branches...';
      case 'ready': {
        const count = branchOptions().length;
        return count === 1 ? '1 branch available.' : `${count} branches available.`;
      }
      case 'error':
        return `Branch list unavailable: ${branchListError() ?? 'Unknown backend error'}`;
    }
  });

  const branchPreviewConflictMessage = createMemo(() => {
    if (branchListStatus() !== 'ready') {
      return undefined;
    }

    const preview = options.branchPreview();
    if (!preview) {
      return undefined;
    }

    const localBranchNames = branchOptions()
      .filter((branch) => branch.local)
      .map((branch) => branch.name);
    const conflict = findBranchRefPrefixConflict(preview, localBranchNames);
    return conflict ? formatBranchRefPrefixConflict(conflict) : undefined;
  });

  function formatBranchOption(branch: GitBranchInfo): string {
    const qualifiers: string[] = [];
    if (branch.current) {
      qualifiers.push('current');
    }
    if (branch.remote && !branch.local) {
      qualifiers.push('remote');
    }
    if (branch.name === options.projectBaseBranch()) {
      qualifiers.push('project default');
    }

    return qualifiers.length === 0 ? branch.name : `${branch.name} (${qualifiers.join(', ')})`;
  }

  function reloadBranches(): void {
    setBranchReloadId((id) => id + 1);
  }

  function reloadIgnoredDirs(): void {
    setIgnoredDirsReloadId((id) => id + 1);
  }

  function toggleSelectedDir(dir: string): void {
    if (
      ignoredDirDiscovery().status !== 'ready' ||
      !ignoredDirDiscovery().candidates.some((candidate) => candidate.name === dir)
    ) {
      return;
    }

    const next = new Set(selectedDirs());
    if (next.has(dir)) {
      next.delete(dir);
    } else {
      next.add(dir);
    }
    setSelectedDirs(next);
  }

  return {
    branchListStatus,
    branchPickerStatus,
    branchPreviewConflictMessage,
    branchQuery,
    formatBranchOption,
    ignoredDirs,
    ignoredDirsError,
    ignoredDirsStatus,
    ignoredDirsTruncated,
    reloadBranches,
    reloadIgnoredDirs,
    selectedBaseBranch,
    selectedBaseBranchAvailable,
    selectedBaseBranchForSubmit,
    selectedDirs,
    selectedProjectBaseBranchLabel,
    setBranchQuery,
    setSelectedBaseBranch,
    toggleSelectedDir,
    visibleBranchOptions,
  };
}
