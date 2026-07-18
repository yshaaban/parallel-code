import { batch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import { IPC } from '../../../electron/ipc/channels';
import type { GitBranchInfo } from '../../ipc/types';
import { findBranchRefPrefixConflict, formatBranchRefPrefixConflict } from '../../lib/branch-name';
import { invokeWithAbortSignal } from '../../lib/ipc';
import type { ProjectMode } from '../../store/types';

type TaskBranchListStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CreateTaskGitOptionsControllerOptions {
  branchPreview: Accessor<string>;
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
  reloadBranches: () => void;
  reset: () => void;
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
  const [ignoredDirs, setIgnoredDirs] = createSignal<string[]>([]);
  const [ignoredDirsError, setIgnoredDirsError] = createSignal<string | null>(null);
  const [selectedDirs, setSelectedDirs] = createSignal<Set<string>>(new Set());
  const [ignoredDirsReloadId, setIgnoredDirsReloadId] = createSignal(0);

  createEffect(() => {
    branchReloadId();
    const projectId = options.projectId();
    const projectRoot = options.projectRoot();
    const projectMode = options.projectMode();
    const projectBaseBranch = options.projectBaseBranch();
    setBranchQuery('');
    setSelectedBaseBranch(projectBaseBranch ?? null);
    setBranchOptions([]);
    setBranchListError(null);

    if (!projectId || !projectRoot || projectMode === 'non-git') {
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
    const projectId = options.projectId();
    const projectRoot = options.projectRoot();
    const projectMode = options.projectMode();
    setIgnoredDirs([]);
    setIgnoredDirsError(null);
    setSelectedDirs(new Set<string>());

    if (!projectId || !projectRoot || projectMode === 'non-git') {
      return;
    }

    const requestController = new AbortController();
    void invokeWithAbortSignal(IPC.GetGitignoredDirs, requestController.signal, { projectRoot })
      .then((dirs) => {
        if (requestController.signal.aborted) return;

        setIgnoredDirs(dirs);
        setSelectedDirs(new Set(dirs));
        setIgnoredDirsError(null);
      })
      .catch((error: unknown) => {
        if (requestController.signal.aborted) return;

        setIgnoredDirs([]);
        setSelectedDirs(new Set<string>());
        setIgnoredDirsError(getBackendErrorMessage(error));
      });

    onCleanup(() => {
      requestController.abort();
    });
  });

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

  function reset(): void {
    batch(() => {
      setBranchOptions([]);
      setBranchListStatus('idle');
      setBranchListError(null);
      setBranchQuery('');
      setSelectedBaseBranch(null);
      setIgnoredDirs([]);
      setIgnoredDirsError(null);
      setSelectedDirs(new Set<string>());
      setBranchReloadId((id) => id + 1);
      setIgnoredDirsReloadId((id) => id + 1);
    });
  }

  function toggleSelectedDir(dir: string): void {
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
    reloadBranches,
    reset,
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
