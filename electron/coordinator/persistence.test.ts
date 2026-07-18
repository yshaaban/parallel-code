import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CoordinatorPromptRequestSnapshot,
  CoordinatorRunSnapshot,
  CoordinatorRunStatus,
} from '../../src/domain/coordinator.js';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv } from '../ipc/storage.js';
import {
  compactCoordinatorRuntimeStateForPersistence,
  loadCoordinatorRuntimeStateForEnv,
  saveCoordinatorRuntimeStateForEnv,
  saveCoordinatorRuntimeStateForEnvAsync,
} from './persistence.js';
import type { CoordinatorRuntimeState } from './runtime.js';
import { createStorageEnv, removeStorageEnv } from './test-helpers.test-helper.js';

function createRunSnapshot(
  id: string,
  overrides: Partial<CoordinatorRunSnapshot> = {},
): CoordinatorRunSnapshot {
  return {
    coordinatorTaskId: `task-${id}`,
    createdAt: 1_000,
    eventVersion: 1,
    id,
    landing: [],
    limits: {
      maxActiveSubtasks: 5,
      maxPendingPromptsPerTarget: 3,
      maxQueuedSubtasks: 20,
    },
    projectId: 'project-1',
    projectMode: 'git',
    projectRoot: '/repo',
    promptQueue: [],
    status: 'running',
    subtasks: [],
    updatedAt: 1_000,
    workflows: [],
    ...overrides,
  };
}

function createPromptSnapshot(
  requestId: string,
  runId: string,
  overrides: Partial<CoordinatorPromptRequestSnapshot> = {},
): CoordinatorPromptRequestSnapshot {
  return {
    attempts: 1,
    createdAt: 1_000,
    dedupeKey: requestId,
    deliveryJournal: [
      {
        agentGeneration: 1,
        deliveryAttemptId: `${requestId}-attempt`,
        ptySessionId: 'agent:1',
        requestId,
        writePreparedAt: 1_000,
      },
    ],
    earliestDeliveryAt: 1_000,
    kind: 'follow-up',
    requestId,
    runId,
    sourceTaskId: 'task-coordinator',
    status: 'delivered',
    targetAgentId: 'agent-child',
    targetTaskId: 'task-child',
    text: 'Do the thing',
    ...overrides,
  };
}

function createRuntimeState(
  overrides: Partial<CoordinatorRuntimeState> = {},
): CoordinatorRuntimeState {
  return {
    runs: [createRunSnapshot('run-1')],
    stateVersion: 7,
    subtaskLaunches: [],
    toolCallResults: [],
    ...overrides,
  };
}

function getStatePath(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), 'coordinator-state.json');
}

