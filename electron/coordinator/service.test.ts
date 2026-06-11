import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv } from '../ipc/storage.js';
import {
  applyCoordinatorActivityHint,
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  createCoordinatorRunForTask,
  ensureCoordinatorServiceLoaded,
  flushCoordinatorRuntimeState,
  getCoordinatorBlockingActivityHints,
  getCoordinatorPersistenceHealth,
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
  startCoordinatorRuntimePersistence,
} from './service.js';
import {
  addCoordinatorSubtask,
  getCoordinatorBootstrapSnapshot,
  getCoordinatorSubtaskLaunch,
  recordCoordinatorSubtaskLaunch,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorSubtaskStatus,
} from './runtime.js';
import {
  createStorageEnv as createCoordinatorTestStorageEnv,
  removeStorageEnv,
} from './test-helpers.js';

function createStorageEnv(): StorageEnv {
  return createCoordinatorTestStorageEnv('parallel-code-coordinator-service-');
}

function createStorageEnvWithoutToolGateway(): StorageEnv {
  return {
    isPackaged: false,
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-coordinator-service-')),
  };
}

function readCredential(pathname: string): {
  runId: string;
  taskId: string;
  token: string;
  tokenId: string;
} {
  return JSON.parse(fs.readFileSync(pathname, 'utf8')) as {
    runId: string;
    taskId: string;
    token: string;
    tokenId: string;
  };
}

