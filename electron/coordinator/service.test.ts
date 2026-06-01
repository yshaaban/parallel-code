import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv } from '../ipc/storage.js';
import {
  applyCoordinatorActivityHint,
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  createCoordinatorRunForTask,
  ensureCoordinatorServiceLoaded,
  getCoordinatorBlockingActivityHints,
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
} from './service.js';
import {
  addCoordinatorSubtask,
  getCoordinatorBootstrapSnapshot,
  resetCoordinatorRuntimeForTests,
} from './runtime.js';

function createStorageEnv(): StorageEnv {
  return {
    isPackaged: false,
    coordinatorToolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-coordinator-service-')),
  } as StorageEnv & { coordinatorToolCallUrl: string };
}

function createStorageEnvWithoutToolGateway(): StorageEnv {
  return {
    isPackaged: false,
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-coordinator-service-')),
  };
}

function removeStorageEnv(env: StorageEnv): void {
  fs.rmSync(env.userDataPath, { force: true, recursive: true });
  fs.rmSync(`${env.userDataPath}-dev`, { force: true, recursive: true });
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
