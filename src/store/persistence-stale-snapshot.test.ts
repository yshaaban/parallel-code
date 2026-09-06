import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { createTestProject, resetStoreForTest } from '../test/store-test-helpers';
import { setStore, store } from './core';
import {
  applyBrowserColdBootstrapWorkspaceProjection,
  applyLoadedWorkspaceStateJson,
} from './persistence-load';
import { buildBrowserColdBootstrapProjectionFromJson } from './browser-cold-bootstrap-projection';
import {
  getWorkspaceStateSnapshotJson,
  saveBrowserWorkspaceStateSnapshot,
} from './persistence-save';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  resetTaskCommandControllerStateForTests,
} from './task-command-controllers';
import {
  enqueueWorkspaceEditIntent,
  getLoadedWorkspaceRevision,
  getLoadedWorkspaceStateJson,
  getPendingWorkspaceEditIntents,
  getWorkspaceEditIntentConflicts,
  recordLoadedWorkspaceState,
  resetPersistenceSessionStateForTests,
} from './persistence-session';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  invokeWithAbortSignal: vi.fn(),
  isElectronRuntime: () => false,
}));

function workspace(name: string) {
  return JSON.stringify({
    projects: [createTestProject()],
    taskOrder: ['task-1'],
    collapsedTaskOrder: [],
    tasks: {
      'task-1': {
        id: 'task-1',
        name,
        projectId: 'project-1',
        taskMode: 'terminal',
        branchName: 'task/one',
        worktreePath: '/tmp/project/task-1',
        notes: '',
        lastPrompt: '',
        agentDef: null,
        agentId: null,
        shellCount: 1,
        shellAgentIds: ['shell-1'],
      },
    },
  });
}

