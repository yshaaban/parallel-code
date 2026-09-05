import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_ACTIVE_RECORD_LIMIT,
  AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES,
  AGENT_SESSION_IDENTITY_LIMIT,
  AGENT_SESSION_IDENTITY_MAX_BYTES,
  AGENT_SESSION_IDENTITY_TOTAL_MAX_BYTES,
  AGENT_SESSION_JOURNAL_ENVELOPE_MAX_BYTES,
  AGENT_SESSION_JOURNAL_MAX_BYTES,
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  AGENT_SESSION_RESPONSE_LIMIT,
  AGENT_SESSION_RESPONSE_MAX_BYTES,
  AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES,
  type AgentSessionOperationRequest,
} from '../../src/domain/agent-session-operation.js';
import type { TaskRemovalCurrentProjection } from '../../src/domain/task-catalog.js';
import type { StorageEnv } from './storage-environment.js';
import {
  createFileAgentSessionOperationJournal,
  createMemoryAgentSessionOperationJournal,
  deriveAgentSessionOperationFingerprint,
  measureAgentSessionIdentityMarkerStorageBytes,
  type AgentSessionIdentityMarker,
  type AgentSessionJournalFaultPoint,
  type AgentSessionJournalOperationRecord,
  type AgentSessionOperationJournal,
} from './agent-session-operation-journal.js';
import {
  createAgentSessionWorkflow,
  type AgentSessionWorkflowAuthority,
  type AgentSessionWorkflowTimer,
} from './agent-session-workflow.js';

const LOOKUP_SAMPLE_COUNT = 100_000;
const LOOKUP_P99_BUDGET_MS = 0.1;
const ADMISSION_SAMPLE_COUNT = 10_000;
const ADMISSION_P95_BUDGET_MS = 2;
const REFERENCE_AGENT_COUNT = 100;
const ATOMIC_REPLACEMENT_SAMPLE_COUNT = 20;
const ATOMIC_REPLACEMENT_P95_BUDGET_MS = 25;
const STARTUP_SAMPLE_COUNT = 20;
const STARTUP_P95_BUDGET_MS = 100;

const roots: string[] = [];
const journals: AgentSessionOperationJournal[] = [];

function percentile(samples: ArrayLike<number>, percentileValue: number): number {
  const sorted = Array.from(samples).sort((left, right) => left - right);
  return (
    sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? Number.POSITIVE_INFINITY
  );
}

function current(): TaskRemovalCurrentProjection {
  return {
    catalogVersion: 1,
    serverInstanceId: 'benchmark-server',
    taskClosing: false,
    taskState: 'present',
  };
}

function fallbackRequest(index: number): AgentSessionOperationRequest {
  return {
    admission: { kind: 'resume-fallback-system' },
    agentId: `agent-${index}`,
    controllerId: 'system-recovery',
    expectedLeaseGeneration: 1,
    expectedSourceGeneration: 1,
    launchReason: 'resume-fallback',
    mode: 'fresh',
    operationId: `fallback-${index}`,
    taskId: 'task-performance',
  };
}

function runningRecord(index: number): AgentSessionJournalOperationRecord {
  const request = fallbackRequest(index);
  const fingerprint = deriveAgentSessionOperationFingerprint({
    agentDefId: 'claude-code',
    fallbackClassifier: 'claude-no-conversation-v1',
    request,
  });
  return {
    agentDefId: 'claude-code',
    createdAtMs: 100,
    fingerprint,
    request,
    snapshot: {
      agentId: request.agentId,
      fallbackClassifier: 'claude-no-conversation-v1',
      launchReason: request.launchReason,
      operationId: request.operationId,
      phase: 'running',
      resumed: false,
      sourceGeneration: request.expectedSourceGeneration,
      targetGeneration: 2,
      taskId: request.taskId,
      version: 1,
    },
    updatedAtMs: 101,
  };
}

function markerFor(record: AgentSessionJournalOperationRecord): AgentSessionIdentityMarker {
  if (
    record.request.expectedSourceGeneration === null ||
    record.snapshot.fallbackClassifier === undefined
  ) {
    throw new Error('Benchmark marker requires a fallback operation');
  }
  return {
    agentId: record.request.agentId,
    fallbackHighWater: {
      classifier: record.snapshot.fallbackClassifier,
      fingerprint: record.fingerprint,
      highestAttemptedSourceGeneration: record.request.expectedSourceGeneration,
      lastKnownPhase: record.snapshot.phase,
      operationId: record.request.operationId,
    },
    taskId: record.request.taskId,
  };
}

