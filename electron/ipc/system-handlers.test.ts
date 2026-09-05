import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import type {
  BrowserColdBootstrapSnapshot,
  BrowserReconnectSnapshot,
} from '../../src/domain/renderer-invoke.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';
import { acquireTaskCommandLease, resetTaskCommandLeasesForTest } from './task-command-leases.js';
import { createTaskNameRegistry } from '../../server/task-names.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';
import { getServerInstanceId } from './server-instance.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';
import { TaskStructureMutationService } from './task-structure-mutations.js';
import {
  decodeWorkspaceHostRecord,
  WORKSPACE_HOST_ENVELOPE_KEY,
} from './workspace-state-storage.js';

const {
  inspectArenaCompetitorMock,
  getActiveAgentIdsMock,
  getAgentMetaMock,
  getAgentDefsWithLastKnownAvailabilityMock,
  getRecentProjectPathsMock,
  discoverProjectsMock,
  loadAppStateForEnvMock,
  loadWorkspaceStateForEnvMock,
  readPlanMock,
} = vi.hoisted(() => ({
  inspectArenaCompetitorMock: vi.fn(),
  getActiveAgentIdsMock: vi.fn(),
  getAgentMetaMock: vi.fn(),
  getAgentDefsWithLastKnownAvailabilityMock: vi.fn(),
  getRecentProjectPathsMock: vi.fn(),
  discoverProjectsMock: vi.fn(),
  loadAppStateForEnvMock: vi.fn(),
  loadWorkspaceStateForEnvMock: vi.fn(),
  readPlanMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    getActiveAgentIds: getActiveAgentIdsMock,
    getAgentMeta: getAgentMetaMock,
  };
});

vi.mock('./storage.js', async () => {
  const actual = await vi.importActual<typeof import('./storage.js')>('./storage.js');
  const { createSavedStateDocument } = await vi.importActual<
    typeof import('./saved-state-document.js')
  >('./saved-state-document.js');
  return {
    ...actual,
    loadAppStateForEnv: loadAppStateForEnvMock,
    loadWorkspaceStateForEnv: loadWorkspaceStateForEnvMock,
    loadAppStateDocumentForEnv: (env: unknown) => {
      const json = loadAppStateForEnvMock(env) as string | null;
      return json === null || json === undefined ? null : createSavedStateDocument(json);
    },
    loadWorkspaceStateDocumentForEnv: (env: unknown) => {
      const loaded = loadWorkspaceStateForEnvMock(env) as {
        json: string;
        revision: number;
      } | null;
      return loaded === null || loaded === undefined
        ? null
        : { document: createSavedStateDocument(loaded.json), revision: loaded.revision };
    },
  };
});

vi.mock('./arena-competitors.js', () => ({
  inspectArenaCompetitor: inspectArenaCompetitorMock,
}));

vi.mock('./agents.js', () => ({
  getAgentDefsWithLastKnownAvailability: getAgentDefsWithLastKnownAvailabilityMock,
}));

vi.mock('./plans.js', async () => {
  const actual = await vi.importActual<typeof import('./plans.js')>('./plans.js');
  return {
    ...actual,
    readPlan: readPlanMock,
  };
});

// The cold-bootstrap handler must never touch the availability prober: this
// hangs every probe path forever so any inline probing deadlocks the test.
vi.mock('./command-resolver.js', () => ({
  isCommandAvailable: () => new Promise<boolean>(() => {}),
}));

vi.mock('./hydra-adapter.js', () => ({
  getHydraRuntimeAvailability: () => new Promise(() => {}),
}));

vi.mock('./recent-projects.js', () => ({
  discoverProjects: discoverProjectsMock,
  getRecentProjectPaths: getRecentProjectPathsMock,
}));

import { createSystemIpcHandlers } from './system-handlers.js';
import type { SavedStateDocument } from './saved-state-document.js';

type SystemIpcHandlers = ReturnType<typeof createSystemIpcHandlers>;

let contextCounter = 0;