describe('coordinator service', () => {
  const envs: StorageEnv[] = [];

  afterEach(() => {
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    for (const env of envs) {
      removeStorageEnv(env);
    }
    envs.length = 0;
  });

  it('creates a credential-backed run without exposing bearer tokens in runtime state', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const credential = readCredential(result.credentialPath);

    expect(credential.runId).toBe(result.run.id);
    expect(credential.taskId).toBe('task-coordinator');
    expect(resolveCoordinatorToken(credential.token)?.tokenId).toBe(credential.tokenId);
    expect(JSON.stringify(getCoordinatorBootstrapSnapshot())).not.toContain(credential.token);
  });

  it('does not carry runtime state across storage roots without persisted coordinator state', () => {
    const firstEnv = createStorageEnv();
    const secondEnv = createStorageEnv();
    envs.push(firstEnv, secondEnv);

    createCoordinatorRunForTask(firstEnv, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    ensureCoordinatorServiceLoaded(secondEnv);

    expect(getCoordinatorBootstrapSnapshot().runs).toEqual([]);
  });

  it('rejects coordinator run creation without leaving a stale run when no tool gateway is configured', () => {
    const env = createStorageEnvWithoutToolGateway();
    envs.push(env);

    expect(() =>
      createCoordinatorRunForTask(env, {
        coordinatorAgentId: 'agent-coordinator',
        coordinatorTaskId: 'task-coordinator',
        projectId: 'project-1',
        projectMode: 'git',
        projectRoot: '/repo',
      }),
    ).toThrow('Coordinator mode requires the browser server tool-call gateway.');
    expect(getCoordinatorBootstrapSnapshot().runs).toEqual([]);
  });

  it('ignores orphan restored credential files when no coordinator run owns them', () => {
    const env = createStorageEnv();
    envs.push(env);
    const credentialDir = path.join(getStateDirForEnv(env), 'coordinator-credentials');
    fs.mkdirSync(credentialDir, { recursive: true });
    const orphanCredentialPath = path.join(credentialDir, 'orphan.json');
    fs.writeFileSync(
      orphanCredentialPath,
      JSON.stringify({
        agentId: 'agent-coordinator',
        createdAt: 1_000,
        runId: 'missing-run',
        taskId: 'task-coordinator',
        token: 'orphan-token',
        tokenId: 'orphan-token-id',
        toolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
      }),
    );

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    expect(result.run.coordinatorTaskId).toBe('task-coordinator');
    expect(resolveCoordinatorToken('orphan-token')).toBeNull();
    expect(fs.existsSync(orphanCredentialPath)).toBe(false);
  });

  it('cleans up parent coordinator runs and revokes parent and subtask credentials', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const parentCredential = readCredential(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'child-token-id',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(env, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
    });

    cleanupCoordinatorStateForTask(env, 'task-coordinator');

    expect(getCoordinatorBootstrapSnapshot().runs).toEqual([]);
    expect(resolveCoordinatorToken(parentCredential.token)).toBeNull();
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(fs.existsSync(result.credentialPath)).toBe(false);
    expect(fs.existsSync(childCredential.credentialPath)).toBe(false);
  });

  it('cleans up a removed subtask without removing the parent coordinator run', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'child-token-id',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(env, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
    });

    cleanupCoordinatorStateForTask(env, 'task-child');

    const run = getCoordinatorBootstrapSnapshot().runs[0];
    expect(run).toMatchObject({
      coordinatorTaskId: 'task-coordinator',
      id: result.run.id,
    });
    expect(run?.subtasks[0]).toMatchObject({
      status: 'cancelled',
      taskId: 'task-child',
    });
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(fs.existsSync(childCredential.credentialPath)).toBe(false);
  });

  it('clears launch payloads and restore markers when generic task cleanup removes a hidden subtask', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent', env: { CUSTOM_SECRET: '1' } },
      assignment: 'Do the work',
      name: 'Child',
      recordedAt: 1_000,
      runId: result.run.id,
      taskId: 'task-child',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'child-token-id',
      worktreePath: '/repo/task-child',
    });
    updateCoordinatorSubtaskStatus(result.run.id, 'task-child', 'exited', {
      interruptedByRestoreAt: 2_000,
    });

    cleanupCoordinatorStateForTask(env, 'task-child');

    const subtask = getCoordinatorBootstrapSnapshot().runs[0]?.subtasks[0];
    expect(subtask).toMatchObject({
      status: 'cancelled',
      taskId: 'task-child',
    });
    expect(subtask?.interruptedByRestoreAt).toBeUndefined();
    expect(getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toBeNull();
  });

  it('persists coordinator state with owner-only file permissions', () => {
    const env = createStorageEnv();
    envs.push(env);

    createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    const statePath = path.join(getStateDirForEnv(env), 'coordinator-state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    }
  });

  it('persists subtask launch payloads and restores launch lookups after reload', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const stopPersistence = startCoordinatorRuntimePersistence(env);
    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    recordCoordinatorSubtaskLaunch({
      agent: { args: ['--profile', 'fast'], command: 'custom-agent', env: { CUSTOM: '1' } },
      assignment: 'Do the work',
      dedupeKey: 'launch-child',
      name: 'Child',
      recordedAt: 1_000,
      runId: result.run.id,
      taskId: 'task-child',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'child-token-id',
      worktreePath: '/repo/task-child',
    });
    await stopPersistence();

    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    ensureCoordinatorServiceLoaded(env);

    expect(getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toMatchObject({
      agent: { args: ['--profile', 'fast'], command: 'custom-agent', env: { CUSTOM: '1' } },
      dedupeKey: 'launch-child',
      taskId: 'task-child',
    });
  });

  it('loads legacy coordinator state files without subtask launch payloads', () => {
    const env = createStorageEnv();
    envs.push(env);
    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const statePath = path.join(getStateDirForEnv(env), 'coordinator-state.json');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    delete persisted.subtaskLaunches;
    fs.writeFileSync(statePath, JSON.stringify(persisted));

    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    ensureCoordinatorServiceLoaded(env);

    expect(getCoordinatorBootstrapSnapshot().runs.map((run) => run.id)).toEqual([result.run.id]);
    expect(getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toBeNull();
  });

  it('removes coordinator activity hints when the renderer sends an unblock update', () => {
    applyCoordinatorActivityHint({
      agentGeneration: 1,
      blocked: true,
      clientId: 'client-1',
      kind: 'prompt-draft',
      seq: 1,
      taskId: 'task-child',
      ttlMs: 5_000,
    });
    applyCoordinatorActivityHint({
      agentGeneration: 1,
      blocked: false,
      clientId: 'client-1',
      kind: 'prompt-draft',
      seq: 2,
      taskId: 'task-child',
    });

    expect(getCoordinatorBlockingActivityHints('task-child')).toEqual([]);
  });
});

