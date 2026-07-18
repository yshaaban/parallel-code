import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_LIMITS,
  type CoordinatorSubtaskStartupSnapshot,
} from '../../src/domain/coordinator.js';
import {
  addCoordinatorSubtask,
  appendCoordinatorWorkflowJournal,
  appendCoordinatorWorkflowSteps,
  addCoordinatorWorkflowLane,
  addCoordinatorWorkflowPendingApproval,
  addCoordinatorWorkflowResult,
  cancelCoordinatorWorkflowLanesForTask,
  createCoordinatorWorkflow,
  createCoordinatorRun,
  emitCoordinatorRunRepairEvents,
  enqueueCoordinatorPrompt,
  getCoordinatorBootstrapSnapshot,
  getCoordinatorDiagnostics,
  getCoordinatorOwnedLaneWorkflowCandidates,
  getCoordinatorPrompt,
  getCoordinatorStateVersion,
  getCoordinatorRun,
  getCoordinatorRunIdBySubtaskTaskId,
  getCoordinatorRunMeta,
  getCoordinatorRunMetaByCoordinatorTaskId,
  getCoordinatorRuntimeState,
  getCoordinatorSubtask,
  getCoordinatorSubtaskLaunch,
  getCoordinatorToolResult,
  listCoordinatorPromptQueueProjections,
  listCoordinatorWorkflowSchedulingEntries,
  recordCoordinatorRunResumeOutcome,
  recordCoordinatorSubtaskLaunch,
  rememberCoordinatorToolResult,
  removeCoordinatorRun,
  removeCoordinatorSubtaskLaunch,
  resetCoordinatorRuntimeForTests,
  resolveCoordinatorWorkflowPendingApproval,
  restoreCoordinatorRuntimeState,
  resumeCoordinatorRunFromStale,
  setCoordinatorRunPaused,
  subscribeCoordinatorEvents,
  updateCoordinatorPrompt,
  updateCoordinatorRunStatus,
  updateCoordinatorSubtaskStatus,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  upsertCoordinatorLanding,
} from './runtime.js';