function buildContext(): HandlerContext {
  contextCounter += 1;
  return {
    userDataPath: `/tmp/parallel-code-tests-${contextCounter}`,
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

function buildOptions(): {
  beginTaskContentRootAdmission: (taskId: string) => null;
  beginTerminalContentRootAdmission: (request: { agentId?: string; taskId: string }) => null;
  getTaskName: (taskId: string) => string;
  syncProjectBaseBranchesFromJson: (state: SavedStateDocument) => void;
  syncTaskConvergenceFromJson: (state: SavedStateDocument) => void;
  syncTaskNamesFromJson: (state: SavedStateDocument) => void;
  syncTaskReviewSignalsFromJson: (state: SavedStateDocument) => void;
  syncTaskStepsFromJson: (state: SavedStateDocument) => void;
  syncTaskWorkflowWorktreesFromJson: (state: SavedStateDocument) => void;
} {
  return {
    beginTaskContentRootAdmission: () => null,
    beginTerminalContentRootAdmission: () => null,
    getTaskName: (taskId: string) => taskId,
    syncProjectBaseBranchesFromJson: vi.fn(),
    syncTaskConvergenceFromJson: vi.fn(),
    syncTaskNamesFromJson: vi.fn(),
    syncTaskReviewSignalsFromJson: vi.fn(),
    syncTaskStepsFromJson: vi.fn(),
    syncTaskWorkflowWorktreesFromJson: vi.fn(),
  };
}

async function getBrowserReconnectSnapshot(
  handlers: SystemIpcHandlers,
): Promise<BrowserReconnectSnapshot> {
  const snapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();
  if (!snapshot) {
    throw new Error('reconnect snapshot handler returned no snapshot');
  }
  return snapshot as BrowserReconnectSnapshot;
}

function getTestAgentGeneration(agentId: string): number {
  if (agentId === 'agent-2') {
    return 2;
  }
  return 1;
}

function createRemovalParticipant(
  id: 'agent-session' | 'initial-prompt' | 'task-runtime',
  hookSetVersion: string,
): TaskRemovalOwnerParticipant {
  return {
    async activateLegacyEffectCutover() {},
    async drainTaskForRemoval() {
      return { kind: 'complete' };
    },
    ...(id === 'task-runtime'
      ? {
          async cleanupTaskRuntimeStep(request) {
            return {
              evidence: { state: 'test-complete' },
              kind: 'step-complete' as const,
              step: request.step,
            };
          },
        }
      : {}),
    async finalizeRemovedTaskState() {
      return { kind: 'complete' };
    },
    hookSetVersion,
    id,
    async probe() {
      return { hookSetVersion, kind: 'ready' };
    },
    async verifyLegacyEffectCutover() {},
  };
}

describe('system handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));
    vi.clearAllMocks();
    resetBackendRuntimeDiagnostics();
    loadAppStateForEnvMock.mockReturnValue(null);
    loadWorkspaceStateForEnvMock.mockReturnValue(null);
    inspectArenaCompetitorMock.mockReset();
    getActiveAgentIdsMock.mockReturnValue([]);
    getAgentMetaMock.mockReturnValue({ generation: 0 });
    getAgentDefsWithLastKnownAvailabilityMock.mockReturnValue([]);
    readPlanMock.mockReturnValue(null);
    discoverProjectsMock.mockResolvedValue([]);
    getRecentProjectPathsMock.mockResolvedValue([]);
    resetTaskCommandLeasesForTest();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTaskCommandLeasesForTest();
  });

  it('reuses one workspace mutation authority and cleanup across handler composition', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-composition-'));
    const cleanups: Array<() => Promise<void>> = [];
    const context: HandlerContext = {
      ...buildContext(),
      registerWorkspaceMutationCleanup: (cleanup) => cleanups.push(cleanup),
      userDataPath,
      workspaceStorageKind: 'standalone',
    };

    try {
      const options = buildOptions();
      const firstHandlers = createSystemIpcHandlers(context, options);
      const host = context.workspaceMutations;
      if (!host) throw new Error('workspace mutation host was not composed');
      const firstRemovalGate = await host.getTaskRemovalLegacyWriterGate();
      const service = await host.getWorkspaceService();
      const replaceSharedState = vi.spyOn(service, 'replaceSharedState');
      const close = vi.spyOn(service, 'close');

      const secondHandlers = createSystemIpcHandlers(context, options);
      const recomposedRemovalGate =
        await context.workspaceMutations?.getTaskRemovalLegacyWriterGate();

      await expect(
        firstHandlers[IPC.SaveWorkspaceState]?.({
          baseRevision: 0,
          json: '{"projects":[],"taskOrder":[],"tasks":{}}',
          sourceId: 'first-composition',
        }),
      ).resolves.toEqual({ revision: 1 });
      await expect(
        secondHandlers[IPC.SaveWorkspaceState]?.({
          baseRevision: 1,
          json: '{"projects":[],"taskOrder":[],"tasks":{}}',
          sourceId: 'second-composition',
        }),
      ).resolves.toEqual({ revision: 2 });

      expect(recomposedRemovalGate).toBe(firstRemovalGate);
      expect(replaceSharedState).toHaveBeenCalledTimes(2);
      expect(options.syncTaskNamesFromJson).toHaveBeenCalledTimes(2);
      expect(cleanups).toHaveLength(1);
      const cleanup = cleanups[0];
      if (!cleanup) throw new Error('workspace cleanup was not composed');

      await expect(cleanup()).resolves.toBeUndefined();
      await expect(cleanup()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rejects recomposition with different saved-state callback identities', () => {
    const context = buildContext();
    const options = buildOptions();
    createSystemIpcHandlers(context, options);

    expect(() =>
      createSystemIpcHandlers(context, {
        ...options,
        syncTaskNamesFromJson: vi.fn(),
      }),
    ).toThrow(
      'System handler recomposition requires the same saved-state callback identity: syncTaskNamesFromJson',
    );
  });

  it('rejects recomposition after the context storage kind changes', () => {
    const context = buildContext();
    const options = buildOptions();
    createSystemIpcHandlers(context, options);
    context.workspaceStorageKind = 'electron';

    expect(() => createSystemIpcHandlers(context, options)).toThrow(
      'System handler recomposition cannot change the workspace storage kind',
    );
  });

  it('rejects an externally supplied workspace mutation host before composition', () => {
    const context: HandlerContext = {
      ...buildContext(),
      workspaceMutations: {
        getTaskMergeLegacyWriterGate: vi.fn(),
        getTaskRemovalLegacyWriterGate: vi.fn(),
        getTaskStructureService: vi.fn(),
        getWorkspaceService: vi.fn(),
      },
    };

    expect(() => createSystemIpcHandlers(context, buildOptions())).toThrow(
      'System handlers do not accept an externally supplied workspace mutation host',
    );
  });

  it('retries raw workspace-service initialization after a transient factory failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-init-retry-'));
    const userDataPath = path.join(root, 'user-data');
    const cleanups: Array<() => Promise<void>> = [];
    fs.writeFileSync(userDataPath, 'blocks directory creation');
    const context: HandlerContext = {
      ...buildContext(),
      isPackaged: true,
      registerWorkspaceMutationCleanup: (cleanup) => cleanups.push(cleanup),
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, buildOptions());
      const host = context.workspaceMutations;
      if (!host) throw new Error('workspace mutation host was not composed');

      await expect(host.getWorkspaceService()).rejects.toThrow();
      fs.rmSync(userDataPath, { force: true });
      fs.mkdirSync(userDataPath);
      await expect(host.getWorkspaceService()).resolves.toBeDefined();
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('cleans up idempotently when raw initialization rejected before creating a service', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-init-cleanup-'));
    const userDataPath = path.join(root, 'user-data');
    const cleanups: Array<() => Promise<void>> = [];
    fs.writeFileSync(userDataPath, 'blocks directory creation');
    const context: HandlerContext = {
      ...buildContext(),
      isPackaged: true,
      registerWorkspaceMutationCleanup: (cleanup) => cleanups.push(cleanup),
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, buildOptions());
      const host = context.workspaceMutations;
      const cleanup = cleanups[0];
      if (!host || !cleanup) throw new Error('workspace cleanup was not composed');

      await expect(host.getTaskMergeLegacyWriterGate()).rejects.toThrow();
      await expect(cleanup()).resolves.toBeUndefined();
      await expect(cleanup()).resolves.toBeUndefined();
      await expect(host.getWorkspaceService()).rejects.toThrow('closing or closed');
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('retries structure readiness on the retained owner after a transient cutover failure', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-cutover-retry-'));
    const cleanups: Array<() => Promise<void>> = [];
    const unsubscribe = vi.fn();
    const ensureSpy = vi
      .spyOn(TaskStructureMutationService.prototype, 'ensurePreManagedWriterCutover')
      .mockRejectedValueOnce(new Error('transient cutover failure'))
      .mockResolvedValue(undefined);
    const subscribeSpy = vi
      .spyOn(TaskStructureMutationService.prototype, 'subscribeTaskRemovalLifecycle')
      .mockReturnValue(unsubscribe);
    const context: HandlerContext = {
      ...buildContext(),
      registerWorkspaceMutationCleanup: (cleanup) => cleanups.push(cleanup),
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, {
        ...buildOptions(),
        onTaskRemovalLifecycle: vi.fn(),
      });
      const host = context.workspaceMutations;
      if (!host) throw new Error('workspace mutation host was not composed');

      await expect(host.getWorkspaceService()).rejects.toThrow('transient cutover failure');
      await expect(host.getWorkspaceService()).resolves.toBeDefined();
      expect(ensureSpy).toHaveBeenCalledTimes(2);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      ensureSpy.mockRestore();
      subscribeSpy.mockRestore();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('closes admission before deferred structure initialization can install a late subscription', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-init-cleanup-'));
    const cleanups: Array<() => Promise<void>> = [];
    const unsubscribe = vi.fn();
    let resolveCutover: () => void = () => {};
    const cutover = new Promise<void>((resolve) => {
      resolveCutover = resolve;
    });
    const ensureSpy = vi
      .spyOn(TaskStructureMutationService.prototype, 'ensurePreManagedWriterCutover')
      .mockReturnValue(cutover);
    const subscribeSpy = vi
      .spyOn(TaskStructureMutationService.prototype, 'subscribeTaskRemovalLifecycle')
      .mockReturnValue(unsubscribe);
    const context: HandlerContext = {
      ...buildContext(),
      registerWorkspaceMutationCleanup: (cleanup) => cleanups.push(cleanup),
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, {
        ...buildOptions(),
        onTaskRemovalLifecycle: vi.fn(),
      });
      const host = context.workspaceMutations;
      const cleanup = cleanups[0];
      if (!host || !cleanup) throw new Error('workspace cleanup was not composed');

      const initialization = host.getTaskStructureService();
      expect(subscribeSpy).not.toHaveBeenCalled();
      const cleanupAttempt = cleanup();
      resolveCutover();
      await expect(initialization).rejects.toThrow('closing or closed');
      await expect(cleanupAttempt).resolves.toBeUndefined();
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(subscribeSpy).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      await expect(host.getWorkspaceService()).rejects.toThrow('closing or closed');
    } finally {
      resolveCutover();
      await cleanups[0]?.().catch(() => undefined);
      ensureSpy.mockRestore();
      subscribeSpy.mockRestore();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('shares the process server identity with task-removal projections', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-identity-'));
    const context: HandlerContext = { ...buildContext(), userDataPath };
    let workspace: Awaited<
      ReturnType<NonNullable<HandlerContext['workspaceMutations']>['getWorkspaceService']>
    > | null = null;

    try {
      createSystemIpcHandlers(context, buildOptions());
      const host = context.workspaceMutations;
      if (!host) throw new Error('workspace mutation host was not composed');
      const structure = await host.getTaskStructureService();
      workspace = await host.getWorkspaceService();
      await structure.activateTaskRemovalOwner([
        createRemovalParticipant('initial-prompt', 'prompt-hooks-v1'),
        createRemovalParticipant('agent-session', 'agent-hooks-v1'),
        createRemovalParticipant('task-runtime', 'runtime-hooks-v1'),
      ]);

      const gate = structure.createTaskRemovalParticipantGate('initial-prompt', 'prompt-hooks-v1');
      expect(gate.getTaskSnapshot('not-visible-task')).toMatchObject({
        current: { serverInstanceId: getServerInstanceId() },
        kind: 'active',
      });
    } finally {
      await workspace?.close();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('retains workspace cleanup ownership after close failure and retries exactly', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-cleanup-'));
    const cleanups: Array<() => Promise<void>> = [];
    const context: HandlerContext = {
      ...buildContext(),
      registerWorkspaceMutationCleanup: (registeredCleanup) => {
        cleanups.push(registeredCleanup);
      },
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, buildOptions());
      const host = context.workspaceMutations;
      const cleanup = cleanups[0];
      if (!host || !cleanup) throw new Error('workspace cleanup was not composed');
      const service = await host.getWorkspaceService();
      const closeSpy = vi
        .spyOn(service, 'close')
        .mockRejectedValueOnce(new Error('transient workspace close failure'));

      await expect(cleanup()).rejects.toThrow('transient workspace close failure');
      await expect(host.getWorkspaceService()).rejects.toThrow('closing or closed');

      await expect(cleanup()).resolves.toBeUndefined();
      await expect(cleanup()).resolves.toBeUndefined();
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('retains task-removal subscription ownership when unsubscribe must be retried', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-unsubscribe-'));
    const cleanups: Array<() => Promise<void>> = [];
    const unsubscribe = vi.fn().mockImplementationOnce(() => {
      throw new Error('transient unsubscribe failure');
    });
    const subscribeSpy = vi
      .spyOn(TaskStructureMutationService.prototype, 'subscribeTaskRemovalLifecycle')
      .mockReturnValue(unsubscribe);
    const context: HandlerContext = {
      ...buildContext(),
      registerWorkspaceMutationCleanup: (registeredCleanup) => {
        cleanups.push(registeredCleanup);
      },
      userDataPath,
    };

    try {
      createSystemIpcHandlers(context, {
        ...buildOptions(),
        onTaskRemovalLifecycle: vi.fn(),
      });
      const host = context.workspaceMutations;
      const cleanup = cleanups[0];
      if (!host || !cleanup) throw new Error('workspace cleanup was not composed');
      await host.getTaskStructureService();

      await expect(cleanup()).rejects.toThrow('transient unsubscribe failure');
      await expect(cleanup()).resolves.toBeUndefined();
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    } finally {
      await cleanups[0]?.().catch(() => undefined);
      subscribeSpy.mockRestore();
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('returns null for clipboard-image paste when clipboard runtime support is unavailable', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    await expect(handlers[IPC.SaveClipboardImage]?.()).resolves.toBeNull();
  });

  it('returns an empty clipboard paste when clipboard runtime support is unavailable', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    await expect(handlers[IPC.ResolveClipboardPaste]?.()).resolves.toEqual({ kind: 'empty' });
  });

  it('returns a saved clipboard-image path when clipboard runtime support is available', async () => {
    const saveClipboardImage = vi.fn(async () => '/tmp/parallel-code-clipboard.png');
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        clipboard: { saveClipboardImage },
      },
      buildOptions(),
    );

    await expect(handlers[IPC.SaveClipboardImage]?.()).resolves.toBe(
      '/tmp/parallel-code-clipboard.png',
    );
    expect(saveClipboardImage).toHaveBeenCalledTimes(1);
  });

  it('returns resolved clipboard paste data when clipboard runtime support is available', async () => {
    const resolveClipboardPaste = vi.fn(async () => ({
      kind: 'file' as const,
      path: '/tmp/screenshot.png',
    }));
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        clipboard: {
          resolveClipboardPaste,
          saveClipboardImage: vi.fn(async () => null),
        },
      },
      buildOptions(),
    );

    await expect(handlers[IPC.ResolveClipboardPaste]?.()).resolves.toEqual({
      kind: 'file',
      path: '/tmp/screenshot.png',
    });
    expect(resolveClipboardPaste).toHaveBeenCalledTimes(1);
  });

  it('forwards discovered-project requests with validated force options', async () => {
    const discovered = [
      {
        name: 'app',
        path: '/repo/app',
        source: 'codex' as const,
        updatedAtMs: 1_000,
      },
    ];
    discoverProjectsMock.mockResolvedValue(discovered);
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    await expect(handlers[IPC.GetDiscoveredProjects]?.()).resolves.toEqual(discovered);
    expect(discoverProjectsMock).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), {
      force: false,
    });

    await expect(handlers[IPC.GetDiscoveredProjects]?.({ force: true })).resolves.toEqual(
      discovered,
    );
    expect(discoverProjectsMock).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), {
      force: true,
    });
  });

  it('rejects malformed discovered-project request payloads', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const getDiscoveredProjects = handlers[IPC.GetDiscoveredProjects] as (
      args?: unknown,
    ) => Promise<unknown>;

    await expect(getDiscoveredProjects('force')).rejects.toThrow(
      'get_discovered_projects payload must be an object',
    );
    await expect(getDiscoveredProjects({ force: 'true' })).rejects.toThrow(
      'force must be a boolean',
    );
    expect(discoverProjectsMock).not.toHaveBeenCalled();
  });

  it('forwards validated choice dialogs through dialog runtime support', async () => {
    const choose = vi.fn(async () => 1);
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        dialog: {
          choose,
          confirm: vi.fn(async () => true),
          open: vi.fn(async () => null),
        },
      },
      buildOptions(),
    );

    await expect(
      handlers[IPC.DialogChoose]?.({
        message: 'You have running terminal sessions.',
        choices: ['Kill & Quit', 'Keep in Background', 'Cancel'],
        defaultIndex: 1,
        cancelIndex: 2,
        kind: 'warning',
        title: 'Running Terminals',
      }),
    ).resolves.toBe(1);

    expect(choose).toHaveBeenCalledWith({
      message: 'You have running terminal sessions.',
      choices: ['Kill & Quit', 'Keep in Background', 'Cancel'],
      defaultIndex: 1,
      cancelIndex: 2,
      kind: 'warning',
      title: 'Running Terminals',
    });
  });

  it('rejects invalid choice dialog indexes before reaching dialog runtime support', async () => {
    const choose = vi.fn(async () => 0);
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        dialog: {
          choose,
          confirm: vi.fn(async () => true),
          open: vi.fn(async () => null),
        },
      },
      buildOptions(),
    );

    await expect(
      handlers[IPC.DialogChoose]?.({
        message: 'Choose one',
        choices: ['One', 'Two'],
        defaultIndex: 2,
      }),
    ).rejects.toThrow('defaultIndex must reference choices');
    await expect(
      handlers[IPC.DialogChoose]?.({
        message: 'Choose one',
        choices: ['One'],
      }),
    ).rejects.toThrow('choices must include at least two entries');

    expect(choose).not.toHaveBeenCalled();
  });

  it('saves dropped images through clipboard runtime support', async () => {
    const saveDroppedImage = vi.fn(async () => '/tmp/parallel-code-drop-screen.png');
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        clipboard: {
          saveClipboardImage: vi.fn(async () => null),
          saveDroppedImage,
        },
      },
      buildOptions(),
    );

    await expect(
      handlers[IPC.SaveDroppedImage]?.({ data: 'iVBORw==', name: 'screen.png' }),
    ).resolves.toBe('/tmp/parallel-code-drop-screen.png');
    expect(saveDroppedImage).toHaveBeenCalledWith({
      data: 'iVBORw==',
      name: 'screen.png',
    });
  });

  it('accepts renderer log payloads without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    const result = handlers[IPC.LogFromRenderer]?.({
      category: 'test',
      level: 'warn',
      level_min: 'warn',
      msg: 'renderer warning',
      ts: Date.now(),
    });

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('renderer.test'));

    warnSpy.mockRestore();
  });

  it('reads markdown files through backend task-root authority', async () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-md-'));
    const markdownPath = path.join(worktreePath, 'docs', 'guide.md');
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, '# Guide\n');

    const registry = createTaskNameRegistry();
    registry.registerCreatedTask('task-1', { worktreePath });
    const authority = createTerminalContentRootAuthority(registry);
    const handlers = createSystemIpcHandlers(buildContext(), {
      ...buildOptions(),
      beginTaskContentRootAdmission: authority.beginCanonicalTaskAdmission,
      beginTerminalContentRootAdmission: authority.beginTerminalAdmission,
    });
    const result = await handlers[IPC.ReadMarkdownFile]?.({
      relativePath: 'docs/guide.md',
      taskId: 'task-1',
    });

    expect(result).toEqual({
      content: '# Guide\n',
      fileName: 'guide.md',
      relativePath: 'docs/guide.md',
      worktreePath,
    });
  });

  it('fails closed for unknown task-content identities', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    await expect(
      handlers[IPC.ReadMarkdownFile]?.({ relativePath: 'docs/guide.md', taskId: 'unknown' }),
    ).resolves.toBeNull();
    expect(
      handlers[IPC.ReadPlanContent]?.({
        relativePath: 'docs/plans/plan.md',
        taskId: 'unknown',
      }),
    ).toBeNull();
  });

  it('rejects legacy renderer-selected task-content roots', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    await expect(
      handlers[IPC.ReadMarkdownFile]?.({
        relativePath: 'docs/guide.md',
        taskId: 'task-1',
        worktreePath: '/renderer/root',
      } as never),
    ).rejects.toThrow('worktreePath is not accepted');
    expect(() =>
      handlers[IPC.ReadPlanContent]?.({
        relativePath: 'docs/plans/plan.md',
        taskId: 'task-1',
        worktreePath: '/renderer/root',
      } as never),
    ).toThrow('worktreePath is not accepted');
  });

  it('forwards arena competitor inspection through the typed backend seam', async () => {
    inspectArenaCompetitorMock.mockResolvedValue({
      executable: 'claude',
      issues: [],
      status: 'ready',
    });

    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const result = await handlers[IPC.InspectArenaCompetitor]?.({
      commandTemplate: 'claude -p "{prompt}" --dangerously-skip-permissions',
    });

    expect(inspectArenaCompetitorMock).toHaveBeenCalledWith(
      'claude -p "{prompt}" --dangerously-skip-permissions',
    );
    expect(result).toEqual({
      executable: 'claude',
      issues: [],
      status: 'ready',
    });
  });

  it('marks invalid paths false instead of failing the entire batch', () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const validPath = process.cwd();

    const result = handlers[IPC.CheckPathsExist]?.({
      paths: [validPath, 'relative/path', '/tmp/../bad'],
    }) as Record<string, boolean>;

    expect(result).toEqual({
      [validPath]: true,
      'relative/path': false,
      '/tmp/../bad': false,
    });
  });

  it('dedupes reconnect saved-state reads through the revision-keyed cache until a save invalidates it', async () => {
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(buildContext(), options);
    loadAppStateForEnvMock.mockReturnValueOnce('{"version":1}');
    getActiveAgentIdsMock
      .mockReturnValueOnce(['agent-1'])
      .mockReturnValueOnce(['agent-2'])
      .mockReturnValueOnce(['agent-2']);

    const firstSnapshot = await getBrowserReconnectSnapshot(handlers);
    const secondSnapshot = await getBrowserReconnectSnapshot(handlers);

    expect(firstSnapshot).toEqual({
      agentGenerations: { 'agent-1': 0 },
      appStateJson: '{"version":1}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
    });
    expect(secondSnapshot).toEqual({
      ...firstSnapshot,
      agentGenerations: { 'agent-2': 0 },
      runningAgentIds: ['agent-2'],
    });
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(1);
    expect(getActiveAgentIdsMock).toHaveBeenCalledTimes(2);
    expect(options.syncTaskNamesFromJson).toHaveBeenCalledTimes(1);

    // The cache has no TTL: time alone does not expire it because every save
    // path invalidates it explicitly.
    await vi.advanceTimersByTimeAsync(60_000);

    const thirdSnapshot = await getBrowserReconnectSnapshot(handlers);

    expect(thirdSnapshot).toEqual({
      ...firstSnapshot,
      agentGenerations: { 'agent-2': 0 },
      runningAgentIds: ['agent-2'],
    });
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(1);
    expect(getActiveAgentIdsMock).toHaveBeenCalledTimes(3);
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      cacheHits: 2,
      cacheMisses: 1,
    });
  });

  it('shares one reconnect cache across recomposed maps and invalidates it from legacy SaveAppState', async () => {
    const context = buildContext();
    const options = buildOptions();
    const firstHandlers = createSystemIpcHandlers(context, options);
    const secondHandlers = createSystemIpcHandlers(context, options);
    loadAppStateForEnvMock
      .mockReturnValueOnce('{"version":1}')
      .mockReturnValueOnce('{"version":2}');

    const firstSnapshot = await getBrowserReconnectSnapshot(firstHandlers);
    const secondSnapshot = await getBrowserReconnectSnapshot(secondHandlers);
    await secondHandlers[IPC.SaveAppState]?.({ json: '{"version":2}' });
    const refreshedFirstSnapshot = await getBrowserReconnectSnapshot(firstHandlers);

    expect(firstSnapshot.appStateJson).toBe('{"version":1}');
    expect(secondSnapshot.appStateJson).toBe('{"version":1}');
    expect(refreshedFirstSnapshot.appStateJson).toBe('{"version":2}');
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(2);
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      cacheHits: 1,
      cacheInvalidations: 1,
      cacheMisses: 2,
    });
  });

  it('keeps live reconnect snapshot fields fresh while saved-state payload is cached', async () => {
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(buildContext(), options);
    loadAppStateForEnvMock.mockReturnValue('{"version":1}');
    getActiveAgentIdsMock.mockReturnValueOnce(['agent-1']).mockReturnValueOnce(['agent-2']);
    getAgentMetaMock.mockImplementation((agentId: string) => ({
      generation: getTestAgentGeneration(agentId),
    }));

    const firstSnapshot = await getBrowserReconnectSnapshot(handlers);
    acquireTaskCommandLease('task-1', 'client-1', 'owner-1', 'merge this task');
    const secondSnapshot = await getBrowserReconnectSnapshot(handlers);

    expect(firstSnapshot).toMatchObject({
      agentGenerations: { 'agent-1': 1 },
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
    });
    expect(secondSnapshot).toMatchObject({
      agentGenerations: { 'agent-2': 2 },
      runningAgentIds: ['agent-2'],
      taskCommandControllerVersion: 1,
      taskCommandControllers: [
        expect.objectContaining({
          action: 'merge this task',
          controllerId: 'client-1',
          taskId: 'task-1',
        }),
      ],
    });
    expect(secondSnapshot?.appStateJson).toBe(firstSnapshot?.appStateJson);
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(1);
    expect(getActiveAgentIdsMock).toHaveBeenCalledTimes(2);
  });

  it('returns lightweight reconnect status without loading full app state', () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    loadWorkspaceStateForEnvMock.mockReturnValue({
      json: '{"version":1}',
      revision: 7,
    });
    getActiveAgentIdsMock.mockReturnValue(['agent-1']);
    getAgentMetaMock.mockReturnValue({ generation: 5 });

    const status = handlers[IPC.GetBrowserReconnectStatus]?.();

    expect(status).toEqual({
      agentGenerations: { 'agent-1': 5 },
      runningAgentIds: ['agent-1'],
      serverInstanceId: expect.any(String),
      taskCommandControllerVersion: 0,
      workspaceRevision: 7,
    });
    expect(loadAppStateForEnvMock).not.toHaveBeenCalled();
  });

  it('returns a lightweight cold bootstrap snapshot with server-state categories', async () => {
    loadAppStateForEnvMock.mockReturnValue('{"version":1,"projects":[],"taskOrder":[],"tasks":{}}');
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        remoteAccess: {
          status: () => ({
            connectedClients: 0,
            enabled: false,
            peerClients: 0,
            port: 7777,
            tailscaleUrl: null,
            token: null,
            url: null,
            wifiUrl: null,
          }),
        } as HandlerContext['remoteAccess'],
      },
      buildOptions(),
    );

    const snapshot = (await handlers[IPC.GetBrowserColdBootstrap]?.()) as
      | BrowserColdBootstrapSnapshot
      | undefined;
    expect(snapshot).toBeDefined();
    if (!snapshot) {
      throw new Error('Missing browser cold bootstrap snapshot');
    }

    expect(snapshot).toMatchObject({
      workspaceRevision: 0,
      workspaceProjection: {
        projects: [],
        taskOrder: [],
        tasks: {},
      },
    });
    expect(snapshot).toEqual(
      expect.objectContaining({
        serverStateBootstrap: expect.arrayContaining([
          expect.objectContaining({
            category: 'remote-status',
            payload: expect.objectContaining({
              enabled: false,
            }),
          }),
          expect.objectContaining({
            category: 'task-command-controller',
            payload: [],
          }),
        ]),
      }),
    );
    expect(snapshot?.serverStateBootstrap).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'peer-presence',
        }),
      ]),
    );
  });

  it('drops persisted standalone terminals from cold bootstrap snapshots', async () => {
    loadAppStateForEnvMock.mockReturnValue(
      '{"version":1,"projects":[],"taskOrder":["terminal-1"],"tasks":{},"terminals":{"terminal-1":{"id":"terminal-1","name":"Shell","agentId":"terminal-agent-1"}}}',
    );
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        remoteAccess: {
          status: () => ({
            connectedClients: 0,
            enabled: false,
            peerClients: 0,
            port: 7777,
            tailscaleUrl: null,
            token: null,
            url: null,
            wifiUrl: null,
          }),
        } as HandlerContext['remoteAccess'],
      },
      buildOptions(),
    );

    const snapshot = await handlers[IPC.GetBrowserColdBootstrap]?.();

    expect(snapshot).toMatchObject({
      workspaceProjection: {
        taskOrder: [],
        tasks: {},
        terminals: {},
      },
    });
  });

  it('rejects invalid remote-access ports before starting the remote server', async () => {
    const start = vi.fn();
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        remoteAccess: {
          getStatusVersion: () => 0,
          start,
          stop: vi.fn(),
          status: vi.fn(),
          subscribe: vi.fn(),
        } as HandlerContext['remoteAccess'],
      },
      buildOptions(),
    );

    await expect(handlers[IPC.StartRemoteServer]?.({ port: 0 })).rejects.toThrow(
      'port must be an integer between 1 and 65535',
    );
    await expect(handlers[IPC.StartRemoteServer]?.({ port: 65_536 })).rejects.toThrow(
      'port must be an integer between 1 and 65535',
    );

    expect(start).not.toHaveBeenCalled();
  });

  it('invalidates a cached reconnect snapshot when app state is saved', async () => {
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(buildContext(), options);
    loadAppStateForEnvMock
      .mockReturnValueOnce('{"version":1}')
      .mockReturnValueOnce('{"version":2}');
    getActiveAgentIdsMock.mockReturnValueOnce(['agent-1']).mockReturnValueOnce(['agent-1']);

    const firstSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();
    handlers[IPC.SaveAppState]?.({
      json: '{"version":2}',
      sourceId: 'tab-1',
    });
    const secondSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();

    expect(firstSnapshot).toEqual({
      agentGenerations: { 'agent-1': 0 },
      appStateJson: '{"version":1}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
    });
    expect(secondSnapshot).toEqual({
      agentGenerations: { 'agent-1': 0 },
      appStateJson: '{"version":2}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
    });
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(2);
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ json: '{"version":1}' }),
    );
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ json: '{"version":2}' }),
    );
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ json: '{"version":2}' }),
    );
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      cacheHits: 0,
      cacheInvalidations: 1,
      cacheMisses: 2,
    });
  });

  it('delegates SaveWorkspaceState through the durable transaction with compatible result and event', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-workspace-'));
    const emitIpcEvent = vi.fn();
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        emitIpcEvent,
        isPackaged: true,
        userDataPath,
        workspaceStorageKind: 'standalone',
      },
      options,
    );

    try {
      await expect(
        handlers[IPC.SaveWorkspaceState]?.({
          baseRevision: 0,
          json: '{"tasks":{},"taskOrder":[],"projects":[]}',
          sourceId: 'tab-1',
        }),
      ).resolves.toEqual({ revision: 1 });

      const decoded = decodeWorkspaceHostRecord(
        fs.readFileSync(path.join(userDataPath, 'workspace-state.json'), 'utf8'),
        'standalone',
      );
      expect(decoded.record).toMatchObject({
        sharedRevision: 1,
        sharedState: { projects: [], taskOrder: [], tasks: {} },
        storageGeneration: '2',
      });
      expect(options.syncTaskNamesFromJson).toHaveBeenCalledOnce();
      expect(options.syncProjectBaseBranchesFromJson).toHaveBeenCalledOnce();
      expect(emitIpcEvent).toHaveBeenCalledWith(IPC.WorkspaceStateChanged, {
        revision: 1,
        savedAt: Date.now(),
        sourceId: 'tab-1',
      });
    } finally {
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('returns the existing SaveWorkspaceState conflict before syncing or emitting', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-conflict-'));
    const emitIpcEvent = vi.fn();
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        emitIpcEvent,
        isPackaged: true,
        userDataPath,
        workspaceStorageKind: 'standalone',
      },
      options,
    );

    try {
      await handlers[IPC.SaveWorkspaceState]?.({ baseRevision: 0, json: '{"tasks":{}}' });
      vi.clearAllMocks();
      await expect(
        handlers[IPC.SaveWorkspaceState]?.({ baseRevision: 0, json: '{"tasks":{}}' }),
      ).rejects.toThrow('Workspace state revision conflict');
      expect(options.syncTaskNamesFromJson).not.toHaveBeenCalled();
      expect(emitIpcEvent).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('migrates Electron SaveAppState in one state.json while preserving its wire result and local fields', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-system-electron-'));
    fs.writeFileSync(
      path.join(userDataPath, 'state.json'),
      JSON.stringify({ activeTaskId: null, projects: [], taskOrder: [], tasks: {} }),
    );
    const emitIpcEvent = vi.fn();
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        emitIpcEvent,
        isPackaged: true,
        userDataPath,
        workspaceStorageKind: 'electron',
      },
      buildOptions(),
    );

    try {
      await expect(
        handlers[IPC.SaveAppState]?.({
          baseRevision: 0,
          json: JSON.stringify({
            activeTaskId: 'task-1',
            projects: [],
            taskOrder: [],
            tasks: {},
            windowState: { height: 600, width: 800 },
          }),
          sourceId: 'desktop-1',
        }),
      ).resolves.toBeUndefined();

      const root = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(root).toMatchObject({
        activeTaskId: 'task-1',
        taskOrder: [],
        windowState: { height: 600, width: 800 },
      });
      expect(root[WORKSPACE_HOST_ENVELOPE_KEY]).toBeDefined();
      expect(fs.existsSync(path.join(userDataPath, 'workspace-state.json'))).toBe(false);
      expect(emitIpcEvent).toHaveBeenCalledWith(
        IPC.SaveAppState,
        expect.objectContaining({ sourceId: 'desktop-1' }),
      );
      expect(emitIpcEvent).toHaveBeenCalledWith(
        IPC.WorkspaceStateChanged,
        expect.objectContaining({ revision: 1, sourceId: 'desktop-1' }),
      );
    } finally {
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('omits both saved-state payloads when knownWorkspaceRevision matches the current revision', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    loadWorkspaceStateForEnvMock.mockReturnValue({
      json: '{"version":9}',
      revision: 7,
    });
    getActiveAgentIdsMock.mockReturnValue(['agent-1']);
    getAgentMetaMock.mockReturnValue({ generation: 3 });
    acquireTaskCommandLease('task-1', 'client-1', 'owner-1', 'merge this task');

    const snapshot = (await handlers[IPC.GetBrowserReconnectSnapshot]?.({
      knownWorkspaceRevision: 7,
    })) as BrowserReconnectSnapshot;

    expect(snapshot.workspaceStateJson).toBeUndefined();
    expect(snapshot.appStateJson).toBeUndefined();
    expect(snapshot).toMatchObject({
      agentGenerations: { 'agent-1': 3 },
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 1,
      taskCommandControllers: [
        expect.objectContaining({
          controllerId: 'client-1',
          taskId: 'task-1',
        }),
      ],
      workspaceRevision: 7,
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      revisionSkips: 1,
    });
    expect(loadAppStateForEnvMock).not.toHaveBeenCalled();
  });

  it('ships the full workspace payload when knownWorkspaceRevision is stale and never loads legacy app state', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    loadWorkspaceStateForEnvMock.mockReturnValue({
      json: '{"version":9}',
      revision: 7,
    });

    const snapshot = (await handlers[IPC.GetBrowserReconnectSnapshot]?.({
      knownWorkspaceRevision: 6,
    })) as BrowserReconnectSnapshot;

    expect(snapshot.workspaceStateJson).toBe('{"version":9}');
    expect(snapshot.appStateJson).toBeUndefined();
    expect(snapshot.workspaceRevision).toBe(7);
    expect(loadAppStateForEnvMock).not.toHaveBeenCalled();
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      revisionSkips: 0,
    });
  });

  it('rejects malformed knownWorkspaceRevision payloads as bad requests', () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    expect(() =>
      handlers[IPC.GetBrowserReconnectSnapshot]?.({ knownWorkspaceRevision: 'seven' }),
    ).toThrow('knownWorkspaceRevision must be a finite number');
  });

  it('keeps appStateJson as the single legacy payload when no workspace-state file exists', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    loadAppStateForEnvMock.mockReturnValue('{"version":4}');
    loadWorkspaceStateForEnvMock.mockReturnValue(null);

    const snapshot = await getBrowserReconnectSnapshot(handlers);

    expect(snapshot.appStateJson).toBe('{"version":4}');
    // Single-copy contract: the legacy fallback must not duplicate the full
    // serialized state into workspaceStateJson.
    expect(snapshot.workspaceStateJson).toBeUndefined();
    expect(snapshot.workspaceRevision).toBe(0);
  });

  it('never skips the legacy payload when knownWorkspaceRevision is 0 and no workspace-state file exists', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    loadAppStateForEnvMock.mockReturnValue('{"version":4}');
    loadWorkspaceStateForEnvMock.mockReturnValue(null);

    const snapshot = (await handlers[IPC.GetBrowserReconnectSnapshot]?.({
      knownWorkspaceRevision: 0,
    })) as BrowserReconnectSnapshot;

    // Revision 0 is the unversioned legacy fallback: legacy SaveAppState
    // mutates the file without a revision bump, so 0 === 0 proves nothing and
    // the full payload must still ship.
    expect(snapshot.appStateJson).toBe('{"version":4}');
    expect(snapshot.workspaceRevision).toBe(0);
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      revisionSkips: 0,
    });
  });

  function buildRemoteAccessContext(): HandlerContext {
    return {
      ...buildContext(),
      remoteAccess: {
        status: () => ({
          connectedClients: 0,
          enabled: false,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: null,
          url: null,
          wifiUrl: null,
        }),
      } as HandlerContext['remoteAccess'],
    };
  }

  function buildPlanWorkspaceJson(existingProjectPath: string, missingProjectPath: string): string {
    return JSON.stringify({
      version: 1,
      projects: [
        { color: '#336699', id: 'p1', name: 'Project One', path: existingProjectPath },
        { color: '#336699', id: 'p2', name: 'Project Two', path: missingProjectPath },
      ],
      taskOrder: ['task-1', 'task-2'],
      tasks: {
        'task-1': {
          agentIds: ['agent-1'],
          branchName: 'branch-1',
          id: 'task-1',
          lastPrompt: '',
          name: 'Task One',
          notes: '',
          planRelativePath: '.claude/plans/plan-1.md',
          projectId: 'p1',
          shellAgentIds: [],
          worktreePath: '/tmp/worktree-1',
        },
        'task-2': {
          agentIds: ['agent-2'],
          branchName: 'branch-2',
          id: 'task-2',
          lastPrompt: '',
          name: 'Task Two',
          notes: '',
          projectId: 'p1',
          shellAgentIds: [],
          worktreePath: '/tmp/worktree-2',
        },
      },
    });
  }

  it('resolves the cold bootstrap synchronously with last-known agents while the prober is hung', async () => {
    // The command-resolver/hydra prober mocks at the top of this file hang
    // forever; if the handler probed availability inline this test would never
    // resolve. Agent defs come from the sticky last-known availability seam.
    getAgentDefsWithLastKnownAvailabilityMock.mockReturnValue([]);
    loadAppStateForEnvMock.mockReturnValue('{"version":1,"projects":[],"taskOrder":[],"tasks":{}}');
    const handlers = createSystemIpcHandlers(buildRemoteAccessContext(), buildOptions());

    const snapshot = (await handlers[IPC.GetBrowserColdBootstrap]?.()) as
      | BrowserColdBootstrapSnapshot
      | undefined;

    expect(snapshot).toBeDefined();
    expect(getAgentDefsWithLastKnownAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(snapshot?.serverStateBootstrap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'agent-availability',
          payload: [],
        }),
      ]),
    );
  });

  it('folds plan contents and project-path existence into the cold bootstrap payload', async () => {
    const existingProjectPath = os.tmpdir();
    const missingProjectPath = path.join(os.tmpdir(), 'parallel-code-missing-project-path');
    loadWorkspaceStateForEnvMock.mockReturnValue({
      json: buildPlanWorkspaceJson(existingProjectPath, missingProjectPath),
      revision: 3,
    });
    readPlanMock.mockImplementation(
      (beginAdmission: () => { root: string }, relativePath: string) => ({
        content: `plan for ${beginAdmission().root}`,
        fileName: path.basename(relativePath),
        relativePath,
      }),
    );
    const handlers = createSystemIpcHandlers(buildRemoteAccessContext(), {
      ...buildOptions(),
      beginTaskContentRootAdmission: (taskId) =>
        ({ root: `/tmp/worktree-${taskId.slice(-1)}` }) as never,
    });

    const snapshot = (await handlers[IPC.GetBrowserColdBootstrap]?.()) as
      | BrowserColdBootstrapSnapshot
      | undefined;

    expect(snapshot?.planContents).toEqual([
      {
        content: 'plan for /tmp/worktree-1',
        fileName: 'plan-1.md',
        relativePath: '.claude/plans/plan-1.md',
        taskId: 'task-1',
      },
    ]);
    expect(readPlanMock).toHaveBeenCalledTimes(1);
    expect(readPlanMock).toHaveBeenCalledWith(expect.any(Function), '.claude/plans/plan-1.md');
    expect(snapshot?.projectPathsExist).toEqual({
      [existingProjectPath]: true,
      [missingProjectPath]: false,
    });
  });

  it('caps cold bootstrap plan contents by total bytes', async () => {
    const workspaceJson = JSON.stringify({
      version: 1,
      projects: [],
      taskOrder: ['task-1', 'task-2'],
      tasks: {
        'task-1': {
          agentIds: [],
          branchName: 'branch-1',
          id: 'task-1',
          lastPrompt: '',
          name: 'Task One',
          notes: '',
          planRelativePath: '.claude/plans/plan-1.md',
          projectId: 'p1',
          shellAgentIds: [],
          worktreePath: '/tmp/worktree-1',
        },
        'task-2': {
          agentIds: [],
          branchName: 'branch-2',
          id: 'task-2',
          lastPrompt: '',
          name: 'Task Two',
          notes: '',
          planRelativePath: '.claude/plans/plan-2.md',
          projectId: 'p1',
          shellAgentIds: [],
          worktreePath: '/tmp/worktree-2',
        },
      },
    });
    loadWorkspaceStateForEnvMock.mockReturnValue({ json: workspaceJson, revision: 1 });
    readPlanMock.mockImplementation((_beginAdmission: unknown, relativePath: string) => ({
      content: 'x'.repeat(1_500_000),
      fileName: path.basename(relativePath),
      relativePath,
    }));
    const handlers = createSystemIpcHandlers(buildRemoteAccessContext(), buildOptions());

    const snapshot = (await handlers[IPC.GetBrowserColdBootstrap]?.()) as
      | BrowserColdBootstrapSnapshot
      | undefined;

    expect(snapshot?.planContents?.map((entry) => entry.taskId)).toEqual(['task-1']);
  });
});
