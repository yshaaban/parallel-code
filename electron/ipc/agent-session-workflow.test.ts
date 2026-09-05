import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SESSION_ACK_DEADLINE_MS,
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  type AgentSessionInitialOperationRequest,
  type AgentSessionOperationRequest,
} from '../../src/domain/agent-session-operation.js';
import type { TaskRemovalCurrentProjection } from '../../src/domain/task-catalog.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import {
  createMemoryAgentSessionOperationJournal,
  deriveAgentSessionOperationFingerprint,
  type AgentSessionIdentityMarker,
  type AgentSessionJournalOperationRecord,
  type AgentSessionOperationJournal,
} from './agent-session-operation-journal.js';
import {
  createAgentSessionWorkflow,
  type AgentSessionAdmissionInspection,
  type AgentSessionRemovalGateSnapshot,
  type AgentSessionWorkflowAuthority,
  type AgentSessionWorkflowDependencies,
  type AgentSessionWorkflowTimer,
} from './agent-session-workflow.js';

const CREATION_OPERATION_ID = Buffer.alloc(16, 0x11).toString(
  'base64url',
) as TaskCreationOperationId;

function current(
  overrides: Partial<TaskRemovalCurrentProjection> = {},
): TaskRemovalCurrentProjection {
  return {
    catalogVersion: 1,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present',
    ...overrides,
  };
}

function request(
  overrides: Partial<AgentSessionOperationRequest> = {},
): AgentSessionOperationRequest {
  return {
    admission: { kind: 'task-command' },
    agentId: 'agent-1',
    controllerId: 'controller-1',
    expectedLeaseGeneration: 1,
    expectedSourceGeneration: 1,
    launchReason: 'manual-restart',
    mode: 'fresh',
    operationId: 'operation-1',
    taskId: 'task-1',
    ...overrides,
  } as AgentSessionOperationRequest;
}

function initialRequest(): AgentSessionInitialOperationRequest {
  return {
    admission: {
      committedWorkspaceRevision: 8,
      creationOperationId: CREATION_OPERATION_ID,
      kind: 'task-creation',
    },
    agentId: 'agent-1',
    expectedLeaseGeneration: null,
    expectedSourceGeneration: null,
    launchReason: 'initial',
    mode: 'initial',
    nextAgentDefId: 'claude-code',
    operationId: 'launch-1',
    taskId: 'task-1',
  };
}

function fallbackRequest(sourceGeneration = 1): AgentSessionOperationRequest {
  return request({
    admission: { kind: 'resume-fallback-system' },
    controllerId: 'system-recovery',
    expectedLeaseGeneration: sourceGeneration,
    expectedSourceGeneration: sourceGeneration,
    launchReason: 'resume-fallback',
    mode: 'fresh',
    operationId: `fallback-${sourceGeneration}`,
  });
}

function activeOwner() {
  return {
    current: current(),
    cutoverEpoch: 'cutover-1',
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    kind: 'active' as const,
  };
}

function activeGate(overrides: Partial<TaskRemovalCurrentProjection> = {}) {
  return {
    current: current(overrides),
    cutoverEpoch: 'cutover-1',
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    kind: 'active' as const,
  };
}

function createAuthority(
  inspection: AgentSessionAdmissionInspection | null = {
    agentDefId: 'claude-code',
    currentGeneration: 1,
    currentLeaseGeneration: 1,
    kind: 'replacement',
    targetGeneration: 2,
  },
) {
  return {
    admitTransition: vi.fn(async () => true),
    allocateGeneration: vi.fn(async () => 'allocated' as const),
    drainTaskSessionsForRemoval: vi.fn(async () => true),
    inspectAdmission: vi.fn(async () => inspection),
    publishOperation: vi.fn(async () => undefined),
    spawnRunner: vi.fn(
      async (
        _request: Parameters<AgentSessionWorkflowAuthority['spawnRunner']>[0],
        _signal: Parameters<AgentSessionWorkflowAuthority['spawnRunner']>[1],
      ) => 'running' as const,
    ),
    stopPreviousRunner: vi.fn(async () => true),
    verifyCommittedTaskRemoval: vi.fn(async () => true),
  } satisfies AgentSessionWorkflowAuthority;
}

function passiveTimer() {
  return {
    clear: vi.fn(),
    schedule: vi.fn(() => Symbol('timer')),
  } satisfies AgentSessionWorkflowTimer;
}