describe('coordinator runtime', () => {
  afterEach(() => {
    resetCoordinatorRuntimeForTests();
    vi.useRealTimers();
  });

  it('emits replayable state events and materializes run-owned entities', () => {
    const events: unknown[] = [];
    const cleanup = subscribeCoordinatorEvents((event) => events.push(event));
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });

    const updatedPrompt = updateCoordinatorPrompt(run.id, prompt.requestId, {
      status: 'delivering',
      waitingReason: undefined,
    });
    const materialized = getCoordinatorRun(run.id);

    expect(updatedPrompt.waitingReason).toBeUndefined();
    expect(materialized?.subtasks).toHaveLength(1);
    expect(materialized?.promptQueue).toHaveLength(1);
    expect(events.map((event) => (event as { eventType: string }).eventType)).toContain(
      'prompt-upserted',
    );

    cleanup();
  });

  it('returns detached narrow run, prompt, and subtask snapshots', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Original assignment',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      startup: {
        followupPromptMode: 'post-ready-prompt',
        initialAssignmentMode: 'post-ready-prompt',
        initialAssignmentStatus: 'pending-prompt',
        readinessPolicy: 'terminal-generic',
      },
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Original prompt',
      now: 1_200,
    });

    const metaSnapshot = getCoordinatorRunMeta(run.id);
    const promptSnapshot = getCoordinatorPrompt(run.id, prompt.requestId);
    const subtaskSnapshot = getCoordinatorSubtask(run.id, 'task-child');
    if (!metaSnapshot || !promptSnapshot || !subtaskSnapshot || !subtaskSnapshot.startup) {
      throw new Error('Expected narrow coordinator snapshots.');
    }

    metaSnapshot.limits.maxActiveSubtasks = 999;
    metaSnapshot.status = 'failed';
    promptSnapshot.text = 'Mutated prompt';
    promptSnapshot.deliveryJournal.push({
      agentGeneration: 1,
      deliveryAttemptId: 'caller-attempt',
      ptySessionId: 'caller-pty',
      requestId: prompt.requestId,
      writePreparedAt: 1_300,
    });
    subtaskSnapshot.assignment = 'Mutated assignment';
    subtaskSnapshot.startup.initialAssignmentStatus = 'failed';

    expect(getCoordinatorRunMeta(run.id)).toMatchObject({
      limits: { maxActiveSubtasks: COORDINATOR_LIMITS.maxActiveSubtasksPerRun },
      status: 'running',
    });
    expect(getCoordinatorPrompt(run.id, prompt.requestId)).toMatchObject({
      deliveryJournal: [],
      text: 'Original prompt',
    });
    expect(getCoordinatorSubtask(run.id, 'task-child')).toMatchObject({
      assignment: 'Original assignment',
      startup: { initialAssignmentStatus: 'pending-prompt' },
    });
    expect(getCoordinatorRunMeta('missing-run')).toBeNull();
    expect(getCoordinatorPrompt(run.id, 'missing-prompt')).toBeNull();
    expect(getCoordinatorSubtask(run.id, 'missing-task')).toBeNull();
  });

  it('lists detached prompt queue projections in run and insertion order', () => {
    const firstRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-a',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const secondRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-b',
      now: 1_010,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const firstPrompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_100,
      runId: firstRun.id,
      sourceTaskId: 'task-coordinator-a',
      targetAgentId: 'agent-a',
      targetTaskId: 'task-a',
      text: 'First prompt',
    });
    const secondPrompt = enqueueCoordinatorPrompt({
      kind: 'system',
      now: 1_200,
      runId: firstRun.id,
      sourceTaskId: 'task-coordinator-a',
      targetAgentId: 'agent-a',
      targetTaskId: 'task-a',
      text: 'Second prompt',
    });
    const thirdPrompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_300,
      runId: secondRun.id,
      sourceTaskId: 'task-coordinator-b',
      targetAgentId: 'agent-b',
      targetTaskId: 'task-b',
      text: 'Third prompt',
    });
    setCoordinatorRunPaused(secondRun.id, true, 1_400);

    const projections = listCoordinatorPromptQueueProjections();
    expect(
      projections.map((projection) => ({
        promptIds: projection.promptQueue.map((entry) => entry.requestId),
        runId: projection.runId,
        status: projection.status,
      })),
    ).toEqual([
      {
        promptIds: [firstPrompt.requestId, secondPrompt.requestId],
        runId: firstRun.id,
        status: 'running',
      },
      {
        promptIds: [thirdPrompt.requestId],
        runId: secondRun.id,
        status: 'paused-by-user',
      },
    ]);

    const projectedPrompt = projections[0]?.promptQueue[0];
    if (!projectedPrompt) {
      throw new Error('Expected projected prompt.');
    }
    projectedPrompt.text = 'Mutated projection';
    expect(getCoordinatorPrompt(firstRun.id, firstPrompt.requestId)?.text).toBe('First prompt');
  });

  it('lists detached workflow scheduling entries globally and for one run', () => {
    const firstRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-a',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const secondRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-b',
      now: 1_010,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const firstWorkflow = createCoordinatorWorkflow({
      now: 1_100,
      runId: firstRun.id,
      stages: [{ id: 'first', kind: 'map', name: 'First' }],
      template: 'map_reduce',
      title: 'First workflow',
    });
    const secondWorkflow = createCoordinatorWorkflow({
      now: 1_200,
      runId: firstRun.id,
      stages: [{ id: 'second', kind: 'reduce', name: 'Second' }],
      template: 'map_reduce',
      title: 'Second workflow',
    });
    const thirdWorkflow = createCoordinatorWorkflow({
      now: 1_300,
      runId: secondRun.id,
      stages: [{ id: 'third', kind: 'verify', name: 'Third' }],
      template: 'adversarial_review',
      title: 'Third workflow',
    });
    addCoordinatorWorkflowResult({
      now: 1_310,
      result: {
        agentId: 'agent-first',
        commandsRun: [],
        evidence: [],
        findings: [],
        laneId: 'lane-first',
        risks: [],
        stageId: 'first',
        status: 'completed',
        summary: 'Heavy result history stays out of owned-lane projections.',
        taskId: 'task-first',
        workflowId: firstWorkflow.id,
      },
      runId: firstRun.id,
      workflowId: firstWorkflow.id,
    });
    appendCoordinatorWorkflowJournal(firstRun.id, firstWorkflow.id, {
      at: 1_320,
      kind: 'lane-result',
      message: 'Heavy journal history stays out of owned-lane projections.',
      stageId: 'first',
    });

    const globalEntries = listCoordinatorWorkflowSchedulingEntries();
    expect(
      globalEntries.map((entry) => ({
        coordinatorTaskId: entry.coordinatorTaskId,
        workflowId: entry.workflow.id,
      })),
    ).toEqual([
      { coordinatorTaskId: 'task-coordinator-a', workflowId: firstWorkflow.id },
      { coordinatorTaskId: 'task-coordinator-a', workflowId: secondWorkflow.id },
      { coordinatorTaskId: 'task-coordinator-b', workflowId: thirdWorkflow.id },
    ]);
    expect(
      listCoordinatorWorkflowSchedulingEntries(secondRun.id).map((entry) => entry.workflow.id),
    ).toEqual([thirdWorkflow.id]);
    expect(listCoordinatorWorkflowSchedulingEntries('missing-run')).toEqual([]);
    expect(
      getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id)?.map((workflow) => ({
        id: workflow.id,
        resultCount: workflow.resultCount,
      })),
    ).toEqual([
      { id: firstWorkflow.id, resultCount: 1 },
      { id: secondWorkflow.id, resultCount: 0 },
    ]);
    expect(getCoordinatorOwnedLaneWorkflowCandidates('missing-run')).toBeNull();
    expect(getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id)?.[0]).not.toHaveProperty(
      'journal',
    );
    expect(getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id)?.[0]).not.toHaveProperty(
      'results',
    );
    expect(getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id)?.[0]).not.toHaveProperty('title');
    expect(getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id)?.[0]).not.toHaveProperty(
      'eventVersion',
    );

    const firstEntry = globalEntries[0];
    if (!firstEntry) {
      throw new Error('Expected a workflow scheduling entry.');
    }
    firstEntry.workflow.policy.timeoutMs = 1;
    const workflowSnapshots = getCoordinatorOwnedLaneWorkflowCandidates(firstRun.id);
    if (!workflowSnapshots?.[0]) {
      throw new Error('Expected detached workflow snapshots.');
    }
    workflowSnapshots[0].status = 'cancelled';
    expect(getCoordinatorRun(firstRun.id)?.workflows[0]?.policy.timeoutMs).not.toBe(1);
    expect(getCoordinatorRun(firstRun.id)?.workflows[0]?.status).not.toBe('cancelled');
    expect(getCoordinatorRun(firstRun.id)?.workflows[0]?.title).toBe('First workflow');
  });

  it('looks up task owners through detached run metadata and scalar ids', () => {
    const firstRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-a',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const secondRun = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-b',
      now: 1_010,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator-b',
      runId: secondRun.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });

    expect(getCoordinatorRunIdBySubtaskTaskId('task-child')).toBe(secondRun.id);
    expect(getCoordinatorRunIdBySubtaskTaskId(firstRun.coordinatorTaskId)).toBeNull();
    expect(getCoordinatorRunIdBySubtaskTaskId('missing-task')).toBeNull();

    const owner = getCoordinatorRunMetaByCoordinatorTaskId('task-coordinator-b');
    expect(owner).toMatchObject({
      coordinatorTaskId: 'task-coordinator-b',
      id: secondRun.id,
    });
    expect(owner).not.toHaveProperty('subtasks');
    expect(owner).not.toHaveProperty('promptQueue');
    expect(getCoordinatorRunMetaByCoordinatorTaskId('task-child')).toBeNull();
    expect(getCoordinatorRunMetaByCoordinatorTaskId('missing-task')).toBeNull();

    if (!owner) {
      throw new Error('Expected coordinator run metadata.');
    }
    owner.limits.maxActiveSubtasks = 0;
    expect(
      getCoordinatorRunMetaByCoordinatorTaskId('task-coordinator-b')?.limits.maxActiveSubtasks,
    ).toBe(COORDINATOR_LIMITS.maxActiveSubtasksPerRun);
  });

  it('restores persisted runtime state and tombstones removed runs', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/repo',
    });
    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorBootstrapSnapshot().runs.map((entry) => entry.id)).toEqual([run.id]);

    removeCoordinatorRun(run.id);

    expect(getCoordinatorRun(run.id)).toBeNull();
  });

  it('re-emits restored runs as run-upserted repair events without bumping state version', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);
    const restoredStateVersion = getCoordinatorStateVersion();

    const events: Array<{ eventType: string; runId: string; categorySeq: number }> = [];
    const cleanup = subscribeCoordinatorEvents((event) =>
      events.push({
        categorySeq: event.categorySeq,
        eventType: event.eventType,
        runId: event.runId,
      }),
    );
    emitCoordinatorRunRepairEvents();
    cleanup();

    expect(events).toEqual([
      { categorySeq: restoredStateVersion, eventType: 'run-upserted', runId: run.id },
    ]);
    expect(getCoordinatorStateVersion()).toBe(restoredStateVersion);
  });

  it('normalizes restored active runs and in-flight prompts to stale recovery states', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });
    updateCoordinatorPrompt(run.id, prompt.requestId, {
      status: 'delivering',
    });
    updateCoordinatorRunStatus(run.id, 'draining', 1_300);
    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id);
    expect(restored).toMatchObject({
      status: 'stale-after-restore',
    });
    expect(restored?.subtasks[0]).toMatchObject({
      result: 'Server restored coordinator state without the live PTY session.',
      status: 'exited',
    });
    expect(restored?.promptQueue[0]).toMatchObject({
      status: 'write-unknown-after-restore',
      waitingReason: 'server-restored-without-live-pty-session',
    });
  });

  it('persists workflow state and marks active restored workflow lanes stale', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [
        { id: 'map', kind: 'map', name: 'Map' },
        { dependsOn: ['map'], id: 'reduce', kind: 'reduce', name: 'Reduce' },
      ],
      template: 'map_reduce',
      title: 'Review startup',
    });
    const completedLane = addCoordinatorWorkflowLane({
      agentId: 'agent-complete',
      assignment: 'Map completed lane.',
      name: 'Completed',
      now: 1_020,
      runId: run.id,
      stageId: 'map',
      status: 'waiting-for-result',
      taskId: 'task-complete',
      workflowId: workflow.id,
    });
    const activeLane = addCoordinatorWorkflowLane({
      agentId: 'agent-active',
      assignment: 'Map active lane.',
      name: 'Active',
      now: 1_030,
      runId: run.id,
      stageId: 'map',
      status: 'waiting-for-result',
      taskId: 'task-active',
      workflowId: workflow.id,
    });
    const result = addCoordinatorWorkflowResult({
      now: 1_040,
      result: {
        agentId: 'agent-complete',
        commandsRun: ['npm test'],
        evidence: [{ label: 'runtime' }],
        findings: [],
        laneId: completedLane.id,
        risks: [],
        stageId: 'map',
        status: 'completed',
        summary: 'Completed lane result.',
        taskId: 'task-complete',
        workflowId: workflow.id,
      },
      runId: run.id,
      workflowId: workflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, workflow.id, completedLane.id, {
      completedAt: 1_050,
      resultId: result.id,
      status: 'completed',
    });

    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow).toMatchObject({
      status: 'stale-after-restore',
      results: [expect.objectContaining({ summary: 'Completed lane result.' })],
    });
    expect(restoredWorkflow?.lanes.find((lane) => lane.id === completedLane.id)).toMatchObject({
      status: 'completed',
    });
    expect(restoredWorkflow?.lanes.find((lane) => lane.id === activeLane.id)).toMatchObject({
      failure: 'Server restored coordinator workflow state without the live PTY session.',
      status: 'stale-after-restore',
    });
    expect(restoredWorkflow?.stages.find((stage) => stage.id === 'map')).toMatchObject({
      failure: 'Server restored coordinator workflow state without the live PTY session.',
      status: 'stale-after-restore',
    });
  });

  it('owns committed workflow state and returns detached workflow snapshots', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const reduceDependencies = ['map'];
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [
        { id: 'map', kind: 'map', name: 'Map' },
        { dependsOn: reduceDependencies, id: 'reduce', kind: 'reduce', name: 'Reduce' },
      ],
      template: 'map_reduce',
      title: 'Original workflow',
    });
    const lane = addCoordinatorWorkflowLane({
      assignment: 'Map the repository.',
      name: 'Original lane',
      now: 1_020,
      runId: run.id,
      stageId: 'map',
      workflowId: workflow.id,
    });
    const appendPolicy = {
      maxActionsPerDecision: 2,
      maxStepAppends: 3,
    };
    const updatedWorkflow = updateCoordinatorWorkflow(run.id, workflow.id, {
      appendPolicy,
      now: 1_030,
      status: 'waiting-for-results',
    });
    const journalledWorkflow = appendCoordinatorWorkflowJournal(run.id, workflow.id, {
      at: 1_040,
      kind: 'stage-started',
      message: 'Started map stage.',
      stageId: 'map',
    });
    const commandsRun = ['npm test'];
    const result = addCoordinatorWorkflowResult({
      now: 1_050,
      result: {
        agentId: 'agent-child',
        commandsRun,
        evidence: [],
        findings: [],
        laneId: lane.id,
        risks: [],
        stageId: 'map',
        status: 'completed',
        summary: 'Mapped the repository.',
        taskId: 'task-child',
        workflowId: workflow.id,
      },
      runId: run.id,
      workflowId: workflow.id,
    });

    reduceDependencies.push('caller-mutated-dependency');
    appendPolicy.maxStepAppends = 99;
    commandsRun.push('caller-mutated-command');
    workflow.title = 'Mutated caller workflow';
    lane.name = 'Mutated caller lane';
    updatedWorkflow.appendPolicy.maxActionsPerDecision = 99;
    const journalEntry = journalledWorkflow.journal[1];
    if (journalEntry === undefined) {
      throw new Error('Expected the appended journal entry.');
    }
    journalEntry.message = 'Mutated caller journal';
    result.commandsRun.push('mutated returned result');

    const canonicalWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(canonicalWorkflow?.title).toBe('Original workflow');
    expect(canonicalWorkflow?.lanes[0]?.name).toBe('Original lane');
    expect(canonicalWorkflow?.status).toBe('waiting-for-results');
    expect(canonicalWorkflow?.appendPolicy).toEqual({
      maxActionsPerDecision: 2,
      maxStepAppends: 3,
    });
    expect(canonicalWorkflow?.stages.find((stage) => stage.id === 'reduce')?.dependsOn).toEqual([
      'map',
    ]);
    expect(canonicalWorkflow?.journal[1]?.message).toBe('Started map stage.');
    expect(canonicalWorkflow?.results[0]?.commandsRun).toEqual(['npm test']);
  });

  it('owns mutable subtask, prompt, and landing inputs after committing them', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const startup: CoordinatorSubtaskStartupSnapshot = {
      followupPromptMode: 'post-ready-prompt',
      initialAssignmentMode: 'post-ready-prompt',
      initialAssignmentStatus: 'pending-prompt',
      readinessPolicy: 'terminal-generic',
    };
    const subtask = addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      now: 1_010,
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      startup,
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_020,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
    });
    const deliveryJournal = [
      {
        agentGeneration: 1,
        deliveryAttemptId: 'attempt-1',
        ptySessionId: 'pty-1',
        requestId: prompt.requestId,
        writePreparedAt: 1_030,
      },
    ];
    const updatedPrompt = updateCoordinatorPrompt(run.id, prompt.requestId, {
      deliveryJournal,
      status: 'delivering',
    });
    const verification = ['npm test'];
    const landing = upsertCoordinatorLanding({
      landing: {
        requestedAt: 1_040,
        requestedByAgentId: 'agent-child',
        runId: run.id,
        status: 'requested',
        summary: 'Ready to land.',
        taskId: 'task-child',
        verification,
      },
      runId: run.id,
    });

    startup.initialAssignmentStatus = 'failed';
    if (subtask.startup === undefined || deliveryJournal[0] === undefined) {
      throw new Error('Expected committed subtask startup and prompt delivery state.');
    }
    subtask.startup.initialAssignmentStatus = 'blocked-by-question';
    deliveryJournal[0].ptySessionId = 'caller-mutated-pty';
    updatedPrompt.deliveryJournal.push({
      agentGeneration: 2,
      deliveryAttemptId: 'attempt-2',
      ptySessionId: 'pty-2',
      requestId: prompt.requestId,
      writePreparedAt: 1_050,
    });
    verification.push('caller-mutated-command');
    landing.verification.push('mutated returned landing');

    const canonicalAfterCreate = getCoordinatorRun(run.id);
    expect(canonicalAfterCreate?.subtasks[0]?.startup?.initialAssignmentStatus).toBe(
      'pending-prompt',
    );
    expect(canonicalAfterCreate?.promptQueue[0]?.deliveryJournal).toEqual([
      expect.objectContaining({ ptySessionId: 'pty-1' }),
    ]);
    expect(canonicalAfterCreate?.landing[0]?.verification).toEqual(['npm test']);

    const resumedStartup: CoordinatorSubtaskStartupSnapshot = {
      followupPromptMode: 'post-ready-prompt',
      initialAssignmentMode: 'post-ready-prompt',
      initialAssignmentStatus: 'delivered',
      readinessPolicy: 'terminal-generic',
    };
    const updatedSubtask = updateCoordinatorSubtaskStatus(run.id, 'task-child', 'running', {
      now: 1_060,
      startup: resumedStartup,
    });
    resumedStartup.initialAssignmentStatus = 'failed';
    if (updatedSubtask.startup === undefined) {
      throw new Error('Expected updated subtask startup state.');
    }
    updatedSubtask.startup.initialAssignmentStatus = 'blocked-by-question';

    expect(getCoordinatorRun(run.id)?.subtasks[0]?.startup?.initialAssignmentStatus).toBe(
      'delivered',
    );
  });

  it('backfills legacy workflow append policy, program version, and journal sequence on restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Legacy restore',
    });
    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        workflows: entry.workflows.map((workflow) => ({
          ...workflow,
          journal: workflow.journal.map(({ seq: _seq, ...journalEntry }) => journalEntry),
          programVersion: undefined,
          appendPolicy: undefined,
        })),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow).toMatchObject({
      appendPolicy: {
        maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
        maxStepAppends: COORDINATOR_LIMITS.maxWorkflowStepAppends,
      },
      programVersion: 2,
    });
    expect(restoredWorkflow?.journal[0]).toMatchObject({
      kind: 'workflow-created',
      seq: 1,
    });
  });

  it('defaults workflow budget policy fields and computes an execution budget on restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Budget defaults',
    });
    expect(workflow.policy).toMatchObject({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
    });

    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        workflows: entry.workflows.map((legacyWorkflow) => ({
          ...legacyWorkflow,
          execution: undefined,
          policy: {
            continueOnFailure: legacyWorkflow.policy.continueOnFailure,
            maxConcurrentLanes: legacyWorkflow.policy.maxConcurrentLanes,
            maxIterationsPerBranch: legacyWorkflow.policy.maxIterationsPerBranch,
            maxOutputBytesPerLane: legacyWorkflow.policy.maxOutputBytesPerLane,
            resultRequired: legacyWorkflow.policy.resultRequired,
            retryBackoffMs: legacyWorkflow.policy.retryBackoffMs,
            retryCount: legacyWorkflow.policy.retryCount,
            timeoutMs: legacyWorkflow.policy.timeoutMs,
          },
        })),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.policy).toMatchObject({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
    });
    expect(restoredWorkflow?.execution?.budget).toMatchObject({
      deadlineAt: expect.any(Number),
      lanes: { limit: COORDINATOR_LIMITS.maxWorkflowLanes, used: 0 },
      retries: { limit: COORDINATOR_LIMITS.maxWorkflowTotalRetries, used: 0 },
      steps: { limit: COORDINATOR_LIMITS.maxWorkflowTotalSteps, used: 1 },
    });
  });

  it('drops unknown workflow policy fields while restoring canonical state', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Canonical policy restore',
    });
    const persisted = getCoordinatorRuntimeState();
    const stateWithUnknownPolicy = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        workflows: entry.workflows.map((workflow) => ({
          ...workflow,
          appendPolicy: {
            ...workflow.appendPolicy,
            unknownAppendPolicy: 'drop-me',
          },
          policy: {
            ...workflow.policy,
            unknownPolicy: 'drop-me',
          },
        })),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(stateWithUnknownPolicy);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.policy).not.toHaveProperty('unknownPolicy');
    expect(restoredWorkflow?.appendPolicy).not.toHaveProperty('unknownAppendPolicy');
  });

  it('preserves a non-default maxIterationsPerBranch across create and restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      policy: { maxIterationsPerBranch: 5 },
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Branch iteration policy',
    });
    expect(workflow.policy.maxIterationsPerBranch).toBe(5);

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.policy.maxIterationsPerBranch).toBe(5);
  });

  it('preserves the execution deadline and exhausted budget dimension across restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Budget restore',
    });
    updateCoordinatorWorkflow(run.id, workflow.id, {
      execution: {
        activeLaneCount: 0,
        budget: {
          deadlineAt: 4_600_000,
          exhausted: 'wall-clock',
          lanes: { limit: 12, used: 0 },
          retries: { limit: 8, used: 0 },
          steps: { limit: 24, used: 1 },
        },
        deadlineAt: 4_600_000,
        lastTickAt: 1_020,
        pendingRetryLaneIds: [],
        readyStageIds: [],
      },
      now: 1_020,
    });

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.execution).toMatchObject({
      budget: expect.objectContaining({
        deadlineAt: 4_600_000,
        exhausted: 'wall-clock',
      }),
      deadlineAt: 4_600_000,
    });
  });

  it('backfills legacy subtask startup state on restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'initial-assignment',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });
    updateCoordinatorPrompt(run.id, prompt.requestId, {
      deliveredAt: 1_230,
      status: 'delivered',
    });
    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        subtasks: entry.subtasks.map(({ startup: _startup, ...subtask }) => subtask),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    expect(getCoordinatorRun(run.id)?.subtasks[0]).toMatchObject({
      startup: {
        deliveredAt: 1_230,
        followupPromptMode: 'post-ready-prompt',
        initialAssignmentMode: 'post-ready-prompt',
        initialAssignmentStatus: 'delivered',
        readinessPolicy: 'terminal-generic',
      },
      status: 'exited',
    });
  });

  it('clears stale completion reason when appending to a completed workflow', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      execution: {
        activeLaneCount: 0,
        completionReason: 'Workflow already finished.',
        lastTickAt: 1_010,
        pendingRetryLaneIds: [],
        readyStageIds: [],
      },
      now: 1_010,
      runId: run.id,
      sourceSpec: {
        steps: [
          {
            dependsOn: [],
            id: 'initial',
            kind: 'worker',
            lanes: [],
            name: 'Initial',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
        ],
        version: 1,
      },
      stages: [{ id: 'initial', kind: 'custom', name: 'Initial', status: 'completed' }],
      status: 'completed',
      template: 'custom',
      title: 'Reopen workflow',
    });

    const reopened = appendCoordinatorWorkflowSteps({
      append: {
        appendId: 'append-1',
        createdAt: 1_020,
        payloadHash: 'hash-1',
        sourceTaskId: 'task-coordinator',
        stepIds: ['followup'],
      },
      now: 1_020,
      runId: run.id,
      sourceSpec: {
        steps: [
          {
            dependsOn: [],
            id: 'initial',
            kind: 'worker',
            lanes: [],
            name: 'Initial',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
          {
            dependsOn: ['initial'],
            id: 'followup',
            kind: 'worker',
            lanes: [],
            name: 'Followup',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
        ],
        version: 1,
      },
      stages: [{ dependsOn: ['initial'], id: 'followup', kind: 'custom', name: 'Followup' }],
      workflowId: workflow.id,
    });

    expect(reopened.status).toBe('running');
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.execution?.completionReason).toBeUndefined();
    expect(reopened.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'followup', status: 'pending' })]),
    );
  });

  it('marks restore interruption only on unfinished subtasks and keeps completed facts intact', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-running',
      assignment: 'Keep working',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-running',
      toolTokenId: 'token-running',
      worktreePath: '/repo/task-running',
      now: 1_100,
    });
    addCoordinatorSubtask({
      agentId: 'agent-landed',
      assignment: 'Finished work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'landed',
      taskId: 'task-landed',
      toolTokenId: 'token-landed',
      worktreePath: '/repo/task-landed',
      now: 1_200,
    });
    const persisted = getCoordinatorRuntimeState();
    const landedBeforeRestore = persisted.runs[0]?.subtasks.find(
      (subtask) => subtask.taskId === 'task-landed',
    );

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id);
    expect(restored?.subtasks.find((subtask) => subtask.taskId === 'task-running')).toMatchObject({
      interruptedByRestoreAt: expect.any(Number),
      status: 'exited',
    });
    expect(restored?.subtasks.find((subtask) => subtask.taskId === 'task-landed')).toEqual(
      landedBeforeRestore,
    );
  });

  it('round-trips subtask launch payloads through runtime state without exposing them in bootstrap', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent', env: { SECRET_FLAG: 'caller-secret' } },
      assignment: 'Do the work',
      dedupeKey: 'launch-1',
      name: 'Child',
      recordedAt: 1_100,
      runId: run.id,
      taskId: 'task-child',
    });
    const persisted = getCoordinatorRuntimeState();

    expect(persisted.subtaskLaunches).toHaveLength(1);
    expect(JSON.stringify(getCoordinatorBootstrapSnapshot())).not.toContain('caller-secret');
    expect(JSON.stringify(getCoordinatorRun(run.id))).not.toContain('caller-secret');

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toMatchObject({
      dedupeKey: 'launch-1',
      taskId: 'task-child',
    });

    removeCoordinatorSubtaskLaunch(run.id, 'task-child');
    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toBeNull();

    recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent' },
      assignment: 'Do the work',
      dedupeKey: 'launch-2',
      name: 'Child',
      recordedAt: 1_200,
      runId: run.id,
      taskId: 'task-child',
    });
    removeCoordinatorRun(run.id);
    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toBeNull();
  });

  it('resumes stale runs with an appended audit entry and rejects non-stale resumes', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const resumed = resumeCoordinatorRunFromStale(run.id, { now: 2_000, resumeId: 'resume-1' });
    expect(resumed).toMatchObject({
      resumes: [
        {
          failedTaskIds: [],
          requestedAt: 2_000,
          respawnedTaskIds: [],
          resumeId: 'resume-1',
        },
      ],
      status: 'running',
    });

    updateCoordinatorSubtaskStatus(run.id, 'task-child', 'running', {
      interruptedByRestoreAt: undefined,
      now: 2_100,
      toolTokenId: 'token-rotated',
    });
    expect(getCoordinatorRun(run.id)?.subtasks[0]).toMatchObject({
      status: 'running',
      toolTokenId: 'token-rotated',
    });
    expect(getCoordinatorRun(run.id)?.subtasks[0]?.interruptedByRestoreAt).toBeUndefined();

    const recorded = recordCoordinatorRunResumeOutcome(
      run.id,
      'resume-1',
      {
        failedTaskIds: [],
        respawnedTaskIds: ['task-child'],
      },
      2_200,
    );
    expect(recorded.resumes).toEqual([
      {
        failedTaskIds: [],
        requestedAt: 2_000,
        respawnedTaskIds: ['task-child'],
        resumeId: 'resume-1',
      },
    ]);

    expect(() => resumeCoordinatorRunFromStale(run.id, { resumeId: 'resume-2' })).toThrow(
      'Coordinator run is running',
    );
  });

  it('sets and clears the paused marker through setCoordinatorRunPaused', () => {
    const events: unknown[] = [];
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const cleanup = subscribeCoordinatorEvents((event) => events.push(event));

    const paused = setCoordinatorRunPaused(run.id, true, 2_000);
    expect(paused).toMatchObject({ pausedAt: 2_000, status: 'paused-by-user' });

    const unpaused = setCoordinatorRunPaused(run.id, false, 3_000);
    expect(unpaused.status).toBe('running');
    expect(unpaused.pausedAt).toBeUndefined();
    expect(unpaused.eventVersion).toBeGreaterThan(paused.eventVersion);
    expect(events.map((event) => (event as { eventType: string }).eventType)).toEqual([
      'run-meta-upserted',
      'run-meta-upserted',
    ]);

    cleanup();
  });

  it('restores a paused run as stale with the paused marker and resumes it back to paused', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    setCoordinatorRunPaused(run.id, true, 2_000);
    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorRun(run.id)).toMatchObject({
      pausedAt: 2_000,
      status: 'stale-after-restore',
    });

    const resumed = resumeCoordinatorRunFromStale(run.id, { now: 3_000, resumeId: 'resume-1' });
    expect(resumed).toMatchObject({ pausedAt: 2_000, status: 'paused-by-user' });

    const unpaused = setCoordinatorRunPaused(run.id, false, 4_000);
    expect(unpaused.status).toBe('running');
    expect(unpaused.pausedAt).toBeUndefined();
  });

  it('records pending approvals append-only and patches them on resolution', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowLane({
      assignment: 'Decide next steps.',
      id: 'lane-decide',
      name: 'Decide',
      runId: run.id,
      stageId: 'decide',
      status: 'waiting-for-result',
      taskId: 'task-decide',
      workflowId: workflow.id,
      now: 1_100,
    });

    const approval = addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });
    expect(approval.status).toBe('pending');

    const duplicate = addCoordinatorWorkflowPendingApproval({
      actions: [],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_300,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });
    expect(duplicate).toEqual(approval);
    expect(getCoordinatorRun(run.id)?.workflows[0]?.pendingApprovals).toHaveLength(1);

    const resolved = resolveCoordinatorWorkflowPendingApproval(
      run.id,
      workflow.id,
      'result-1:approval',
      'denied',
      { now: 1_400, reason: 'Not needed.' },
    );
    expect(resolved).toMatchObject({
      reason: 'Not needed.',
      resolvedAt: 1_400,
      status: 'denied',
    });
    expect(getCoordinatorRun(run.id)?.workflows[0]?.pendingApprovals).toEqual([resolved]);
    expect(() =>
      resolveCoordinatorWorkflowPendingApproval(run.id, workflow.id, 'missing', 'cancelled'),
    ).toThrow('Coordinator workflow approval not found');
  });

  it('cancels pending approvals with a journal entry when restoring workflow state', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id)?.workflows[0];
    expect(restored?.pendingApprovals).toEqual([
      expect.objectContaining({
        id: 'result-1:approval',
        reason: 'stale-after-restore',
        status: 'cancelled',
      }),
    ]);
    const cancellationEntry = restored?.journal.find(
      (entry) => entry.kind === 'decision-approval-cancelled',
    );
    expect(cancellationEntry).toMatchObject({
      laneId: 'lane-decide',
      resultId: 'result-1',
    });
    expect(cancellationEntry?.seq).toBe(restored?.journal.length ?? 0);
  });

  it('resolves pending approvals when subtask cleanup cancels the owning lane', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowLane({
      assignment: 'Decide next steps.',
      id: 'lane-decide',
      name: 'Decide',
      runId: run.id,
      stageId: 'decide',
      status: 'waiting-for-result',
      taskId: 'task-decide',
      workflowId: workflow.id,
      now: 1_100,
    });
    addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });

    cancelCoordinatorWorkflowLanesForTask(run.id, 'task-decide', 'subtask closed');

    const updated = getCoordinatorRun(run.id)?.workflows[0];
    expect(updated?.pendingApprovals).toEqual([
      expect.objectContaining({ reason: 'subtask closed', status: 'cancelled' }),
    ]);
    expect(updated?.journal.some((entry) => entry.kind === 'decision-approval-cancelled')).toBe(
      true,
    );
  });

  it('bounds remembered tool-call results and evicts the oldest entries', () => {
    vi.useFakeTimers();
    for (let index = 0; index <= COORDINATOR_LIMITS.maxRememberedToolCallResults; index += 1) {
      vi.setSystemTime(index);
      rememberCoordinatorToolResult(`call-${index}`, { index });
    }

    expect(getCoordinatorToolResult('call-0')).toBeUndefined();
    expect(
      getCoordinatorToolResult(`call-${COORDINATOR_LIMITS.maxRememberedToolCallResults}`),
    ).toEqual({
      index: COORDINATOR_LIMITS.maxRememberedToolCallResults,
    });
  });

  it('counts only pending prompts in coordinator diagnostics queue depth', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const delivered = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_200,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Delivered',
    });
    const failed = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_300,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Failed',
    });
    enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_400,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Pending',
    });
    updateCoordinatorPrompt(run.id, delivered.requestId, { status: 'delivered' });
    updateCoordinatorPrompt(run.id, failed.requestId, { status: 'failed' });

    expect(getCoordinatorDiagnostics().promptQueueDepth).toBe(1);
  });

  it('keeps diagnostics scans below 5ms at p90 with multi-megabyte entity payloads', () => {
    const largeAssignment = 'x'.repeat(64_000);
    const runCount = 6;
    const subtasksPerRun = 40;
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const run = createCoordinatorRun({
        coordinatorTaskId: `task-coordinator-${runIndex}`,
        now: 1_000 + runIndex,
        projectId: 'project-1',
        projectMode: 'git',
        projectRoot: '/repo',
      });
      for (let subtaskIndex = 0; subtaskIndex < subtasksPerRun; subtaskIndex += 1) {
        addCoordinatorSubtask({
          agentId: `agent-${runIndex}-${subtaskIndex}`,
          assignment: largeAssignment,
          parentCoordinatorTaskId: run.coordinatorTaskId,
          runId: run.id,
          status: 'running',
          taskId: `task-${runIndex}-${subtaskIndex}`,
          toolTokenId: `token-${runIndex}-${subtaskIndex}`,
          worktreePath: `/repo/task-${runIndex}-${subtaskIndex}`,
          now: 2_000 + subtaskIndex,
        });
      }
    }

    expect(getCoordinatorDiagnostics().activeSubtasks).toBe(runCount * subtasksPerRun);
    const latenciesMs: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const startedAt = process.hrtime.bigint();
      getCoordinatorDiagnostics();
      latenciesMs.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }
    const sortedLatencies = [...latenciesMs].sort((left, right) => left - right);
    const p90LatencyMs = sortedLatencies[Math.floor(sortedLatencies.length * 0.9)] ?? 0;

    expect(p90LatencyMs).toBeLessThan(5);
  });
});