function activeOwner() {
  return {
    current: current(),
    cutoverEpoch: 'benchmark-cutover',
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    kind: 'active' as const,
  };
}

function activeGate() {
  return activeOwner();
}

function createAuthority(counters?: { published: number; spawned: number }) {
  return {
    admitTransition: async () => true,
    allocateGeneration: async () => 'allocated' as const,
    drainTaskSessionsForRemoval: async () => true,
    inspectAdmission: async (request: AgentSessionOperationRequest) => ({
      agentDefId: 'claude-code',
      currentGeneration: request.expectedSourceGeneration ?? 0,
      currentLeaseGeneration: request.expectedLeaseGeneration ?? 0,
      fallbackClassifier:
        request.launchReason === 'resume-fallback'
          ? ('claude-no-conversation-v1' as const)
          : undefined,
      kind: 'replacement' as const,
      targetGeneration: (request.expectedSourceGeneration ?? 0) + 1,
    }),
    publishOperation: async () => {
      if (counters) counters.published += 1;
    },
    spawnRunner: async () => {
      if (counters) counters.spawned += 1;
      return 'running' as const;
    },
    stopPreviousRunner: async () => true,
    verifyCommittedTaskRemoval: async () => true,
  } satisfies AgentSessionWorkflowAuthority;
}

function createTrackingTimer() {
  const live = new Set<number>();
  let nextHandle = 0;
  let scheduled = 0;
  let cleared = 0;
  let peak = 0;
  const timer = {
    clear: (handle) => {
      if (typeof handle === 'number' && live.delete(handle)) cleared += 1;
    },
    schedule: (_callback, _delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled += 1;
      live.add(handle);
      peak = Math.max(peak, live.size);
      return handle;
    },
  } satisfies AgentSessionWorkflowTimer;
  return {
    counts: () => ({ active: live.size, cleared, peak, scheduled }),
    timer,
  };
}

function createEnv(): StorageEnv {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'parallel-agent-session-performance-'),
  );
  roots.push(userDataPath);
  return { isPackaged: true, userDataPath };
}

afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('agent-session workflow performance budgets', () => {
  it('keeps 100,000 warmed operation, marker, and durable replay lookups below 0.1 ms p99', async () => {
    const journal = createMemoryAgentSessionOperationJournal();
    journals.push(journal);
    const records = Array.from({ length: REFERENCE_AGENT_COUNT }, (_, index) =>
      runningRecord(index),
    );
    for (const record of records) {
      await journal.saveOperation(record, { identityMarker: markerFor(record) });
    }
    const replayCounters = { published: 0, spawned: 0 };
    const workflow = createAgentSessionWorkflow({
      authority: createAuthority(replayCounters),
      getOwnerAvailability: async () => activeOwner(),
      getRemovalGate: async () => activeGate(),
      journal,
    });

    for (let index = 0; index < 1_000; index += 1) {
      const record = records[index % records.length];
      if (!record) throw new Error('Missing warmed operation fixture');
      journal.getOperation(record.request.operationId);
      journal.getIdentityMarker(record.request.taskId, record.request.agentId);
      await workflow.execute(record.request);
    }

    const lookupSamples = new Float64Array(LOOKUP_SAMPLE_COUNT);
    for (let index = 0; index < LOOKUP_SAMPLE_COUNT; index += 1) {
      const record = records[index % records.length];
      if (!record) throw new Error('Missing lookup operation fixture');
      const startedAt = performance.now();
      const operation = journal.getOperation(record.request.operationId);
      const marker = journal.getIdentityMarker(record.request.taskId, record.request.agentId);
      lookupSamples[index] = performance.now() - startedAt;
      if (operation?.kind !== 'terminal-response' || marker?.fallbackHighWater === undefined) {
        throw new Error('Indexed lookup left the stable replay path');
      }
    }

    const replaySamples = new Float64Array(LOOKUP_SAMPLE_COUNT);
    for (let index = 0; index < LOOKUP_SAMPLE_COUNT; index += 1) {
      const record = records[index % records.length];
      if (!record) throw new Error('Missing replay operation fixture');
      const startedAt = performance.now();
      const result = await workflow.execute(record.request);
      replaySamples[index] = performance.now() - startedAt;
      if (result.kind !== 'operation' || !result.replayed) {
        throw new Error('Durable operation replay left the stable replay path');
      }
    }

    const lookupP99Ms = percentile(lookupSamples, 0.99);
    const replayP99Ms = percentile(replaySamples, 0.99);
    process.stdout.write(
      `agent-session-indexed-replay agents=${REFERENCE_AGENT_COUNT} samples=${LOOKUP_SAMPLE_COUNT} ` +
        `lookupP99=${lookupP99Ms.toFixed(6)}ms replayP99=${replayP99Ms.toFixed(6)}ms ` +
        `budget=${LOOKUP_P99_BUDGET_MS}ms\n`,
    );

    expect(lookupP99Ms).toBeLessThan(LOOKUP_P99_BUDGET_MS);
    expect(replayP99Ms).toBeLessThan(LOOKUP_P99_BUDGET_MS);
    expect(replayCounters).toEqual({ published: 0, spawned: 0 });
  });

  it('keeps pure admission plus compact-marker serialization below 2 ms p95', async () => {
    const fixtures = Array.from({ length: ADMISSION_SAMPLE_COUNT }, (_, index) => {
      const record = runningRecord(index);
      return { marker: markerFor(record), record };
    });
    const markerBytes = fixtures.map(({ marker }) =>
      measureAgentSessionIdentityMarkerStorageBytes(marker),
    );
    const samples = new Float64Array(ADMISSION_SAMPLE_COUNT);

    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index];
      if (!fixture) throw new Error('Missing admission fixture');
      const journal = createMemoryAgentSessionOperationJournal();
      const startedAt = performance.now();
      await journal.saveOperation(fixture.record, { identityMarker: fixture.marker });
      samples[index] = performance.now() - startedAt;
      await journal.close();
    }

    const p95Ms = percentile(samples, 0.95);
    const maximumMarkerBytes = Math.max(...markerBytes);
    process.stdout.write(
      `agent-session-pure-admission samples=${ADMISSION_SAMPLE_COUNT} p95=${p95Ms.toFixed(6)}ms ` +
        `markerMax=${maximumMarkerBytes}B markerBudget=${AGENT_SESSION_IDENTITY_MAX_BYTES}B ` +
        `latencyBudget=${ADMISSION_P95_BUDGET_MS}ms\n`,
    );

    expect(maximumMarkerBytes).toBeLessThanOrEqual(AGENT_SESSION_IDENTITY_MAX_BYTES);
    expect(p95Ms).toBeLessThan(ADMISSION_P95_BUDGET_MS);
  });

  it('admits 100 agents with exactly one cleared acknowledgement timer per spawn', async () => {
    const journal = createMemoryAgentSessionOperationJournal();
    journals.push(journal);
    const counters = { published: 0, spawned: 0 };
    const trackingTimer = createTrackingTimer();
    const workflow = createAgentSessionWorkflow({
      authority: createAuthority(counters),
      getOwnerAvailability: async () => activeOwner(),
      getRemovalGate: async () => activeGate(),
      journal,
      now: () => 100,
      timer: trackingTimer.timer,
    });
    const requests = Array.from({ length: REFERENCE_AGENT_COUNT }, (_, index) =>
      fallbackRequest(index),
    );

    const startedAt = performance.now();
    const results = await Promise.all(requests.map((request) => workflow.execute(request)));
    const elapsedMs = performance.now() - startedAt;
    const timerCounts = trackingTimer.counts();

    process.stdout.write(
      `agent-session-concurrent-admission agents=${REFERENCE_AGENT_COUNT} ` +
        `elapsed=${elapsedMs.toFixed(3)}ms spawned=${counters.spawned} ` +
        `timersScheduled=${timerCounts.scheduled} timersCleared=${timerCounts.cleared} ` +
        `timersPeak=${timerCounts.peak}\n`,
    );

    expect(results).toHaveLength(REFERENCE_AGENT_COUNT);
    expect(results.every((result) => result.kind === 'operation')).toBe(true);
    expect(counters).toEqual({ published: REFERENCE_AGENT_COUNT, spawned: REFERENCE_AGENT_COUNT });
    expect(timerCounts).toEqual({
      active: 0,
      cleared: REFERENCE_AGENT_COUNT,
      peak: expect.any(Number),
      scheduled: REFERENCE_AGENT_COUNT,
    });
    expect(timerCounts.peak).toBeLessThanOrEqual(REFERENCE_AGENT_COUNT);
    expect(journal.getCounts()).toEqual({
      activeOperations: 0,
      identityMarkers: REFERENCE_AGENT_COUNT,
      terminalResponses: REFERENCE_AGENT_COUNT,
    });
  });

  it('keeps a real 100-agent atomic replacement below 25 ms p95 and startup below 100 ms p95', async () => {
    const env = createEnv();
    const phaseSamples: Partial<Record<AgentSessionJournalFaultPoint, number[]>> = {};
    let measurementStartedAt: number | null = null;
    let lastPhaseAt: number | null = null;
    const writer = createFileAgentSessionOperationJournal(env, {
      faultInjector: (point) => {
        if (measurementStartedAt === null || lastPhaseAt === null) return;
        const observedAt = performance.now();
        (phaseSamples[point] ??= []).push(observedAt - lastPhaseAt);
        lastPhaseAt = observedAt;
      },
    });
    journals.push(writer);
    expect(await writer.startup()).toBe('healthy');

    for (let index = 0; index < REFERENCE_AGENT_COUNT; index += 1) {
      const record = runningRecord(index);
      await writer.saveOperation(record, { identityMarker: markerFor(record) });
    }

    const replacementSamples: number[] = [];
    for (let sample = 0; sample < ATOMIC_REPLACEMENT_SAMPLE_COUNT; sample += 1) {
      const record = runningRecord(REFERENCE_AGENT_COUNT + sample);
      measurementStartedAt = performance.now();
      lastPhaseAt = measurementStartedAt;
      await writer.saveOperation(record, { identityMarker: markerFor(record) });
      replacementSamples.push(performance.now() - measurementStartedAt);
      measurementStartedAt = null;
      lastPhaseAt = null;
    }

    await writer.close();
    journals.splice(journals.indexOf(writer), 1);

    const startupSamples: number[] = [];
    for (let sample = 0; sample < STARTUP_SAMPLE_COUNT; sample += 1) {
      const reader = createFileAgentSessionOperationJournal(env);
      const startedAt = performance.now();
      expect(await reader.startup()).toBe('healthy');
      startupSamples.push(performance.now() - startedAt);
      await reader.close();
    }

    const replacementP95Ms = percentile(replacementSamples, 0.95);
    const startupP95Ms = percentile(startupSamples, 0.95);
    const prewriteAndBackupP95Ms = percentile(phaseSamples['after-backup-fsync'] ?? [], 0.95);
    const temporaryWriteP95Ms = percentile(phaseSamples['after-temporary-write'] ?? [], 0.95);
    const fileFsyncP95Ms = percentile(phaseSamples['after-temporary-fsync'] ?? [], 0.95);
    const renameP95Ms = percentile(phaseSamples['after-rename'] ?? [], 0.95);
    const directoryFsyncP95Ms = percentile(phaseSamples['after-directory-fsync'] ?? [], 0.95);
    process.stdout.write(
      `agent-session-file-journal agents=${REFERENCE_AGENT_COUNT} ` +
        `atomicSamples=${ATOMIC_REPLACEMENT_SAMPLE_COUNT} atomicP95=${replacementP95Ms.toFixed(3)}ms ` +
        `prewriteAndBackupP95=${prewriteAndBackupP95Ms.toFixed(3)}ms ` +
        `temporaryWriteP95=${temporaryWriteP95Ms.toFixed(3)}ms ` +
        `fileFsyncP95=${fileFsyncP95Ms.toFixed(3)}ms ` +
        `renameP95=${renameP95Ms.toFixed(3)}ms ` +
        `directoryFsyncP95=${directoryFsyncP95Ms.toFixed(3)}ms ` +
        `startupSamples=${STARTUP_SAMPLE_COUNT} startupP95=${startupP95Ms.toFixed(3)}ms\n`,
    );

    expect(replacementP95Ms).toBeLessThan(ATOMIC_REPLACEMENT_P95_BUDGET_MS);
    expect(startupP95Ms).toBeLessThan(STARTUP_P95_BUDGET_MS);
  });

  it('freezes every journal component and three-copy peak resource ceiling', () => {
    expect(AGENT_SESSION_ACTIVE_RECORD_LIMIT * AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES).toBe(
      1_048_576,
    );
    expect(AGENT_SESSION_RESPONSE_LIMIT * AGENT_SESSION_RESPONSE_MAX_BYTES).toBe(4_194_304);
    expect(AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES).toBe(4_194_304);
    expect(AGENT_SESSION_IDENTITY_LIMIT * AGENT_SESSION_IDENTITY_MAX_BYTES).toBe(2_097_152);
    expect(AGENT_SESSION_IDENTITY_TOTAL_MAX_BYTES).toBe(2_097_152);
    expect(AGENT_SESSION_JOURNAL_ENVELOPE_MAX_BYTES).toBe(65_536);
    expect(AGENT_SESSION_JOURNAL_MAX_BYTES).toBe(7_405_568);
    expect(AGENT_SESSION_JOURNAL_MAX_BYTES * 2).toBe(14_811_136);
    expect(AGENT_SESSION_JOURNAL_MAX_BYTES * 3).toBe(22_216_704);
  });
});