function dependencies(
  args: {
    authority?: ReturnType<typeof createAuthority>;
    gate?: AgentSessionRemovalGateSnapshot;
    journal?: AgentSessionOperationJournal;
    owner?: ReturnType<typeof activeOwner> | { kind: 'dark'; reason: 'session-owner-dark' };
    timer?: AgentSessionWorkflowTimer;
  } = {},
): AgentSessionWorkflowDependencies {
  return {
    authority: args.authority ?? createAuthority(),
    getOwnerAvailability: vi.fn(async () => args.owner ?? activeOwner()),
    getRemovalGate: vi.fn(async () => args.gate ?? activeGate()),
    journal: args.journal ?? createMemoryAgentSessionOperationJournal(),
    now: () => 100,
    timer: args.timer ?? passiveTimer(),
  };
}

function operationRecord(
  operationRequest: AgentSessionOperationRequest,
  args: { phase?: 'admitted' | 'running'; targetGeneration?: number; version?: number } = {},
): AgentSessionJournalOperationRecord {
  const fallbackClassifier =
    operationRequest.launchReason === 'resume-fallback'
      ? ('claude-no-conversation-v1' as const)
      : undefined;
  const fingerprint = deriveAgentSessionOperationFingerprint({
    agentDefId: 'claude-code',
    ...(fallbackClassifier ? { fallbackClassifier } : {}),
    request: operationRequest,
  });
  return {
    agentDefId: 'claude-code',
    createdAtMs: 100,
    fingerprint,
    request: operationRequest,
    snapshot: {
      agentId: operationRequest.agentId,
      ...(fallbackClassifier ? { fallbackClassifier } : {}),
      launchReason: operationRequest.launchReason,
      operationId: operationRequest.operationId,
      phase: args.phase ?? 'admitted',
      resumed: operationRequest.mode === 'resume',
      sourceGeneration: operationRequest.expectedSourceGeneration,
      targetGeneration: args.targetGeneration ?? 2,
      taskId: operationRequest.taskId,
      version: args.version ?? 1,
    },
    updatedAtMs: 100 + (args.version ?? 1),
  };
}

function markerFor(record: AgentSessionJournalOperationRecord): AgentSessionIdentityMarker {
  if (record.request.mode === 'initial') {
    return {
      agentId: record.request.agentId,
      initialLaunch: {
        agentDefId: record.agentDefId,
        agentId: record.request.agentId,
        committedWorkspaceRevision: record.request.admission.committedWorkspaceRevision,
        creationOperationId: record.request.admission.creationOperationId,
        fingerprint: record.fingerprint,
        lastKnownPhase: record.snapshot.phase,
        launchOperationId: record.request.operationId,
        targetGeneration: record.snapshot.targetGeneration ?? 0,
        taskId: record.request.taskId,
        ...(record.snapshot.phase === 'running' ? { terminalPhase: 'running' as const } : {}),
      },
      taskId: record.request.taskId,
    };
  }
  if (record.snapshot.fallbackClassifier === undefined) {
    throw new Error('Test marker requires an initial or fallback operation');
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

function expectNoSessionEffects(authority: ReturnType<typeof createAuthority>): void {
  expect(authority.admitTransition).not.toHaveBeenCalled();
  expect(authority.allocateGeneration).not.toHaveBeenCalled();
  expect(authority.inspectAdmission).not.toHaveBeenCalled();
  expect(authority.publishOperation).not.toHaveBeenCalled();
  expect(authority.spawnRunner).not.toHaveBeenCalled();
  expect(authority.stopPreviousRunner).not.toHaveBeenCalled();
}

describe('dark agent-session activation boundary', () => {
  it('returns unavailable before gate, journal, timer, or authority access while dark', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const getHealth = vi.spyOn(journal, 'getHealth');
    const getOperation = vi.spyOn(journal, 'getOperation');
    const saveOperation = vi.spyOn(journal, 'saveOperation');
    const timer = passiveTimer();
    const deps = dependencies({
      authority,
      journal,
      owner: { kind: 'dark', reason: 'session-owner-dark' },
      timer,
    });

    await expect(createAgentSessionWorkflow(deps).execute(request())).resolves.toEqual({
      failure: 'session-state-unavailable',
      kind: 'admission-unavailable',
    });
    expect(deps.getRemovalGate).not.toHaveBeenCalled();
    expect(getHealth).not.toHaveBeenCalled();
    expect(getOperation).not.toHaveBeenCalled();
    expect(saveOperation).not.toHaveBeenCalled();
    expect(timer.schedule).not.toHaveBeenCalled();
    expectNoSessionEffects(authority);
  });

  it.each([
    {
      gate: { kind: 'unavailable' } as const,
      label: 'unavailable gate',
    },
    {
      gate: { ...activeGate(), cutoverEpoch: 'different-cutover' },
      label: 'cutover mismatch',
    },
    {
      gate: { ...activeGate(), hookSetVersion: 'different-hooks' },
      label: 'hook mismatch',
    },
  ])('keeps $label fail-closed before journal and effects', async ({ gate }) => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const getHealth = vi.spyOn(journal, 'getHealth');
    const getOperation = vi.spyOn(journal, 'getOperation');
    const saveOperation = vi.spyOn(journal, 'saveOperation');
    const deps = dependencies({
      authority,
      gate: gate as AgentSessionRemovalGateSnapshot,
      journal,
    });

    expect((await createAgentSessionWorkflow(deps).execute(request())).kind).toBe(
      'admission-unavailable',
    );
    expect(getHealth).not.toHaveBeenCalled();
    expect(getOperation).not.toHaveBeenCalled();
    expect(saveOperation).not.toHaveBeenCalled();
    expectNoSessionEffects(authority);
  });

  it('blocks a closing task before operation admission and every effect', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const saveOperation = vi.spyOn(journal, 'saveOperation');
    const deps = dependencies({ authority, gate: activeGate({ taskClosing: true }), journal });

    expect((await createAgentSessionWorkflow(deps).execute(request())).kind).toBe(
      'admission-unavailable',
    );
    expect(saveOperation).not.toHaveBeenCalled();
    expectNoSessionEffects(authority);
  });
});

