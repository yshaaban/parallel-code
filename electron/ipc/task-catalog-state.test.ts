import { describe, expect, it, vi } from 'vitest';

import {
  TASK_CATALOG_LIMITS,
  isRemoteAgentChoice,
  isTaskCatalogDeltaBatch,
  isTaskCatalogEvent,
  type RemoteAgentChoice,
  type TaskCatalogEntityKind,
  type TaskCatalogPage,
  type TaskCatalogReplaceManifest,
} from '../../src/domain/task-catalog.js';
import { createTaskCatalogState } from './task-catalog-state.js';
import type { JsonObject } from './workspace-state-storage.js';

const SERVER_ID = 'server-1';

function project(id = 'project-1', overrides: JsonObject = {}): JsonObject {
  return {
    id,
    name: 'Project one',
    path: '/private/projects/project-one',
    projectMode: 'git',
    ...overrides,
  };
}

function task(id = 'task-1', overrides: JsonObject = {}): JsonObject {
  return {
    agentIds: [],
    branchName: 'feature/private-branch',
    command: 'secret-command --token private',
    gitIsolation: 'current-branch',
    id,
    name: 'Task one',
    notes: 'private notes',
    projectId: 'project-1',
    prompt: 'private initial prompt',
    shellAgentIds: ['shell-1'],
    taskMode: 'terminal',
    ...overrides,
  };
}

function sharedState(tasks: JsonObject = { 'task-1': task() }): JsonObject {
  return {
    collapsedTaskOrder: [],
    projects: [project()],
    taskOrder: Object.keys(tasks),
    tasks,
  };
}

function staticAgent(overrides: Partial<RemoteAgentChoice> = {}): RemoteAgentChoice {
  return {
    agentDefId: 'agent-def-1',
    displayName: 'Codex',
    displayNameTruncated: false,
    glyph: null,
    glyphTruncated: false,
    providerLabel: 'OpenAI',
    providerLabelTruncated: false,
    supportsInitialPrompt: true,
    supportsPermissionBypass: true,
    ...overrides,
  };
}

function foundManifest(
  state: ReturnType<typeof createTaskCatalogState>,
): TaskCatalogReplaceManifest {
  const result = state.createManifest();
  expect(result.kind).toBe('found');
  if (result.kind !== 'found') throw new Error('Expected catalog manifest');
  return result.value;
}

function foundPage(
  state: ReturnType<typeof createTaskCatalogState>,
  manifest: TaskCatalogReplaceManifest,
  kind: TaskCatalogEntityKind,
  cursor?: string,
): TaskCatalogPage {
  const result = state.getPage({
    catalogVersion: manifest.catalogVersion,
    ...(cursor !== undefined ? { cursor } : {}),
    kind,
    serverInstanceId: manifest.serverInstanceId,
    snapshotId: manifest.snapshotId,
  });
  expect(result.kind).toBe('found');
  if (result.kind !== 'found') throw new Error('Expected catalog page');
  return result.value;
}

