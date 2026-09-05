import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { createTaskCatalogState } from '../../electron/ipc/task-catalog-state.js';
import {
  TASK_CATALOG_ENTITY_KINDS,
  TASK_CATALOG_LIMITS,
  type RemoteAgentChoice,
  type TaskCatalogEntityKind,
  type TaskCatalogPage,
  type TaskCatalogReplaceManifest,
} from './task-catalog.js';
import {
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
} from '../../electron/ipc/workspace-state-storage.js';

const SERVER_ID = 'catalog-performance-server';
const REFERENCE_PROJECTS = 10;
const REFERENCE_AGENTS = 16;
const REFERENCE_TASKS = 1_000;
const REFERENCE_SESSIONS_PER_TASK = 2;
const REFERENCE_PAGE_COUNT = 62;
const REFERENCE_ENCODED_BUDGET = 1_486_336;
const MAX_SNAPSHOT_ENCODED_BYTES = 15_607_808;
const MAX_TWO_SNAPSHOTS_ENCODED_BYTES = 31_215_616;
const MAX_CATALOG_OVERHEAD_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_ATTRIBUTABLE_BYTES = 47_992_832;

interface ReferenceFixture {
  sessionRuntime: Array<{
    generation: number;
    sessionId: string;
    state: 'running' | 'stopped';
  }>;
  sharedState: JsonObject;
  staticAgents: RemoteAgentChoice[];
}

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJsonStringify(value as JsonValue), 'utf8');
}

function buildReferenceFixture(taskCount: number): ReferenceFixture {
  const projects = Array.from({ length: REFERENCE_PROJECTS }, (_, index) => ({
    baseBranch: `main-${index}`,
    id: `project-${index}`,
    name: `Project ${index}`,
    path: `/private/project-${index}`,
    projectMode: 'git',
  }));
  const tasks: JsonObject = {};
  const taskOrder: string[] = [];
  const sessionRuntime: ReferenceFixture['sessionRuntime'] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `task-${index}`;
    const firstSessionId = `session-${index}-0`;
    const secondSessionId = `session-${index}-1`;
    taskOrder.push(taskId);
    tasks[taskId] = {
      agentIds: [firstSessionId, secondSessionId],
      branchName: `feature-${index}`,
      gitIsolation: 'worktree',
      id: taskId,
      name: `Task ${index}`,
      notes: `secret note ${index}`,
      projectId: `project-${index % REFERENCE_PROJECTS}`,
      selectedAgentId: firstSessionId,
      shellAgentIds: [],
      taskMode: 'agent',
      worktreePath: `/private/worktree-${index}`,
    };
    sessionRuntime.push(
      { generation: index, sessionId: firstSessionId, state: 'running' },
      { generation: index, sessionId: secondSessionId, state: 'stopped' },
    );
  }

  return {
    sessionRuntime,
    sharedState: {
      collapsedTaskOrder: [],
      projects,
      taskOrder,
      tasks,
    },
    staticAgents: Array.from({ length: REFERENCE_AGENTS }, (_, index) => ({
      agentDefId: `agent-def-${index}`,
      displayName: `Agent ${index}`,
      displayNameTruncated: false,
      glyph: 'A',
      glyphTruncated: false,
      providerLabel: `Provider ${index}`,
      providerLabelTruncated: false,
      supportsInitialPrompt: true,
      supportsPermissionBypass: index % 2 === 0,
    })),
  };
}

function getManifest(state: ReturnType<typeof createTaskCatalogState>): TaskCatalogReplaceManifest {
  const result = state.createManifest();
  if (result.kind !== 'found') throw new Error(`Catalog manifest failed: ${result.kind}`);
  return result.value;
}

function getPage(
  state: ReturnType<typeof createTaskCatalogState>,
  manifest: TaskCatalogReplaceManifest,
  kind: TaskCatalogEntityKind,
  cursor?: string,
): TaskCatalogPage {
  const result = state.getPage({
    catalogVersion: manifest.catalogVersion,
    ...(cursor ? { cursor } : {}),
    kind,
    serverInstanceId: manifest.serverInstanceId,
    snapshotId: manifest.snapshotId,
  });
  if (result.kind !== 'found') throw new Error(`Catalog page failed: ${result.kind}`);
  return result.value;
}

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