describe('agent-session operation workflow', () => {
  it('persists every phase before its effect and replays one durable process result', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const phases: string[] = [];
    const save = journal.saveOperation.bind(journal);
    vi.spyOn(journal, 'saveOperation').mockImplementation(async (record, options) => {
      phases.push(record.snapshot.phase);
      await save(record, options);
    });
    const timer = passiveTimer();
    const workflow = createAgentSessionWorkflow(dependencies({ authority, journal, timer }));

    const first = await workflow.execute(request());
    const replay = await workflow.execute(request());

    expect(first).toMatchObject({
      kind: 'operation',
      projection: { operation: { phase: 'running', targetGeneration: 2, version: 4 } },
      replayed: false,
    });
    expect(replay).toMatchObject({
      kind: 'operation',
      projection: { operation: { phase: 'running' } },
      replayed: true,
    });
    expect(phases).toEqual(['admitted', 'stopping-previous', 'spawning', 'running']);
    expect(authority.allocateGeneration).toHaveBeenCalledTimes(1);
    expect(authority.stopPreviousRunner).toHaveBeenCalledTimes(1);
    expect(authority.spawnRunner).toHaveBeenCalledTimes(1);
    expect(authority.publishOperation).toHaveBeenCalledTimes(1);
    expect(timer.schedule).toHaveBeenCalledTimes(1);
    expect(timer.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      AGENT_SESSION_ACK_DEADLINE_MS,
    );
    expect(timer.clear).toHaveBeenCalledTimes(1);
  });

  it('single-flights duplicate requests and rejects conflicting reuse', async () => {
    const authority = createAuthority();
    const workflow = createAgentSessionWorkflow(dependencies({ authority }));

    const [first, second] = await Promise.all([
      workflow.execute(request()),
      workflow.execute(request()),
    ]);
    expect(first).toEqual(second);
    expect(authority.spawnRunner).toHaveBeenCalledTimes(1);
    await expect(workflow.execute(request({ taskId: 'different-task' }))).rejects.toBeInstanceOf(
      Error,
    );
    expect(authority.spawnRunner).toHaveBeenCalledTimes(1);
  });

  it('settles a durable operation when closing wins before generation allocation', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const gates = [activeGate(), activeGate(), activeGate({ taskClosing: true })];
    const deps = dependencies({ authority, journal });
    deps.getRemovalGate = vi.fn(async () => gates.shift() ?? activeGate({ taskClosing: true }));

    const result = await createAgentSessionWorkflow(deps).execute(request());

    expect(result).toMatchObject({
      kind: 'operation',
      projection: { operation: { failure: 'task-closing', phase: 'cancelled' } },
    });
    expect(authority.allocateGeneration).not.toHaveBeenCalled();
    expect(authority.stopPreviousRunner).not.toHaveBeenCalled();
    expect(authority.spawnRunner).not.toHaveBeenCalled();
    expect(journal.getOperation('operation-1')?.kind).toBe('terminal-response');
  });

  it('runs no allocation or process effect when the admitted write is not healthy', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    vi.spyOn(journal, 'saveOperation').mockRejectedValue(new Error('durability hold'));

    expect(
      (await createAgentSessionWorkflow(dependencies({ authority, journal })).execute(request()))
        .kind,
    ).toBe('admission-unavailable');
    expect(authority.allocateGeneration).not.toHaveBeenCalled();
    expect(authority.stopPreviousRunner).not.toHaveBeenCalled();
    expect(authority.spawnRunner).not.toHaveBeenCalled();
    expect(authority.publishOperation).not.toHaveBeenCalled();
  });

  it('aborts a missing spawn acknowledgement and persists an honest failure', async () => {
    const authority = createAuthority();
    let signal: AbortSignal | undefined;
    authority.spawnRunner.mockImplementation(async (_request, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => undefined);
    });
    let timeout: (() => void) | undefined;
    const timer: AgentSessionWorkflowTimer = {
      clear: vi.fn(),
      schedule: vi.fn((callback) => {
        timeout = callback;
        return Symbol('timeout');
      }),
    };
    const execution = createAgentSessionWorkflow(dependencies({ authority, timer })).execute(
      request(),
    );
    await vi.waitFor(() => expect(timeout).toBeTypeOf('function'));
    timeout?.();

    await expect(execution).resolves.toMatchObject({
      kind: 'operation',
      projection: { operation: { failure: 'spawn', phase: 'failed' } },
    });
    expect(signal?.aborted).toBe(true);
    expect(timer.clear).toHaveBeenCalledTimes(1);
    expect(authority.publishOperation).not.toHaveBeenCalled();
  });

  it('replays compact initial and fallback markers without inspection or spawn', async () => {
    const initialJournal = createMemoryAgentSessionOperationJournal();
    const initial = operationRecord(initialRequest(), {
      phase: 'running',
      targetGeneration: 1,
    });
    await initialJournal.saveOperation(initial, { identityMarker: markerFor(initial) });
    const initialAuthority = createAuthority();
    const initialRichReplay = await createAgentSessionWorkflow(
      dependencies({ authority: initialAuthority, journal: initialJournal }),
    ).execute(initialRequest());
    expect(initialRichReplay).toMatchObject({
      kind: 'operation',
      projection: { operation: { phase: 'running' } },
      replayed: true,
    });
    expect(initialRichReplay).not.toMatchObject({
      projection: { operation: { replayKind: 'initial-launch-marker' } },
    });

    vi.spyOn(initialJournal, 'getOperation').mockReturnValue(null);
    const initialReplay = await createAgentSessionWorkflow(
      dependencies({ authority: initialAuthority, journal: initialJournal }),
    ).execute(initialRequest());
    expect(initialReplay).toMatchObject({
      kind: 'operation',
      projection: {
        operation: {
          markerTerminalPhase: 'running',
          phase: 'attempted-no-replay',
          replayKind: 'initial-launch-marker',
          targetGeneration: 1,
        },
      },
      replayed: true,
    });
    expectNoSessionEffects(initialAuthority);

    const fallback = fallbackRequest(3);
    const fallbackJournal = createMemoryAgentSessionOperationJournal();
    const fallbackRecord = operationRecord(fallback, {
      phase: 'running',
      targetGeneration: 4,
    });
    await fallbackJournal.saveOperation(fallbackRecord, {
      identityMarker: markerFor(fallbackRecord),
    });
    vi.spyOn(fallbackJournal, 'getOperation').mockReturnValue(null);
    const fallbackAuthority = createAuthority({
      agentDefId: 'claude-code',
      currentGeneration: 4,
      currentLeaseGeneration: 3,
      fallbackClassifier: 'claude-no-conversation-v1',
      kind: 'replacement',
      targetGeneration: 4,
    });
    const fallbackReplay = await createAgentSessionWorkflow(
      dependencies({ authority: fallbackAuthority, journal: fallbackJournal }),
    ).execute(fallback);
    expect(fallbackReplay).toMatchObject({
      kind: 'operation',
      projection: {
        operation: {
          phase: 'attempted-no-replay',
          replayKind: 'fallback-high-water-marker',
        },
      },
      replayed: true,
    });
    expect(fallbackAuthority.spawnRunner).not.toHaveBeenCalled();
    expect(fallbackAuthority.allocateGeneration).not.toHaveBeenCalled();
  });
});