describe('coordinator persistence durability', () => {
  const envs: StorageEnv[] = [];

  function createEnv(): StorageEnv {
    const env = createStorageEnv('parallel-code-coordinator-persistence-');
    envs.push(env);
    return env;
  }

  afterEach(() => {
    for (const env of envs.splice(0)) {
      removeStorageEnv(env);
    }
  });

  it('round-trips state and reports outcome ok', () => {
    const env = createEnv();
    saveCoordinatorRuntimeStateForEnv(env, createRuntimeState());

    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.outcome).toBe('ok');
    expect(result.droppedRunCount).toBe(0);
    expect(result.state?.runs.map((run) => run.id)).toEqual(['run-1']);
    expect(result.state?.stateVersion).toBe(7);
  });

  it('reports missing when no state file or backup exists', () => {
    const env = createEnv();
    expect(loadCoordinatorRuntimeStateForEnv(env)).toEqual({
      droppedRunCount: 0,
      outcome: 'missing',
      state: null,
    });
  });

  it('drops only the corrupt run and keeps the rest (salvaged outcome)', () => {
    const env = createEnv();
    const statePath = getStatePath(env);
    const state = createRuntimeState({
      runs: [createRunSnapshot('run-1'), createRunSnapshot('run-2')],
      toolCallResults: [{ createdAt: 1_000, key: 'call-1', result: { ok: true } }],
    });
    saveCoordinatorRuntimeStateForEnv(env, state);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { runs: unknown[] };
    persisted.runs[1] = { id: 'run-2', status: 'not-a-real-status' };
    fs.writeFileSync(statePath, JSON.stringify(persisted));

    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.outcome).toBe('salvaged');
    expect(result.droppedRunCount).toBe(1);
    expect(result.state?.runs.map((run) => run.id)).toEqual(['run-1']);
    expect(result.state?.toolCallResults).toHaveLength(1);
  });

  it('falls back to the .bak sibling when the primary is unreadable and quarantines it', () => {
    const env = createEnv();
    const statePath = getStatePath(env);
    saveCoordinatorRuntimeStateForEnv(env, createRuntimeState());
    // Second save rotates the first contents into .bak.
    saveCoordinatorRuntimeStateForEnv(
      env,
      createRuntimeState({ runs: [createRunSnapshot('run-1'), createRunSnapshot('run-2')] }),
    );
    fs.writeFileSync(statePath, '{ definitely not json');

    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.outcome).toBe('salvaged');
    expect(result.state?.runs.map((run) => run.id)).toEqual(['run-1']);

    const quarantineFiles = fs
      .readdirSync(path.dirname(statePath))
      .filter((entry) => entry.startsWith('coordinator-state.json.corrupt-'));
    expect(quarantineFiles).toHaveLength(1);
  });

  it('returns failed (never null state silently) when primary and backup are both corrupt', () => {
    const env = createEnv();
    const statePath = getStatePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'garbage');
    fs.writeFileSync(`${statePath}.bak`, 'more garbage');

    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.outcome).toBe('failed');
    expect(result.state).toBeNull();
  });

  it('loads legacy uncompacted files without subtaskLaunches', () => {
    const env = createEnv();
    const statePath = getStatePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        runs: [createRunSnapshot('run-legacy')],
        stateVersion: 3,
        toolCallResults: [{ key: 'legacy-call', result: 'ok' }],
      }),
    );

    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.outcome).toBe('ok');
    expect(result.state?.subtaskLaunches).toEqual([]);
    expect(result.state?.toolCallResults[0]).toMatchObject({ createdAt: 0, key: 'legacy-call' });
  });

  it('writes the async save atomically with a .bak sibling and owner-only permissions', async () => {
    const env = createEnv();
    const statePath = getStatePath(env);
    await saveCoordinatorRuntimeStateForEnvAsync(env, createRuntimeState());
    await saveCoordinatorRuntimeStateForEnvAsync(env, createRuntimeState({ stateVersion: 8 }));

    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(`${statePath}.bak`)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${statePath}.bak`).mode & 0o777).toBe(0o600);
    }
    const result = loadCoordinatorRuntimeStateForEnv(env);
    expect(result.state?.stateVersion).toBe(8);
  });
});

describe('coordinator persistence compaction', () => {
  it('strips delivery journals and launch payloads for terminal runs only', () => {
    const terminalRun = createRunSnapshot('run-done', {
      promptQueue: [createPromptSnapshot('prompt-done', 'run-done')],
      status: 'completed',
    });
    const liveRun = createRunSnapshot('run-live', {
      promptQueue: [createPromptSnapshot('prompt-live', 'run-live')],
      status: 'running',
    });
    const compacted = compactCoordinatorRuntimeStateForPersistence(
      createRuntimeState({
        runs: [terminalRun, liveRun],
        subtaskLaunches: [
          {
            agent: { command: 'codex' },
            assignment: 'done work',
            dedupeKey: 'launch-done',
            name: 'Done',
            recordedAt: 1_000,
            runId: 'run-done',
            taskId: 'task-done',
          },
          {
            agent: { command: 'codex' },
            assignment: 'live work',
            dedupeKey: 'launch-live',
            name: 'Live',
            recordedAt: 1_000,
            runId: 'run-live',
            taskId: 'task-live',
          },
        ],
      }),
    );

    const compactedTerminalRun = compacted.runs.find((run) => run.id === 'run-done');
    const compactedLiveRun = compacted.runs.find((run) => run.id === 'run-live');
    expect(compactedTerminalRun?.promptQueue[0]?.deliveryJournal).toEqual([]);
    expect(compactedLiveRun?.promptQueue[0]?.deliveryJournal).toHaveLength(1);
    expect(compacted.subtaskLaunches.map((launch) => launch.runId)).toEqual(['run-live']);
  });

  it('caps retained completed runs to the newest by updatedAt and keeps live runs', () => {
    const terminalRuns = Array.from({ length: 25 }, (_, index) =>
      createRunSnapshot(`run-done-${index}`, {
        status: 'completed' as CoordinatorRunStatus,
        updatedAt: 1_000 + index,
      }),
    );
    const liveRun = createRunSnapshot('run-live');
    const compacted = compactCoordinatorRuntimeStateForPersistence(
      createRuntimeState({ runs: [...terminalRuns, liveRun] }),
    );

    const retainedTerminal = compacted.runs.filter((run) => run.status === 'completed');
    expect(retainedTerminal).toHaveLength(20);
    expect(retainedTerminal.map((run) => run.id)).not.toContain('run-done-0');
    expect(compacted.runs.some((run) => run.id === 'run-live')).toBe(true);
  });

  it('caps retained resumes and settled prompts per run while keeping pending prompts', () => {
    const resumes = Array.from({ length: 30 }, (_, index) => ({
      failedTaskIds: [],
      requestedAt: 1_000 + index,
      respawnedTaskIds: [],
      resumeId: `resume-${index}`,
    }));
    const settledPrompts = Array.from({ length: 120 }, (_, index) =>
      createPromptSnapshot(`prompt-${index}`, 'run-1', { createdAt: 1_000 + index }),
    );
    const pendingPrompt = createPromptSnapshot('prompt-pending', 'run-1', {
      createdAt: 1,
      status: 'queued',
    });
    const compacted = compactCoordinatorRuntimeStateForPersistence(
      createRuntimeState({
        runs: [
          createRunSnapshot('run-1', {
            promptQueue: [pendingPrompt, ...settledPrompts],
            resumes,
          }),
        ],
      }),
    );

    const run = compacted.runs[0];
    expect(run?.resumes).toHaveLength(20);
    expect(run?.resumes?.[0]?.resumeId).toBe('resume-10');
    const retainedSettled = run?.promptQueue.filter((prompt) => prompt.status === 'delivered');
    expect(retainedSettled).toHaveLength(100);
    expect(run?.promptQueue.some((prompt) => prompt.requestId === 'prompt-pending')).toBe(true);
  });

  it('caps total retained tool-call result bytes newest-first', () => {
    const bigResult = 'x'.repeat(1_500_000);
    const toolCallResults = Array.from({ length: 5 }, (_, index) => ({
      createdAt: 1_000 + index,
      key: `call-${index}`,
      result: bigResult,
    }));
    const compacted = compactCoordinatorRuntimeStateForPersistence(
      createRuntimeState({ toolCallResults }),
    );

    // ~1.5MB each against the 4MB cap: only the two newest survive.
    expect(compacted.toolCallResults.map((entry) => entry.key)).toEqual(['call-3', 'call-4']);
  });
});