describe('coordinator runtime granular events', () => {
  afterEach(() => {
    resetCoordinatorRuntimeForTests();
    vi.useRealTimers();
  });

  function createRunWithListener(): {
    events: Array<{ entityKey: string; eventType: string; payload: unknown }>;
    run: ReturnType<typeof createCoordinatorRun>;
    cleanup: () => void;
  } {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const events: Array<{ entityKey: string; eventType: string; payload: unknown }> = [];
    const cleanup = subscribeCoordinatorEvents((event) => {
      events.push({
        entityKey: event.entityKey,
        eventType: event.eventType,
        payload: event.payload,
      });
    });
    return { cleanup, events, run };
  }

  it('emits exactly one granular event per mutation instead of full-run snapshots', () => {
    const { cleanup, events, run } = createRunWithListener();

    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
    });
    expect(events.map((event) => event.eventType)).toEqual(['subtask-upserted']);

    events.length = 0;
    updateCoordinatorRunStatus(run.id, 'draining');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityKey: `run:${run.id}`,
      eventType: 'run-meta-upserted',
    });
    const metaPayload = events[0]?.payload as Record<string, unknown>;
    expect(metaPayload.status).toBe('draining');
    expect('subtasks' in metaPayload).toBe(false);
    expect('promptQueue' in metaPayload).toBe(false);
    expect('workflows' in metaPayload).toBe(false);
    expect('landing' in metaPayload).toBe(false);

    events.length = 0;
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ kind: 'map', name: 'Scan' }],
      template: 'custom',
      title: 'Scan workflow',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityKey: `workflow:${workflow.id}`,
      eventType: 'workflow-upserted',
    });
    expect((events[0]?.payload as { id?: string }).id).toBe(workflow.id);

    cleanup();
  });

  it('emits run-meta-upserted for pause, resume, and resume-outcome mutations', () => {
    const { cleanup, events, run } = createRunWithListener();

    setCoordinatorRunPaused(run.id, true, 2_000);
    updateCoordinatorRunStatus(run.id, 'stale-after-restore');
    resumeCoordinatorRunFromStale(run.id, { now: 3_000, resumeId: 'resume-1' });
    recordCoordinatorRunResumeOutcome(run.id, 'resume-1', {
      failedTaskIds: [],
      respawnedTaskIds: ['task-child'],
    });

    expect(events.map((event) => event.eventType)).toEqual([
      'run-meta-upserted',
      'run-meta-upserted',
      'run-meta-upserted',
      'run-meta-upserted',
    ]);

    cleanup();
  });

  it('isolates a throwing listener from later listeners and keeps the mutation applied', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    const cleanupThrowing = subscribeCoordinatorEvents(() => {
      throw new Error('listener exploded');
    });
    const cleanupSecond = subscribeCoordinatorEvents((event) => {
      received.push(event.eventType);
    });

    const updated = updateCoordinatorRunStatus(run.id, 'draining');

    expect(updated.status).toBe('draining');
    expect(updated).not.toHaveProperty('subtasks');
    expect(updated).not.toHaveProperty('workflows');
    expect(getCoordinatorRun(run.id)?.status).toBe('draining');
    expect(received).toEqual(['run-meta-upserted']);
    expect(consoleErrorSpy).toHaveBeenCalled();

    cleanupThrowing();
    cleanupSecond();
    consoleErrorSpy.mockRestore();
  });

  it('shares one deep-frozen clone across listeners', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const seen: unknown[] = [];
    const cleanupFirst = subscribeCoordinatorEvents((event) => {
      seen.push(event);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.payload)).toBe(true);
      expect(() => {
        (event as { runId: string }).runId = 'tampered';
      }).toThrow();
    });
    const cleanupSecond = subscribeCoordinatorEvents((event) => {
      seen.push(event);
    });

    updateCoordinatorRunStatus(run.id, 'draining');

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);

    cleanupFirst();
    cleanupSecond();
  });
});