describe('agent-session removal owner hooks', () => {
  it('probes journal readiness without activating admission', async () => {
    const authority = createAuthority();
    const workflow = createAgentSessionWorkflow(dependencies({ authority }));

    await expect(workflow.removalHooks.probe()).resolves.toEqual({
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      kind: 'ready',
    });
    expectNoSessionEffects(authority);

    const held = createAgentSessionWorkflow(
      dependencies({
        authority,
        journal: createMemoryAgentSessionOperationJournal({ health: 'recovery-required' }),
      }),
    );
    await expect(held.removalHooks.probe()).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('allows a failed readiness probe to be retried after journal repair', async () => {
    const journal = createMemoryAgentSessionOperationJournal();
    const startup = vi
      .spyOn(journal, 'startup')
      .mockResolvedValueOnce('recovery-required')
      .mockResolvedValueOnce('healthy');
    const hooks = createAgentSessionWorkflow(dependencies({ journal })).removalHooks;

    await expect(hooks.probe()).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(hooks.probe()).resolves.toMatchObject({ kind: 'ready' });
    expect(startup).toHaveBeenCalledTimes(2);
  });

  it('drains once, settles active operations, and retains every journal identity', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const fallback = operationRecord(fallbackRequest(2));
    await journal.saveOperation(fallback, { identityMarker: markerFor(fallback) });
    const hooks = createAgentSessionWorkflow(dependencies({ authority, journal })).removalHooks;
    const removal = { deletionOperationId: 'delete-1', taskId: 'task-1' };

    await expect(hooks.drainTaskAgentSessionsForRemoval(removal)).resolves.toMatchObject({
      kind: 'complete',
      retainedIdentityCount: 1,
      retainedOperationCount: 1,
    });
    await expect(hooks.drainTaskAgentSessionsForRemoval(removal)).resolves.toMatchObject({
      kind: 'already-complete',
    });
    expect(authority.drainTaskSessionsForRemoval).toHaveBeenCalledTimes(1);
    expect(journal.getOperation(fallback.request.operationId)).toMatchObject({
      kind: 'terminal-response',
      response: { snapshot: { failure: 'task-closing', phase: 'cancelled' } },
    });
    expect(journal.getIdentityMarker('task-1', 'agent-1')).not.toBeNull();
  });

  it('keeps exact-task records until a matching committed-removal witness finalizes them', async () => {
    const authority = createAuthority();
    const journal = createMemoryAgentSessionOperationJournal();
    const first = operationRecord(fallbackRequest(1));
    const secondRequest = fallbackRequest(2);
    secondRequest.taskId = 'task-2';
    secondRequest.agentId = 'agent-2';
    const second = operationRecord(secondRequest);
    await journal.saveOperation(first, { identityMarker: markerFor(first) });
    await journal.saveOperation(second, { identityMarker: markerFor(second) });
    const hooks = createAgentSessionWorkflow(dependencies({ authority, journal })).removalHooks;
    const removal = { deletionOperationId: 'delete-1', taskId: 'task-1' };

    authority.verifyCommittedTaskRemoval.mockResolvedValueOnce(false);
    await expect(hooks.finalizeRemovedTaskAgentSessionState(removal)).resolves.toEqual({
      kind: 'retry-required',
      reason: 'removal-witness-mismatch',
    });
    expect(journal.getOperation(first.request.operationId)).not.toBeNull();

    await expect(hooks.finalizeRemovedTaskAgentSessionState(removal)).resolves.toEqual({
      kind: 'complete',
    });
    await expect(hooks.finalizeRemovedTaskAgentSessionState(removal)).resolves.toEqual({
      kind: 'already-complete',
    });
    expect(journal.getOperation(first.request.operationId)).toBeNull();
    expect(journal.getIdentityMarker('task-1', 'agent-1')).toBeNull();
    expect(journal.getOperation(second.request.operationId)).not.toBeNull();
  });
});