describe('TaskCatalogState', () => {
  it('omits creation-time branch snapshots for shared roots without changing worktree labels', () => {
    for (const gitIsolation of ['current-branch', 'worktree']) {
      const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });
      state.replace({ sharedState: sharedState({ 'task-1': task('task-1', { gitIsolation }) }) });
      const manifest = foundManifest(state);
      expect(foundPage(state, manifest, 'task').items).toEqual([
        expect.objectContaining({
          branchLabel: gitIsolation === 'current-branch' ? null : 'feature/private-branch',
          branchLabelTruncated: false,
        }),
      ]);
    }
  });
  it('migrates an omitted legacy task mode but rejects explicit invalid values', () => {
    const legacyTask = task();
    delete legacyTask.taskMode;
    const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });

    state.replace({ sharedState: sharedState({ 'task-1': legacyTask }) });
    const manifest = foundManifest(state);
    expect(foundPage(state, manifest, 'task').items).toEqual([
      expect.objectContaining({ taskId: 'task-1', taskMode: 'agent' }),
    ]);

    for (const invalidTaskMode of [null, 'unknown']) {
      expect(() =>
        state.replace({
          sharedState: sharedState({
            'task-1': task('task-1', { taskMode: invalidTaskMode }),
          }),
        }),
      ).toThrow('Canonical task task-1 has an invalid task mode');
    }
  });

  it('projects bounded shell-neutral rows without leaking private task or path data', () => {
    const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });
    const agent = staticAgent({
      displayName: '"'.repeat(300),
      glyph: 'C\n',
      providerLabel: '\ud800Provider',
    });
    state.replace({
      closingTaskIds: ['task-1'],
      sessionRuntime: [{ generation: 7, sessionId: 'shell-1', state: 'running' }],
      sharedState: sharedState(),
      staticAgents: [agent],
    });

    const manifest = foundManifest(state);
    const projects = foundPage(state, manifest, 'project');
    const tasks = foundPage(state, manifest, 'task');
    const sessions = foundPage(state, manifest, 'session');
    const agents = foundPage(state, manifest, 'static-agent');
    const encoded = JSON.stringify({ agents, projects, sessions, tasks });

    expect(encoded).not.toContain('/private/projects');
    expect(encoded).not.toContain('secret-command');
    expect(encoded).not.toContain('private initial prompt');
    expect(encoded).not.toContain('private notes');
    expect(projects.items).toEqual([
      expect.objectContaining({ id: 'project-1', label: 'Project one', projectMode: 'git' }),
    ]);
    expect(tasks.items).toEqual([
      expect.objectContaining({
        lifecycle: 'closing',
        location: 'project-root',
        ownership: 'shared',
        primarySessionId: 'shell-1',
        taskId: 'task-1',
        taskMode: 'terminal',
      }),
    ]);
    expect(sessions.items).toEqual([
      expect.objectContaining({ generation: 7, sessionId: 'shell-1', state: 'running' }),
    ]);
    const projectedAgent = agents.items[0];
    expect(isRemoteAgentChoice(projectedAgent)).toBe(true);
    expect(projectedAgent).toEqual(
      expect.objectContaining({
        displayNameTruncated: true,
        glyph: 'C',
        providerLabel: '�Provider',
      }),
    );
  });

  it('keeps one immutable snapshot lease and returns contiguous deltas for live changes', () => {
    const state = createTaskCatalogState({
      createSnapshotId: () => 'snapshot-1',
      serverInstanceId: SERVER_ID,
    });
    state.replace({ sharedState: sharedState() });
    const firstManifest = foundManifest(state);

    const renamed = sharedState({ 'task-1': task('task-1', { name: 'Renamed task' }) });
    const published = state.replace({ sharedState: renamed });
    expect(published.events).toSatisfy((events: readonly unknown[]) =>
      events.every(isTaskCatalogEvent),
    );
    expect(published.toCatalogVersion).toBe(firstManifest.catalogVersion + 1);

    const joinedManifest = foundManifest(state);
    expect(joinedManifest).toEqual(firstManifest);
    expect(foundPage(state, firstManifest, 'task').items).toEqual([
      expect.objectContaining({ name: 'Task one' }),
    ]);

    const deltas = state.getDeltasSince({
      catalogVersion: firstManifest.catalogVersion,
      serverInstanceId: SERVER_ID,
    });
    expect(deltas).toEqual({
      kind: 'found',
      value: expect.objectContaining({
        events: [expect.objectContaining({ entityKind: 'task', kind: 'replace' })],
        fromCatalogVersion: firstManifest.catalogVersion,
        toCatalogVersion: published.toCatalogVersion,
      }),
    });

    const noChange = state.replace({ sharedState: renamed });
    expect(noChange.events).toEqual([]);
    expect(noChange.toCatalogVersion).toBe(published.toCatalogVersion);
  });

  it('publishes keyed session and closing updates without rebuilding catalog truth', () => {
    const state = createTaskCatalogState({
      createSnapshotId: () => 'snapshot-keyed',
      serverInstanceId: SERVER_ID,
    });
    state.replace({ sharedState: sharedState() });
    const manifest = foundManifest(state);
    const sessionUpdate = state.updateSessionRuntime({
      generation: 8,
      sessionId: 'shell-1',
      state: 'running',
    });
    const closingUpdate = state.setTaskClosing('task-1', true);

    expect(sessionUpdate.events).toEqual([
      expect.objectContaining({ entityKind: 'session', kind: 'replace' }),
    ]);
    expect(closingUpdate.events).toEqual([
      expect.objectContaining({ entityKind: 'task', kind: 'replace' }),
    ]);
    expect(
      state.updateSessionRuntime({
        generation: 8,
        sessionId: 'shell-1',
        state: 'running',
      }).events,
    ).toEqual([]);
    expect(state.setTaskClosing('unknown', true).events).toEqual([]);

    const deltas = state.getDeltasSince({
      catalogVersion: manifest.catalogVersion,
      serverInstanceId: SERVER_ID,
    });
    expect(deltas.kind).toBe('found');
    expect(deltas.kind === 'found' && isTaskCatalogDeltaBatch(deltas.value)).toBe(true);
    expect(deltas.kind === 'found' ? deltas.value.events : []).toHaveLength(2);

    // Structural callers do not own runtime/closing truth; omitted overlays
    // retain the keyed facts instead of silently resetting them.
    const reconciled = state.replace({ sharedState: sharedState() });
    expect(reconciled.events).toEqual([]);
    expect(reconciled.toCatalogVersion).toBe(closingUpdate.toCatalogVersion);
  });

  it('expires snapshot cursors after thirty seconds and binds pages to the server and version', () => {
    let now = 10_000;
    let snapshotNumber = 0;
    const state = createTaskCatalogState({
      createSnapshotId: () => `snapshot-${++snapshotNumber}`,
      now: () => now,
      serverInstanceId: SERVER_ID,
    });
    state.replace({ sharedState: sharedState() });
    const manifest = foundManifest(state);

    expect(
      state.getPage({
        catalogVersion: manifest.catalogVersion + 1,
        kind: 'task',
        serverInstanceId: SERVER_ID,
        snapshotId: manifest.snapshotId,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });
    expect(
      state.getPage({
        catalogVersion: manifest.catalogVersion,
        kind: 'task',
        serverInstanceId: 'server-2',
        snapshotId: manifest.snapshotId,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });

    now += 30_000;
    expect(
      state.getPage({
        catalogVersion: manifest.catalogVersion,
        kind: 'task',
        serverInstanceId: SERVER_ID,
        snapshotId: manifest.snapshotId,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });
    expect(foundManifest(state).snapshotId).toBe('snapshot-2');
  });

  it('paginates at fifty rows and rejects mismatched or malformed cursors', () => {
    const manyTasks = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => {
        const id = `task-${String(index).padStart(2, '0')}`;
        return [id, task(id, { shellAgentIds: [] })];
      }),
    ) as JsonObject;
    const state = createTaskCatalogState({
      createSnapshotId: () => 'snapshot-pages',
      serverInstanceId: SERVER_ID,
    });
    state.replace({ sharedState: sharedState(manyTasks) });
    const manifest = foundManifest(state);
    const first = foundPage(state, manifest, 'task');
    expect(first.items).toHaveLength(TASK_CATALOG_LIMITS.pageItems);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    if (!cursor) throw new Error('Expected a second catalog page');
    const second = foundPage(state, manifest, 'task', cursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      state.getPage({
        catalogVersion: manifest.catalogVersion,
        cursor,
        kind: 'session',
        serverInstanceId: SERVER_ID,
        snapshotId: manifest.snapshotId,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });
  });

  it('distinguishes capacity failures from malformed canonical state', () => {
    const capacityState = createTaskCatalogState({ serverInstanceId: SERVER_ID });
    const tooManyProjects = Array.from(
      { length: TASK_CATALOG_LIMITS.projectCount + 1 },
      (_, index) => project(`project-${index}`),
    );
    expect(() =>
      capacityState.replace({
        sharedState: {
          collapsedTaskOrder: [],
          projects: tooManyProjects,
          taskOrder: [],
          tasks: {},
        },
      }),
    ).toThrow(/capacity/u);
    expect(capacityState.createManifest()).toEqual({ kind: 'catalog-capacity-exceeded' });

    const invalidState = createTaskCatalogState({ serverInstanceId: SERVER_ID });
    expect(() =>
      invalidState.replace({
        sharedState: { collapsedTaskOrder: [], projects: null, taskOrder: [], tasks: {} },
      }),
    ).toThrow(/projects/u);
    expect(invalidState.createManifest()).toEqual({ kind: 'unavailable' });
  });

  it('publishes tombstones and retains a bounded current removal projection', () => {
    const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });
    state.replace({ closingTaskIds: ['task-1'], sharedState: sharedState() });
    expect(state.getCurrentTaskProjection('task-1')).toEqual(
      expect.objectContaining({ taskClosing: true, taskState: 'present' }),
    );

    const listener = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    state.subscribe(listener);
    const result = state.replace({ sharedState: sharedState({}) });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: 'task-1', entityKind: 'task', kind: 'remove' }),
        expect.objectContaining({ entityId: 'shell-1', entityKind: 'session', kind: 'remove' }),
      ]),
    );
    expect(listener).toHaveBeenCalled();
    expect(state.getCurrentTaskProjection('task-1')).toEqual(
      expect.objectContaining({ taskClosing: false, taskState: 'removed' }),
    );
    expect(state.getCurrentTaskProjection('unknown')).toEqual(
      expect.objectContaining({ taskClosing: false, taskState: 'not-visible' }),
    );
  });

  it('invalidates a snapshot rather than rejecting a mutation when its delta log overflows', () => {
    const state = createTaskCatalogState({
      createSnapshotId: () => 'snapshot-overflow',
      serverInstanceId: SERVER_ID,
    });
    state.replace({ sharedState: sharedState({}) });
    const manifest = foundManifest(state);
    const manyTasks = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => {
        const id = `task-${index}`;
        return [id, task(id, { shellAgentIds: [] })];
      }),
    ) as JsonObject;

    expect(() => state.replace({ sharedState: sharedState(manyTasks) })).not.toThrow();
    expect(
      state.getPage({
        catalogVersion: manifest.catalogVersion,
        kind: 'task',
        serverInstanceId: SERVER_ID,
        snapshotId: manifest.snapshotId,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });
    expect(
      state.getDeltasSince({
        catalogVersion: manifest.catalogVersion,
        serverInstanceId: SERVER_ID,
      }),
    ).toEqual({ kind: 'catalog-snapshot-stale' });
  });
});