describe('task catalog performance budgets', () => {
  it('encodes the 1,000-task reference snapshot within every row/page/manifest bound', () => {
    const fixture = buildReferenceFixture(REFERENCE_TASKS);
    const state = createTaskCatalogState({
      createSnapshotId: () => 'reference-snapshot',
      serverInstanceId: SERVER_ID,
    });
    state.replace(fixture);
    const manifest = getManifest(state);
    let encodedBytes = canonicalBytes(manifest);
    let pageCount = 0;
    const seenCounts: Record<TaskCatalogEntityKind, number> = {
      project: 0,
      'static-agent': 0,
      task: 0,
      session: 0,
    };

    expect(canonicalBytes(manifest)).toBeLessThanOrEqual(TASK_CATALOG_LIMITS.manifestBytes);
    for (const kind of TASK_CATALOG_ENTITY_KINDS) {
      let cursor: string | undefined;
      do {
        const page = getPage(state, manifest, kind, cursor);
        const pageBytes = canonicalBytes(page);
        const envelopeBytes = canonicalBytes({ ...page, items: [] });
        expect(page.items.length).toBeLessThanOrEqual(TASK_CATALOG_LIMITS.pageItems);
        expect(pageBytes).toBeLessThanOrEqual(TASK_CATALOG_LIMITS.pageBytes);
        expect(envelopeBytes).toBeLessThanOrEqual(TASK_CATALOG_LIMITS.pageEnvelopeBytes);
        for (const row of page.items) {
          expect(canonicalBytes(row)).toBeLessThanOrEqual(TASK_CATALOG_LIMITS.rowBytes[kind]);
        }
        expect(JSON.stringify(page)).not.toContain('/private/');
        expect(JSON.stringify(page)).not.toContain('secret note');
        encodedBytes += pageBytes;
        seenCounts[kind] += page.items.length;
        pageCount += 1;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }

    expect(manifest.counts).toEqual({
      project: REFERENCE_PROJECTS,
      'static-agent': REFERENCE_AGENTS,
      task: REFERENCE_TASKS,
      session: REFERENCE_TASKS * REFERENCE_SESSIONS_PER_TASK,
    });
    expect(seenCounts).toEqual(manifest.counts);
    expect(pageCount).toBe(REFERENCE_PAGE_COUNT);
    expect(encodedBytes).toBeLessThanOrEqual(REFERENCE_ENCODED_BUDGET);
  });

  it('keeps the frozen maximum snapshot and two-copy heap equations exact', () => {
    const pageCount =
      Math.ceil(TASK_CATALOG_LIMITS.projectCount / TASK_CATALOG_LIMITS.pageItems) +
      Math.ceil(TASK_CATALOG_LIMITS.agentCount / TASK_CATALOG_LIMITS.pageItems) +
      Math.ceil(TASK_CATALOG_LIMITS.taskCount / TASK_CATALOG_LIMITS.pageItems) +
      Math.ceil(TASK_CATALOG_LIMITS.sessionCount / TASK_CATALOG_LIMITS.pageItems);
    const snapshotBytes =
      TASK_CATALOG_LIMITS.projectCount * TASK_CATALOG_LIMITS.rowBytes.project +
      TASK_CATALOG_LIMITS.agentCount * TASK_CATALOG_LIMITS.rowBytes['static-agent'] +
      TASK_CATALOG_LIMITS.taskCount * TASK_CATALOG_LIMITS.rowBytes.task +
      TASK_CATALOG_LIMITS.sessionCount * TASK_CATALOG_LIMITS.rowBytes.session +
      pageCount * TASK_CATALOG_LIMITS.pageEnvelopeBytes +
      TASK_CATALOG_LIMITS.manifestBytes;

    expect(pageCount).toBe(627);
    expect(snapshotBytes).toBe(MAX_SNAPSHOT_ENCODED_BYTES);
    expect(snapshotBytes * 2).toBe(MAX_TWO_SNAPSHOTS_ENCODED_BYTES);
    expect(snapshotBytes * 2 + MAX_CATALOG_OVERHEAD_BYTES).toBe(MAX_TOTAL_ATTRIBUTABLE_BYTES);
  });

  it('records bounded full-projection timings at 10, 100, and 1,000 tasks', () => {
    const measurements: Record<number, number> = {};
    for (const taskCount of [10, 100, 1_000]) {
      const fixture = buildReferenceFixture(taskCount);
      const samples: number[] = [];
      for (let sample = 0; sample < 12; sample += 1) {
        const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });
        const startedAt = performance.now();
        state.replace(fixture);
        samples.push(performance.now() - startedAt);
      }
      measurements[taskCount] = percentile95(samples);
    }

    process.stdout.write(
      `task-catalog full projection p95: 10=${measurements[10]?.toFixed(3)}ms ` +
        `100=${measurements[100]?.toFixed(3)}ms 1000=${measurements[1_000]?.toFixed(3)}ms\n`,
    );
    expect(measurements[10]).toBeLessThan(50);
    expect(measurements[100]).toBeLessThan(100);
    expect(measurements[1_000]).toBeLessThan(250);
  });

  it('updates one session through the keyed index without catalog-size-dependent scans', () => {
    const fixture = buildReferenceFixture(TASK_CATALOG_LIMITS.taskCount);
    const state = createTaskCatalogState({ serverInstanceId: SERVER_ID });
    state.replace(fixture);
    const samples: number[] = [];
    for (let sample = 0; sample < 1_000; sample += 1) {
      const startedAt = performance.now();
      state.updateSessionRuntime({
        generation: sample + 1,
        sessionId: 'session-9999-1',
        state: sample % 2 === 0 ? 'running' : 'stopped',
      });
      samples.push(performance.now() - startedAt);
    }
    const p95 = percentile95(samples);
    process.stdout.write(`task-catalog keyed session update p95=${p95.toFixed(3)}ms\n`);
    expect(p95).toBeLessThan(2);
  });
});
