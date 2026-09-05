import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_ACTIVE_RECORD_LIMIT,
  AGENT_SESSION_IDENTITY_MAX_BYTES,
  AGENT_SESSION_RESPONSE_LIMIT,
  deriveResumeFallbackOperationId,
  type AgentSessionOperationPhase,
  type AgentSessionOperationRequest,
} from '../../src/domain/agent-session-operation.js';
import type { StorageEnv } from './storage-environment.js';
import {
  AGENT_SESSION_JOURNAL_FILE_NAME,
  createFileAgentSessionOperationJournal,
  createMemoryAgentSessionOperationJournal,
  deriveAgentSessionOperationFingerprint,
  deriveLegacyAgentInitialRestoreIdentity,
  measureAgentSessionIdentityMarkerStorageBytes,
  parseAgentSessionJournalDocument,
  type AgentSessionIdentityMarker,
  type AgentSessionJournalFaultPoint,
  type AgentSessionJournalOperationRecord,
  type AgentSessionOperationJournal,
} from './agent-session-operation-journal.js';
import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

const roots: string[] = [];
const journals: AgentSessionOperationJournal[] = [];

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Expected a non-empty test collection');
  return value;
}

function expectSameIdentityMarkers(
  actual: readonly AgentSessionIdentityMarker[],
  expected: readonly AgentSessionIdentityMarker[],
): void {
  expect(actual).toHaveLength(expected.length);
  const expectedByIdentity = new Map(
    expected.map((marker) => [`${marker.taskId}\u0000${marker.agentId}`, marker]),
  );
  for (const marker of actual) {
    const key = `${marker.taskId}\u0000${marker.agentId}`;
    expect(marker).toEqual(expectedByIdentity.get(key));
    expectedByIdentity.delete(key);
  }
  expect(expectedByIdentity.size).toBe(0);
}

function createEnv(): StorageEnv {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-agent-session-journal-'));
  roots.push(userDataPath);
  return { isPackaged: true, userDataPath };
}

function journalPath(env: StorageEnv): string {
  return path.join(env.userDataPath, AGENT_SESSION_JOURNAL_FILE_NAME);
}

function replacementRequest(
  args: {
    agentId?: string;
    fallback?: boolean;
    operationId?: string;
    sourceGeneration?: number;
    taskId?: string;
  } = {},
): AgentSessionOperationRequest {
  const fallback = args.fallback ?? false;
  return {
    admission: { kind: fallback ? 'resume-fallback-system' : 'task-command' },
    agentId: args.agentId ?? 'agent-1',
    controllerId: fallback ? 'system-recovery' : 'controller-1',
    expectedLeaseGeneration: args.sourceGeneration ?? 1,
    expectedSourceGeneration: args.sourceGeneration ?? 1,
    launchReason: fallback ? 'resume-fallback' : 'manual-restart',
    mode: 'fresh',
    operationId: args.operationId ?? 'operation-1',
    taskId: args.taskId ?? 'task-1',
  };
}

function record(
  args: {
    agentId?: string;
    fallback?: boolean;
    operationId?: string;
    phase?: AgentSessionOperationPhase;
    sourceGeneration?: number;
    taskId?: string;
    version?: number;
  } = {},
): AgentSessionJournalOperationRecord {
  const request = replacementRequest(args);
  const fallbackClassifier = args.fallback ? 'claude-no-conversation-v1' : undefined;
  const fingerprint = deriveAgentSessionOperationFingerprint({
    agentDefId: 'claude-code',
    ...(fallbackClassifier ? { fallbackClassifier } : {}),
    request,
  });
  return {
    agentDefId: 'claude-code',
    createdAtMs: 100,
    fingerprint,
    request,
    snapshot: {
      agentId: request.agentId,
      ...(fallbackClassifier ? { fallbackClassifier } : {}),
      launchReason: request.launchReason,
      operationId: request.operationId,
      phase: args.phase ?? 'admitted',
      resumed: false,
      sourceGeneration: request.expectedSourceGeneration,
      taskId: request.taskId,
      version: args.version ?? 1,
    },
    updatedAtMs: 100 + (args.version ?? 1),
  };
}