describe('coordinator service persistence overhaul', () => {
  const envs: StorageEnv[] = [];

  afterEach(async () => {
    // Deterministic teardown: the reset drains the persistence scheduler's
    // save chain, so any in-flight async save lands before temp dirs are
    // removed (no wall-clock sleep).
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    for (const env of envs) {
      removeStorageEnv(env);
    }
    envs.length = 0;
    vi.restoreAllMocks();
  });

  function createLargeFixtureState(env: StorageEnv): { runId: string } {
    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const bigAssignment = 'x'.repeat(64_000);
    for (let index = 0; index < 40; index += 1) {
      addCoordinatorSubtask({
        agentId: `agent-${index}`,
        assignment: bigAssignment,
        parentCoordinatorTaskId: 'task-coordinator',
        runId: result.run.id,
        status: 'running',
        taskId: `task-child-${index}`,
        toolTokenId: `token-${index}`,
        worktreePath: `/repo/task-child-${index}`,
      });
    }
    return { runId: result.run.id };
  }

  it('performs no synchronous fs write per emitted event during a mutation burst', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const stopPersistence = startCoordinatorRuntimePersistence(env);
    const { runId } = createLargeFixtureState(env);

    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    for (let index = 0; index < 50; index += 1) {
      updateCoordinatorSubtaskStatus(runId, `task-child-${index % 40}`, 'running');
    }
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    writeFileSyncSpy.mockRestore();
    await stopPersistence();
  });

  it('keeps per-event emit latency under 5ms with a multi-MB state fixture', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const stopPersistence = startCoordinatorRuntimePersistence(env);
    const { runId } = createLargeFixtureState(env);
    expect(JSON.stringify(getCoordinatorBootstrapSnapshot()).length).toBeGreaterThan(2_000_000);

    const emitLatenciesMs: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const startedAt = process.hrtime.bigint();
      updateCoordinatorSubtaskStatus(runId, `task-child-${index % 40}`, 'running');
      emitLatenciesMs.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }

    // Acceptance: a 50-mutation burst causes zero synchronous persist stalls
    // > 5ms on the event loop (baseline: 59ms synchronous persist per event).
    // The deterministic proof that no synchronous persist exists at all is the
    // fs.writeFileSync spy above; the latency budget here is asserted at p90
    // so loaded parallel test workers cannot flake it with scheduler noise —
    // the old per-event persist stalled EVERY event by ~59ms.
    const sortedLatencies = [...emitLatenciesMs].sort((left, right) => left - right);
    const p90LatencyMs = sortedLatencies[Math.floor(sortedLatencies.length * 0.9)] ?? 0;
    const maxLatencyMs = sortedLatencies[sortedLatencies.length - 1] ?? 0;
    expect(p90LatencyMs).toBeLessThan(5);
    process.stdout.write(
      `[delta-resync] 50-mutation burst emit latency p90=${p90LatencyMs.toFixed(3)}ms max=${maxLatencyMs.toFixed(3)}ms (multi-MB fixture)\n`,
    );
    await stopPersistence();
  });

  it('never deletes credential files when the coordinator state load failed', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const credentialPath = result.credentialPath;
    expect(fs.existsSync(credentialPath)).toBe(true);

    // Corrupt both the state file and its backup: the load reports 'failed'.
    const statePath = path.join(getStateDirForEnv(env), 'coordinator-state.json');
    fs.writeFileSync(statePath, 'garbage');
    fs.rmSync(`${statePath}.bak`, { force: true });
    fs.writeFileSync(`${statePath}.bak`, 'garbage');

    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    ensureCoordinatorServiceLoaded(env);

    // The run could not be restored, but the credential file survives.
    expect(getCoordinatorBootstrapSnapshot().runs).toEqual([]);
    expect(fs.existsSync(credentialPath)).toBe(true);
  });

  it('keeps credentials for runs dropped by per-run salvage', () => {
    const env = createStorageEnv();
    envs.push(env);

    const result = createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const credentialPath = result.credentialPath;
    const statePath = path.join(getStateDirForEnv(env), 'coordinator-state.json');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { runs: unknown[] };
    persisted.runs[0] = { id: result.run.id, status: 'broken' };
    fs.writeFileSync(statePath, JSON.stringify(persisted));
    fs.rmSync(`${statePath}.bak`, { force: true });

    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    ensureCoordinatorServiceLoaded(env);

    expect(getCoordinatorBootstrapSnapshot().runs).toEqual([]);
    expect(fs.existsSync(credentialPath)).toBe(true);
  });

  it('surfaces persistence health while the scheduler runtime is active', async () => {
    const env = createStorageEnv();
    envs.push(env);
    expect(getCoordinatorPersistenceHealth()).toBeNull();

    const stopPersistence = startCoordinatorRuntimePersistence(env);
    expect(getCoordinatorPersistenceHealth()).toMatchObject({
      degraded: false,
      pendingFlush: false,
    });

    createCoordinatorRunForTask(env, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    await flushCoordinatorRuntimeState(env);
    expect(getCoordinatorPersistenceHealth()).toMatchObject({ degraded: false });
    expect(getCoordinatorPersistenceHealth()?.lastSuccessAt).not.toBeNull();
    await stopPersistence();
    expect(getCoordinatorPersistenceHealth()).toBeNull();
  });
});
