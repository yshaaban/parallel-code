// @vitest-environment jsdom

import { batch, createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../electron/ipc/channels';
import type { GitBranchInfo } from '../../ipc/types';
import type { ProjectMode } from '../../store/types';

const { invokeMock, invokeWithAbortSignalMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  return {
    invokeMock,
    invokeWithAbortSignalMock: vi.fn(
      (channel: IPC, _signal: AbortSignal, args?: { projectRoot: string }) =>
        invokeMock(channel, args),
    ),
  };
});

vi.mock('solid-js', () => vi.importActual<typeof import('solid-js')>('solid-js/dist/solid.js'));

vi.mock('../../lib/ipc', () => ({
  invokeWithAbortSignal: invokeWithAbortSignalMock,
}));

import { createTaskGitOptionsController } from './task-git-options-controller';

type Controller = ReturnType<typeof createTaskGitOptionsController>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createBranch(name: string, overrides: Partial<GitBranchInfo> = {}): GitBranchInfo {
  return {
    current: false,
    local: true,
    name,
    remote: false,
    ...overrides,
  };
}

function branchResult(branches: GitBranchInfo[], defaultBranch = 'main') {
  return { branches, defaultBranch, generatedAt: 123 };
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value');
  return value;
}

describe('task git options controller', () => {
  let disposeRoot: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    disposeRoot?.();
    disposeRoot = undefined;
  });

  function createController(
    options: {
      baseBranch?: string;
      branchPreview?: string;
      mode?: ProjectMode;
      projectId?: string;
      root?: string;
    } = {},
  ): {
    controller: Controller;
    setBaseBranch: (value: string | undefined) => void;
    setBranchPreview: (value: string) => void;
    setMode: (value: ProjectMode) => void;
    setProjectId: (value: string | null) => void;
    setRoot: (value: string | undefined) => void;
  } {
    const [projectId, setProjectId] = createSignal<string | null>(options.projectId ?? 'project-a');
    const [projectRoot, setRoot] = createSignal<string | undefined>(options.root ?? '/repo');
    const [projectMode, setMode] = createSignal<ProjectMode>(options.mode ?? 'git');
    const [projectBaseBranch, setBaseBranch] = createSignal<string | undefined>(options.baseBranch);
    const [branchPreview, setBranchPreview] = createSignal(options.branchPreview ?? 'task/ship-it');
    let controller: Controller | undefined;

    createRoot((dispose) => {
      disposeRoot = dispose;
      controller = createTaskGitOptionsController({
        branchPreview,
        projectBaseBranch,
        projectId,
        projectMode,
        projectRoot,
      });
    });

    if (!controller) throw new Error('Failed to create task git options controller');
    return { controller, setBaseBranch, setBranchPreview, setMode, setProjectId, setRoot };
  }

  function channelCalls(channel: IPC): unknown[][] {
    return invokeMock.mock.calls.filter(([calledChannel]) => calledChannel === channel);
  }

  it('loads branches and ignored directories independently on initialization', async () => {
    const branches = createDeferred<ReturnType<typeof branchResult>>();
    const ignoredDirs = createDeferred<string[]>();
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.ListBranches) {
        return branches.promise;
      }
      return ignoredDirs.promise;
    });

    const { controller } = createController({ baseBranch: 'main' });

    await vi.waitFor(() => {
      expect(channelCalls(IPC.ListBranches)).toHaveLength(1);
      expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(1);
    });
    expect(controller.branchListStatus()).toBe('loading');

    branches.resolve(
      branchResult([
        createBranch('main', { current: true, remote: true }),
        createBranch('release/main', { local: false, remote: true }),
      ]),
    );
    ignoredDirs.resolve(['node_modules', '.venv']);

    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));
    await vi.waitFor(() => expect(controller.ignoredDirs()).toEqual(['node_modules', '.venv']));
    expect(controller.selectedBaseBranch()).toBe('main');
    expect(controller.branchPickerStatus()).toBe('2 branches available.');
    expect([...controller.selectedDirs()]).toEqual(['node_modules', '.venv']);
    expect(controller.formatBranchOption(requireValue(controller.visibleBranchOptions()[0]))).toBe(
      'main (current, project default)',
    );
  });

  it('retries only the branch request after a branch-list failure', async () => {
    let branchAttempt = 0;
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.ListBranches) {
        branchAttempt += 1;
        return branchAttempt === 1
          ? Promise.reject(new Error('branch backend unavailable'))
          : Promise.resolve(branchResult([createBranch('main')]));
      }
      return Promise.resolve(['node_modules']);
    });

    const { controller } = createController();
    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('error'));
    expect(controller.branchPickerStatus()).toBe(
      'Branch list unavailable: branch backend unavailable',
    );

    controller.reloadBranches();

    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));
    expect(channelCalls(IPC.ListBranches)).toHaveLength(2);
    expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(1);
  });

  it('normalizes empty non-error rejections from both Git metadata requests', async () => {
    invokeMock.mockImplementation((channel: IPC) =>
      channel === IPC.ListBranches ? Promise.reject(undefined) : Promise.reject(null),
    );

    const { controller } = createController();

    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('error'));
    await vi.waitFor(() => expect(controller.ignoredDirsError()).toBe('Unknown backend error'));
    expect(controller.branchPickerStatus()).toBe('Branch list unavailable: Unknown backend error');
  });

  it('resets form-local Git state and reloads both data sources', async () => {
    invokeMock.mockImplementation((channel: IPC) =>
      channel === IPC.ListBranches
        ? Promise.resolve(
            branchResult([createBranch('main'), createBranch('release/main')], 'main'),
          )
        : Promise.resolve(['node_modules']),
    );

    const { controller } = createController({ baseBranch: 'main' });
    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));
    await vi.waitFor(() => expect(controller.ignoredDirs()).toEqual(['node_modules']));

    controller.setSelectedBaseBranch('release/main');
    controller.setBranchQuery('release');
    controller.toggleSelectedDir('node_modules');
    controller.reset();

    await vi.waitFor(() => {
      expect(channelCalls(IPC.ListBranches)).toHaveLength(2);
      expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(2);
      expect(controller.branchListStatus()).toBe('ready');
      expect([...controller.selectedDirs()]).toEqual(['node_modules']);
    });
    expect(controller.branchQuery()).toBe('');
    expect(controller.selectedBaseBranch()).toBe('main');
  });

  it('resets project-local choices when identity changes but Git configuration is identical', async () => {
    invokeMock.mockImplementation((channel: IPC) =>
      channel === IPC.ListBranches
        ? Promise.resolve(
            branchResult([createBranch('main'), createBranch('release/main')], 'main'),
          )
        : Promise.resolve(['node_modules']),
    );

    const { controller, setProjectId } = createController({ baseBranch: 'main' });
    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));
    await vi.waitFor(() => expect(controller.ignoredDirs()).toEqual(['node_modules']));

    controller.setSelectedBaseBranch('release/main');
    controller.setBranchQuery('release');
    controller.toggleSelectedDir('node_modules');
    setProjectId('project-b');

    await vi.waitFor(() => {
      expect(channelCalls(IPC.ListBranches)).toHaveLength(2);
      expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(2);
      expect(controller.branchListStatus()).toBe('ready');
      expect([...controller.selectedDirs()]).toEqual(['node_modules']);
    });
    expect(controller.branchQuery()).toBe('');
    expect(controller.selectedBaseBranch()).toBe('main');
  });

  it('suppresses stale branch and ignored-directory responses after a project change', async () => {
    const staleBranches = createDeferred<ReturnType<typeof branchResult>>();
    const staleIgnoredDirs = createDeferred<string[]>();
    invokeMock.mockImplementation((channel: IPC, args: { projectRoot: string }) => {
      if (args.projectRoot === '/repo-a') {
        return channel === IPC.ListBranches ? staleBranches.promise : staleIgnoredDirs.promise;
      }
      if (channel === IPC.ListBranches) {
        return Promise.resolve(branchResult([createBranch('develop')], 'develop'));
      }
      return Promise.resolve(['vendor']);
    });

    const { controller, setRoot } = createController({ root: '/repo-a' });
    await vi.waitFor(() => expect(channelCalls(IPC.ListBranches)).toHaveLength(1));
    const staleSignals = invokeWithAbortSignalMock.mock.calls.map(
      ([, signal]) => signal as AbortSignal,
    );

    setRoot('/repo-b');
    await vi.waitFor(() => expect(controller.selectedBaseBranch()).toBe('develop'));
    await vi.waitFor(() => expect(controller.ignoredDirs()).toEqual(['vendor']));
    expect(staleSignals).toHaveLength(2);
    expect(staleSignals.every((signal) => signal.aborted)).toBe(true);
    expect(
      invokeWithAbortSignalMock.mock.calls.slice(2).every(([, signal]) => !signal.aborted),
    ).toBe(true);

    staleBranches.resolve(branchResult([createBranch('stale-main')]));
    staleIgnoredDirs.resolve(['stale-dir']);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.visibleBranchOptions().map((branch) => branch.name)).toEqual(['develop']);
    expect(controller.ignoredDirs()).toEqual(['vendor']);
  });

  it('aborts active Git metadata requests when the controller is disposed', async () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));

    createController();
    await vi.waitFor(() => expect(invokeWithAbortSignalMock).toHaveBeenCalledTimes(2));
    const activeSignals = invokeWithAbortSignalMock.mock.calls.map(
      ([, signal]) => signal as AbortSignal,
    );

    disposeRoot?.();
    disposeRoot = undefined;

    expect(activeSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('clears the previous project ignored-directory selection while the next request is pending', async () => {
    const nextIgnoredDirs = createDeferred<string[]>();
    invokeMock.mockImplementation((channel: IPC, args: { projectRoot: string }) => {
      if (channel === IPC.ListBranches) {
        return Promise.resolve(branchResult([createBranch('main')]));
      }
      return args.projectRoot === '/repo-a'
        ? Promise.resolve(['node_modules'])
        : nextIgnoredDirs.promise;
    });

    const { controller, setRoot } = createController({ root: '/repo-a' });
    await vi.waitFor(() => expect([...controller.selectedDirs()]).toEqual(['node_modules']));

    setRoot('/repo-b');
    await vi.waitFor(() => expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(2));

    expect(controller.ignoredDirs()).toEqual([]);
    expect([...controller.selectedDirs()]).toEqual([]);

    nextIgnoredDirs.resolve(['vendor']);
    await vi.waitFor(() => expect([...controller.selectedDirs()]).toEqual(['vendor']));
  });

  it('clears git state for a non-git project without issuing more requests', async () => {
    invokeMock.mockImplementation((channel: IPC) =>
      channel === IPC.ListBranches
        ? Promise.resolve(branchResult([createBranch('main')]))
        : Promise.resolve(['node_modules']),
    );
    const { controller, setBaseBranch, setMode } = createController({ baseBranch: 'main' });
    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));

    batch(() => {
      setBaseBranch(undefined);
      setMode('non-git');
    });

    expect(controller.branchListStatus()).toBe('idle');
    expect(controller.visibleBranchOptions()).toEqual([]);
    expect(controller.selectedBaseBranch()).toBeNull();
    expect(controller.ignoredDirs()).toEqual([]);
    expect([...controller.selectedDirs()]).toEqual([]);
    expect(channelCalls(IPC.ListBranches)).toHaveLength(1);
    expect(channelCalls(IPC.GetGitignoredDirs)).toHaveLength(1);
  });

  it('keeps selection visible while filtering and derives local ref-prefix conflicts', async () => {
    invokeMock.mockImplementation((channel: IPC) =>
      channel === IPC.ListBranches
        ? Promise.resolve(
            branchResult([
              createBranch('main', { current: true }),
              createBranch('feature'),
              createBranch('release/main', { local: false, remote: true }),
            ]),
          )
        : Promise.resolve([]),
    );
    const { controller, setBranchPreview } = createController({
      baseBranch: 'main',
      branchPreview: 'feature/ship-it',
    });
    await vi.waitFor(() => expect(controller.branchListStatus()).toBe('ready'));

    expect(controller.branchPreviewConflictMessage()).toBe(
      'Cannot create branch "feature/ship-it" because local branch "feature" already uses that ref path. Choose a different branch prefix.',
    );
    controller.setSelectedBaseBranch('release/main');
    controller.setBranchQuery('feature');
    expect(controller.visibleBranchOptions().map((branch) => branch.name)).toEqual([
      'release/main',
      'feature',
    ]);
    expect(controller.selectedBaseBranchForSubmit()).toBe('release/main');
    expect(controller.selectedBaseBranchAvailable()).toBe(true);
    expect(controller.formatBranchOption(requireValue(controller.visibleBranchOptions()[0]))).toBe(
      'release/main (remote)',
    );

    setBranchPreview('release');
    expect(controller.branchPreviewConflictMessage()).toBeUndefined();
    controller.toggleSelectedDir('cache');
    expect([...controller.selectedDirs()]).toEqual(['cache']);
    controller.toggleSelectedDir('cache');
    expect([...controller.selectedDirs()]).toEqual([]);
  });
});