function fallbackMarker(current: AgentSessionJournalOperationRecord): AgentSessionIdentityMarker {
  if (
    current.request.expectedSourceGeneration === null ||
    current.snapshot.fallbackClassifier === undefined
  ) {
    throw new Error('Test fallback marker requires a fallback operation');
  }
  return {
    agentId: current.request.agentId,
    fallbackHighWater: {
      classifier: current.snapshot.fallbackClassifier,
      fingerprint: current.fingerprint,
      highestAttemptedSourceGeneration: current.request.expectedSourceGeneration,
      lastKnownPhase: current.snapshot.phase,
      operationId: current.request.operationId,
    },
    taskId: current.request.taskId,
  };
}

function cleanRestartMarker(
  sourceGeneration: number,
  phase: 'available' | 'restored' | 'restoring' = 'available',
): AgentSessionIdentityMarker {
  return {
    agentId: 'agent-1',
    cleanRestart: {
      agentDefId: 'claude-code',
      cols: 120,
      generationHighWater: phase === 'restored' ? sourceGeneration + 1 : sourceGeneration,
      phase,
      rows: 40,
      sourceGeneration,
      targetGeneration: sourceGeneration + 1,
    },
    taskId: 'task-1',
  };
}

function fullReachableMarkerParts(
  index = 1,
  initialIdentity: 'legacy' | 'managed' = 'legacy',
): {
  cleanRestart: AgentSessionIdentityMarker;
  fallback: AgentSessionIdentityMarker;
  initial: AgentSessionIdentityMarker;
  merged: AgentSessionIdentityMarker;
} {
  const taskId = `task-${index}`;
  const agentId = `agent-${index}`;
  const agentDefId = 'claude-code';
  const legacy = deriveLegacyAgentInitialRestoreIdentity(taskId, agentId, agentDefId);
  const creationOperationId =
    initialIdentity === 'legacy'
      ? legacy.creationOperationId
      : Buffer.alloc(16, index % 256).toString('base64url');
  const launchOperationId =
    initialIdentity === 'legacy'
      ? legacy.launchOperationId
      : `launch:${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const initialRequest: AgentSessionOperationRequest = {
    admission: {
      committedWorkspaceRevision: 1,
      creationOperationId,
      kind: 'task-creation',
    },
    agentId,
    expectedLeaseGeneration: null,
    expectedSourceGeneration: null,
    launchReason: 'initial',
    mode: 'initial',
    nextAgentDefId: agentDefId,
    operationId: launchOperationId,
    taskId,
  };
  const initial: AgentSessionIdentityMarker = {
    agentId,
    initialLaunch: {
      agentDefId,
      agentId,
      committedWorkspaceRevision: 1,
      creationOperationId,
      fingerprint: deriveAgentSessionOperationFingerprint({ agentDefId, request: initialRequest }),
      lastKnownPhase: 'running',
      launchOperationId,
      targetGeneration: 0,
      taskId,
      terminalPhase: 'running',
    },
    taskId,
  };
  const fallbackRecord = record({
    fallback: true,
    agentId,
    operationId: deriveResumeFallbackOperationId(taskId, agentId, 0),
    phase: 'running',
    sourceGeneration: 0,
    taskId,
  });
  const fallback = fallbackMarker(fallbackRecord);
  const cleanRestart: AgentSessionIdentityMarker = {
    agentId,
    cleanRestart: {
      agentDefId,
      cols: 120,
      generationHighWater: 1,
      phase: 'available',
      rows: 40,
      sourceGeneration: 1,
      targetGeneration: 2,
    },
    taskId,
  };
  return {
    cleanRestart,
    fallback,
    initial,
    merged: {
      agentId,
      cleanRestart: cleanRestart.cleanRestart,
      fallbackHighWater: fallback.fallbackHighWater,
      initialLaunch: initial.initialLaunch,
      taskId,
    },
  };
}

function trackedMemoryJournal(): AgentSessionOperationJournal {
  const journal = createMemoryAgentSessionOperationJournal();
  journals.push(journal);
  return journal;
}

async function trackedFileJournal(
  env: StorageEnv,
  faultPoint?: AgentSessionJournalFaultPoint,
): Promise<AgentSessionOperationJournal> {
  const journal = createFileAgentSessionOperationJournal(env, {
    ...(faultPoint
      ? {
          faultInjector: (point: AgentSessionJournalFaultPoint) => {
            if (point === faultPoint) throw new Error(`Injected ${point}`);
          },
        }
      : {}),
  });
  journals.push(journal);
  await journal.startup();
  return journal;
}

afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('agent-session operation journal', () => {
  it('stores active and terminal records without reconstructing missing request data', async () => {
    const journal = trackedMemoryJournal();
    const admitted = record();
    await journal.saveOperation(admitted);

    expect(journal.getOperation(admitted.request.operationId)).toEqual({
      kind: 'active',
      record: admitted,
    });

    const running = record({ phase: 'running', version: 2 });
    await journal.saveOperation(running);
    expect(journal.getOperation(running.request.operationId)).toEqual({
      kind: 'terminal-response',
      response: {
        agentDefId: running.agentDefId,
        fingerprint: running.fingerprint,
        request: running.request,
        snapshot: running.snapshot,
        terminalAtMs: running.updatedAtMs,
      },
    });
    expect(journal.getCounts()).toEqual({
      activeOperations: 0,
      identityMarkers: 0,
      terminalResponses: 1,
    });
  });

  it('serializes concurrent mutations so no operation is lost', async () => {
    const journal = trackedMemoryJournal();
    const records = Array.from({ length: 64 }, (_, index) =>
      record({ agentId: `agent-${index}`, operationId: `operation-${index}` }),
    );

    await Promise.all(records.map((current) => journal.saveOperation(current)));

    expect(journal.getCounts().activeOperations).toBe(records.length);
    for (const current of records) {
      expect(journal.getOperation(current.request.operationId)?.kind).toBe('active');
    }
  });

  it('retains compact fallback identity after rich-response eviction', async () => {
    const journal = trackedMemoryJournal();
    const records = Array.from({ length: AGENT_SESSION_RESPONSE_LIMIT + 1 }, (_, index) =>
      record({
        agentId: `a-${index}`,
        fallback: true,
        operationId: `fallback-${index}`,
        phase: 'running',
        sourceGeneration: index,
      }),
    );
    for (const current of records) {
      await journal.saveOperation(current, { identityMarker: fallbackMarker(current) });
    }

    const evicted = first(records);
    expect(journal.getOperation(evicted.request.operationId)).toBeNull();
    expect(journal.getIdentityMarker(evicted.request.taskId, evicted.request.agentId)).toEqual(
      fallbackMarker(evicted),
    );
    expect(journal.getCounts()).toEqual({
      activeOperations: 0,
      identityMarkers: records.length,
      terminalResponses: AGENT_SESSION_RESPONSE_LIMIT,
    });
  });

  it('advances clean-restart permits monotonically and never reuses a prior cycle', async () => {
    const journal = trackedMemoryJournal();

    await journal.saveIdentityMarkers([cleanRestartMarker(3)]);
    await journal.saveIdentityMarkers([cleanRestartMarker(3, 'restoring')]);
    await journal.saveIdentityMarkers([cleanRestartMarker(3, 'restored')]);
    await expect(journal.saveIdentityMarkers([cleanRestartMarker(3)])).rejects.toThrow(
      'cannot regress',
    );

    await journal.saveIdentityMarkers([cleanRestartMarker(4)]);
    expect(journal.getIdentityMarker('task-1', 'agent-1')).toEqual(cleanRestartMarker(4));
  });

  it('keeps the full reachable legacy, fallback, and restart marker inside 512 bytes', async () => {
    const env = createEnv();
    const journal = await trackedFileJournal(env);
    const { cleanRestart, fallback, initial, merged } = fullReachableMarkerParts();

    expect(initial.initialLaunch?.creationOperationId).toMatch(
      /^legacy-agent-task:v1:[a-f0-9]{64}$/u,
    );
    expect(initial.initialLaunch?.launchOperationId).toMatch(
      /^legacy-agent-initial:v1:[a-f0-9]{64}$/u,
    );
    expect(fallback.fallbackHighWater?.operationId).toBe('resume-fallback:v1:task-1:agent-1:0');
    expect(measureAgentSessionIdentityMarkerStorageBytes(merged)).toBeLessThanOrEqual(
      AGENT_SESSION_IDENTITY_MAX_BYTES,
    );
    await journal.saveIdentityMarkers([initial]);
    await journal.saveIdentityMarkers([fallback]);
    await journal.saveIdentityMarkers([cleanRestart]);
    expect(journal.getIdentityMarker('task-1', 'agent-1')).toEqual(merged);

    const compactContents = fs.readFileSync(journalPath(env), 'utf8');
    expect(compactContents).toContain('"i":[');
    expect(compactContents).toContain('"f":[');
    expect(compactContents).toContain('"r":[');
    expect(compactContents).not.toContain('"initialLaunch"');
    expect(compactContents).not.toContain('"fallbackHighWater"');
    expect(compactContents).not.toContain('"cleanRestart"');
    const parsed = parseAgentSessionJournalDocument(compactContents);
    expect(parsed.identityMarkers).toEqual([merged]);

    const legacyContents = canonicalJsonStringify(parsed as unknown as JsonObject);
    expect(parseAgentSessionJournalDocument(legacyContents).identityMarkers).toEqual([merged]);
  });

  it('keeps ordinary task-creation IDs in the full marker under the frozen budget', () => {
    const { initial, merged } = fullReachableMarkerParts(7, 'managed');

    expect(initial.initialLaunch?.creationOperationId).toHaveLength(22);
    expect(initial.initialLaunch?.launchOperationId).toMatch(/^launch:[a-f0-9-]{36}$/u);
    expect(measureAgentSessionIdentityMarkerStorageBytes(merged)).toBeLessThanOrEqual(
      AGENT_SESSION_IDENTITY_MAX_BYTES,
    );
  });

  it('reads and compactly rewrites a maximum-cardinality verbose v1 marker segment', async () => {
    const env = createEnv();
    const journal = await trackedFileJournal(env);
    const markers = Array.from(
      { length: 4_096 },
      (_, index) => fullReachableMarkerParts(index + 1).merged,
    );
    await journal.saveIdentityMarkers(markers);
    const compactDocument = parseAgentSessionJournalDocument(
      fs.readFileSync(journalPath(env), 'utf8'),
    );
    const verboseContents = canonicalJsonStringify(compactDocument as unknown as JsonObject);
    expect(
      Buffer.byteLength(verboseContents, 'utf8') -
        markers.reduce(
          (total, marker) => total + measureAgentSessionIdentityMarkerStorageBytes(marker),
          0,
        ),
    ).toBeGreaterThan(64 * 1_024);
    expectSameIdentityMarkers(
      parseAgentSessionJournalDocument(verboseContents).identityMarkers,
      markers,
    );

    await journal.close();
    fs.writeFileSync(journalPath(env), verboseContents, 'utf8');
    const reopened = await trackedFileJournal(env);
    const markerToAdvance = first(markers);
    const cleanRestart = markerToAdvance.cleanRestart;
    if (!cleanRestart) {
      throw new Error('Expected a complete clean-restart marker');
    }
    const advancedMarker: AgentSessionIdentityMarker = {
      ...markerToAdvance,
      cleanRestart: {
        ...cleanRestart,
        generationHighWater: 2,
        sourceGeneration: 2,
        targetGeneration: 3,
      },
    };
    await reopened.saveIdentityMarkers([advancedMarker]);
    const rewritten = fs.readFileSync(journalPath(env), 'utf8');
    expect(rewritten).toContain('"i":[');
    expect(rewritten).not.toContain('"initialLaunch"');
    expectSameIdentityMarkers(parseAgentSessionJournalDocument(rewritten).identityMarkers, [
      advancedMarker,
      ...markers.slice(1),
    ]);
  });

  it('never evicts active operations to admit a record beyond capacity', async () => {
    const journal = trackedMemoryJournal();
    const records = Array.from({ length: AGENT_SESSION_ACTIVE_RECORD_LIMIT }, (_, index) =>
      record({ agentId: `a-${index}`, operationId: `active-${index}` }),
    );
    for (const current of records) await journal.saveOperation(current);

    await expect(
      journal.saveOperation(record({ agentId: 'overflow', operationId: 'active-overflow' })),
    ).rejects.toThrow('active operation count exceeds limit');
    expect(journal.getCounts().activeOperations).toBe(AGENT_SESSION_ACTIVE_RECORD_LIMIT);
    expect(journal.getOperation(first(records).request.operationId)?.kind).toBe('active');
  });

  it('rejects marker regressions, identity conflicts, and oversized entries', async () => {
    const journal = trackedMemoryJournal();
    const admitted = record({ fallback: true, operationId: 'fallback', sourceGeneration: 4 });
    await journal.saveOperation(admitted, { identityMarker: fallbackMarker(admitted) });

    const running = record({
      fallback: true,
      operationId: 'fallback',
      phase: 'running',
      sourceGeneration: 4,
      version: 2,
    });
    await journal.saveOperation(running, { identityMarker: fallbackMarker(running) });
    await expect(
      journal.saveOperation(admitted, { identityMarker: fallbackMarker(admitted) }),
    ).rejects.toThrow();

    const conflicting = record({
      fallback: true,
      operationId: 'different-operation',
      sourceGeneration: 4,
    });
    await expect(
      journal.saveOperation(conflicting, { identityMarker: fallbackMarker(conflicting) }),
    ).rejects.toThrow('Fallback high-water identity conflicts');

    const oversized = record({
      agentId: 'a'.repeat(200),
      fallback: true,
      operationId: 'oversized-marker',
      taskId: 't'.repeat(500),
    });
    await expect(
      journal.saveOperation(oversized, { identityMarker: fallbackMarker(oversized) }),
    ).rejects.toThrow('identity marker exceeds byte limit');
  });

  it('removes only the exact task and makes finalization idempotent', async () => {
    const journal = trackedMemoryJournal();
    const first = record({ fallback: true, operationId: 'first', taskId: 'task-1' });
    const second = record({ fallback: true, operationId: 'second', taskId: 'task-2' });
    await journal.saveOperation(first, { identityMarker: fallbackMarker(first) });
    await journal.saveOperation(second, { identityMarker: fallbackMarker(second) });

    expect(await journal.deleteTaskRecords('task-1')).toBe('complete');
    expect(await journal.deleteTaskRecords('task-1')).toBe('already-complete');
    expect(journal.getOperation('first')).toBeNull();
    expect(journal.getIdentityMarker('task-1', first.request.agentId)).toBeNull();
    expect(journal.getOperation('second')?.kind).toBe('active');
    expect(journal.getIdentityMarker('task-2', second.request.agentId)).not.toBeNull();
  });

  it('writes a canonical digest-covered file and rejects unknown secret-bearing fields', async () => {
    const env = createEnv();
    const journal = await trackedFileJournal(env);
    const current = record({ fallback: true });
    await journal.saveOperation(current, { identityMarker: fallbackMarker(current) });
    const encoded = fs.readFileSync(journalPath(env), 'utf8');

    expect(parseAgentSessionJournalDocument(encoded).storageGeneration).toBe('1');
    expect(() => parseAgentSessionJournalDocument(`${encoded}\n`)).toThrow(
      'not canonically encoded',
    );
    expect(encoded).not.toContain('No conversation found to continue');
    const secretBearing = {
      ...current,
      request: { ...current.request, terminalOutput: 'secret-output' },
    } as unknown as AgentSessionJournalOperationRecord;
    await expect(journal.saveOperation(secretBearing)).rejects.toThrow(
      'Invalid agent-session operation record',
    );

    const tampered = JSON.parse(encoded) as Record<string, unknown>;
    tampered.storageGeneration = '2';
    expect(() => parseAgentSessionJournalDocument(JSON.stringify(tampered))).toThrow(
      'payload digest mismatch',
    );
  });

  it.each(['after-temporary-write', 'after-temporary-fsync'] as const)(
    'classifies %s as exact prior and remains retryable',
    async (faultPoint) => {
      const journal = await trackedFileJournal(createEnv(), faultPoint);
      await expect(journal.saveOperation(record())).rejects.toThrow(`Injected ${faultPoint}`);
      expect(journal.getHealth()).toBe('healthy');
      expect(journal.getCounts().activeOperations).toBe(0);
    },
  );

  it('holds exact proposed state until directory durability is repaired', async () => {
    const journal = await trackedFileJournal(createEnv(), 'after-rename');
    const current = record();
    await expect(journal.saveOperation(current)).rejects.toThrow('Injected after-rename');

    expect(journal.getHealth()).toBe('durability-repair-required');
    expect(journal.getOperation(current.request.operationId)?.kind).toBe('active');
    await expect(journal.saveOperation(record({ operationId: 'blocked' }))).rejects.toThrow(
      'durability-repair-required',
    );
    expect(await journal.repairDurability()).toBe(true);
    expect(journal.getHealth()).toBe('healthy');
  });

  it('accepts exact proposed state when the directory fsync completed before acknowledgement loss', async () => {
    const journal = await trackedFileJournal(createEnv(), 'after-directory-fsync');
    const current = record();

    await expect(journal.saveOperation(current)).resolves.toBeUndefined();
    expect(journal.getHealth()).toBe('healthy');
    expect(journal.getOperation(current.request.operationId)?.kind).toBe('active');
  });

  it.each(['hard-link', 'copy-fallback'] as const)(
    'preserves exact prior recovery evidence through the %s backup path',
    async (backupKind) => {
      const env = createEnv();
      let failBeforeRename = false;
      let linkAttempts = 0;
      const writer = createFileAgentSessionOperationJournal(env, {
        backupLink: async (existingPath, newPath) => {
          linkAttempts += 1;
          if (backupKind === 'copy-fallback') {
            const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          await fs.promises.link(existingPath, newPath);
        },
        faultInjector: (point) => {
          if (failBeforeRename && point === 'after-temporary-fsync') {
            throw new Error('Injected before replacement rename');
          }
        },
      });
      journals.push(writer);
      expect(await writer.startup()).toBe('healthy');
      const prior = record({ operationId: 'prior' });
      const proposed = record({ agentId: 'agent-2', operationId: 'proposed' });
      await writer.saveOperation(prior);

      failBeforeRename = true;
      await expect(writer.saveOperation(proposed)).rejects.toThrow(
        'Injected before replacement rename',
      );
      expect(writer.getHealth()).toBe('healthy');
      expect(linkAttempts).toBe(1);
      expect(
        parseAgentSessionJournalDocument(fs.readFileSync(`${journalPath(env)}.backup`, 'utf8')),
      ).toMatchObject({
        activeOperations: [
          expect.objectContaining({ request: expect.objectContaining({ operationId: 'prior' }) }),
        ],
      });

      await writer.close();
      const reopened = createFileAgentSessionOperationJournal(env);
      journals.push(reopened);
      expect(await reopened.startup()).toBe('healthy');
      expect(reopened.getOperation('prior')?.kind).toBe('active');
      expect(reopened.getOperation('proposed')).toBeNull();
    },
  );

  it('fails closed when the durable primary changes outside the serialized owner', async () => {
    const env = createEnv();
    const journal = await trackedFileJournal(env);
    await journal.saveOperation(record({ operationId: 'prior' }));
    const externallyChanged = `${fs.readFileSync(journalPath(env), 'utf8')}\n`;
    fs.writeFileSync(journalPath(env), externallyChanged);

    await expect(
      journal.saveOperation(record({ agentId: 'agent-2', operationId: 'proposed' })),
    ).rejects.toThrow('prior state changed unexpectedly');
    expect(journal.getHealth()).toBe('recovery-required');
    expect(fs.readFileSync(journalPath(env), 'utf8')).toBe(externallyChanged);
    expect(journal.getOperation('proposed')).toBeNull();
  });

  it.each(['missing', 'corrupt'] as const)(
    'does not promote an older backup when the primary is %s',
    async (failure) => {
      const env = createEnv();
      const writer = await trackedFileJournal(env);
      await writer.saveOperation(record({ operationId: 'first' }));
      await writer.saveOperation(record({ agentId: 'agent-2', operationId: 'second' }));
      await writer.close();
      if (failure === 'missing') fs.rmSync(journalPath(env));
      else fs.writeFileSync(journalPath(env), '{}');

      const reopened = createFileAgentSessionOperationJournal(env);
      journals.push(reopened);
      expect(await reopened.startup()).toBe('recovery-required');
      expect(reopened.getCounts()).toEqual({
        activeOperations: 0,
        identityMarkers: 0,
        terminalResponses: 0,
      });
    },
  );
});