describe('canonical workspace snapshot ordering', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    resetStoreForTest();
    resetPersistenceSessionStateForTests();
    resetTaskCommandControllerStateForTests();
  });

  it('refreshes a conflicting browser save once and rebases local edits before the next save', async () => {
    applyLoadedWorkspaceStateJson(workspace('Current'), 5);
    enqueueWorkspaceEditIntent({
      kind: 'rename-task',
      taskId: 'task-1',
      baseName: 'Current',
      nextName: 'Local draft',
      operationId: 'rename-during-reload',
    });
    setStore('tasks', 'task-1', 'name', 'Local draft');
    const staleSnapshot = getWorkspaceStateSnapshotJson();
    const peerWorkspace = JSON.parse(workspace('Current'));
    peerWorkspace.tasks['task-1'].notes = 'Peer notes';
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('Workspace state revision conflict'))
      .mockResolvedValueOnce({ json: JSON.stringify(peerWorkspace), revision: 6 })
      .mockResolvedValueOnce({ revision: 7 });

    await expect(saveBrowserWorkspaceStateSnapshot(staleSnapshot)).rejects.toThrow(
      'Workspace state revision conflict',
    );
    expect(vi.mocked(invoke).mock.calls.map(([channel]) => channel)).toEqual([
      IPC.SaveWorkspaceState,
      IPC.LoadWorkspaceState,
    ]);
    expect(getLoadedWorkspaceRevision()).toBe(6);
    expect(store.tasks['task-1']?.name).toBe('Local draft');
    expect(store.tasks['task-1']?.notes).toBe('Peer notes');
    expect(getPendingWorkspaceEditIntents()).toEqual([
      expect.objectContaining({ acknowledgedBaseRevision: 6, operationId: 'rename-during-reload' }),
    ]);

    const rebasedSnapshot = getWorkspaceStateSnapshotJson();
    await saveBrowserWorkspaceStateSnapshot(rebasedSnapshot);
    expect(invoke).toHaveBeenLastCalledWith(
      IPC.SaveWorkspaceState,
      expect.objectContaining({ baseRevision: 6, json: rebasedSnapshot }),
    );
    expect(getLoadedWorkspaceRevision()).toBe(7);
    expect(getPendingWorkspaceEditIntents()).toEqual([]);
  });

  it('does not rewind a newer live snapshot while refreshing a rejected browser save', async () => {
    applyLoadedWorkspaceStateJson(workspace('Current'), 5);
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('Workspace state revision conflict'))
      .mockImplementationOnce(async () => {
        applyLoadedWorkspaceStateJson(workspace('Newest'), 8);
        return { json: workspace('Older refresh'), revision: 6 };
      });
    await expect(
      saveBrowserWorkspaceStateSnapshot(getWorkspaceStateSnapshotJson()),
    ).rejects.toThrow('Workspace state revision conflict');
    expect(getLoadedWorkspaceRevision()).toBe(8);
    expect(store.tasks['task-1']?.name).toBe('Newest');
  });

  it('does not fetch or retry after an unrelated browser save failure', async () => {
    applyLoadedWorkspaceStateJson(workspace('Current'), 5);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Transport disconnected'));
    await expect(
      saveBrowserWorkspaceStateSnapshot(getWorkspaceStateSnapshotJson()),
    ).rejects.toThrow('Transport disconnected');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getLoadedWorkspaceRevision()).toBe(5);
  });

  it('ignores a late save acknowledgement without rewinding the next edit base', () => {
    const canonical = workspace('Current');
    expect(applyLoadedWorkspaceStateJson(canonical, 4)).toBe(true);
    expect(recordLoadedWorkspaceState(workspace('Old save'), 3)).toEqual([]);
    enqueueWorkspaceEditIntent({
      kind: 'rename-task',
      taskId: 'task-1',
      baseName: 'Current',
      nextName: 'Local draft',
      operationId: 'after-delayed-save',
    });
    expect(getLoadedWorkspaceRevision()).toBe(4);
    expect(getLoadedWorkspaceStateJson()).toBe(canonical);
    expect(getPendingWorkspaceEditIntents()).toEqual([
      expect.objectContaining({ acknowledgedBaseRevision: 4, operationId: 'after-delayed-save' }),
    ]);
    expect(getWorkspaceEditIntentConflicts()).toEqual([]);
  });

  it('ignores a late command response without retiring current tasks or rebasing pending edits', () => {
    expect(applyLoadedWorkspaceStateJson(workspace('Current'), 4)).toBe(true);
    enqueueWorkspaceEditIntent({
      kind: 'rename-task',
      taskId: 'task-1',
      baseName: 'Current',
      nextName: 'Local draft',
      operationId: 'local-rename',
    });
    setStore('tasks', 'task-1', 'name', 'Local draft');
    const pending = getPendingWorkspaceEditIntents();
    expect(
      applyLoadedWorkspaceStateJson(JSON.stringify({ projects: [], taskOrder: [], tasks: {} }), 3),
    ).toBe(false);
    expect(store.tasks['task-1']?.name).toBe('Local draft');
    expect(store.tasks['task-1']?.shellAgentIds).toEqual(['shell-1']);
    expect(getLoadedWorkspaceRevision()).toBe(4);
    expect(getPendingWorkspaceEditIntents()).toEqual(pending);
    expect(getWorkspaceEditIntentConflicts()).toEqual([]);
    expect(store.notification).toBeNull();
    expect(applyLoadedWorkspaceStateJson(workspace('Current'), 5)).toBe(true);
    expect(store.tasks['task-1']?.name).toBe('Local draft');
    expect(getLoadedWorkspaceRevision()).toBe(5);
  });

  it('ignores a late cold-bootstrap projection before it clears current runtime state', () => {
    expect(applyLoadedWorkspaceStateJson(workspace('Current'), 4)).toBe(true);
    const projection = {
      availableAgents: [],
      collapsedTaskOrder: [],
      completedTaskCount: 0,
      completedTaskDate: store.completedTaskDate,
      customAgents: [],
      hydraCommand: '',
      hydraForceDispatchFromPromptPanel: true,
      hydraStartupMode: 'auto' as const,
      lastProjectId: null,
      mergedLinesAdded: 0,
      mergedLinesRemoved: 0,
      mergeProgress: null,
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    };
    expect(applyBrowserColdBootstrapWorkspaceProjection(projection, 3)).toBe(false);
    expect(store.tasks['task-1']?.name).toBe('Current');
    expect(store.taskOrder).toEqual(['task-1']);
    expect(getLoadedWorkspaceRevision()).toBe(4);
  });

  it.each([
    [0, 0],
    [4, 4],
    [4, 5],
  ])(
    'preserves an acquired controller when canonical revision %s precedes cold bootstrap %s',
    (revision, bootstrapRevision) => {
      const canonical = workspace('Current');
      expect(applyLoadedWorkspaceStateJson(canonical, revision)).toBe(true);
      const projection = buildBrowserColdBootstrapProjectionFromJson(canonical, {
        currentAvailableAgents: [],
        currentCustomAgents: [],
      });
      applyTaskCommandControllerChanged({
        taskId: 'task-1',
        controllerId: 'browser-restoring-task',
        action: 'restore this task',
        version: 9,
      });
      const acquired = getTaskCommandController('task-1');
      expect(acquired?.controllerId).toBe('browser-restoring-task');
      setStore('activeTaskId', 'task-1');
      setStore('focusedPanel', 'task-1', 'shell:0');

      const applied = applyBrowserColdBootstrapWorkspaceProjection(projection, bootstrapRevision);

      expect(getTaskCommandController('task-1')).toEqual(acquired);
      expect(applied).toBe(false);
      expect(store.activeTaskId).toBe('task-1');
      expect(store.focusedPanel['task-1']).toBe('shell:0');
      expect(getLoadedWorkspaceStateJson()).toBe(canonical);
      expect(getLoadedWorkspaceRevision()).toBe(revision);
    },
  );

  it('still admits revision-zero cold bootstrap before a canonical workspace is loaded', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(workspace('Initial'), {
      currentAvailableAgents: [],
      currentCustomAgents: [],
    });
    expect(getLoadedWorkspaceStateJson()).toBeNull();
    expect(applyBrowserColdBootstrapWorkspaceProjection(projection, 0)).toBe(true);
    expect(store.tasks['task-1']?.name).toBe('Initial');
    expect(getLoadedWorkspaceRevision()).toBe(0);
  });
});
