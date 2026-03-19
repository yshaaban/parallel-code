import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  recoverHydraDaemonState,
  resetHydraStartupRecoveryForTests,
  shouldResumeHydraOnStart,
} from './hydra-startup-recovery.mjs';

function getLockPath(projectRoot) {
  return path.join(
    os.tmpdir(),
    `parallel-code-hydra-startup-${createHash('sha1').update(projectRoot).digest('hex')}.lock`,
  );
}

async function clearLock(projectRoot) {
  await fs.unlink(getLockPath(projectRoot)).catch(() => {});
}

test('shouldResumeHydraOnStart reads the startup flag consistently', () => {
  assert.equal(shouldResumeHydraOnStart({ resumeOnStart: 'true' }), true);
  assert.equal(shouldResumeHydraOnStart({ 'resume-on-start': 'yes' }), true);
  assert.equal(shouldResumeHydraOnStart({ resumeonstart: 'on' }), true);
  assert.equal(shouldResumeHydraOnStart({ resumeOnStart: '' }), false);
  assert.equal(shouldResumeHydraOnStart({}), false);
});

test('recoverHydraDaemonState replays daemon recovery and returns launch targets', async () => {
  resetHydraStartupRecoveryForTests();
  const projectRoot = `/tmp/parallel-code-hydra-recovery-${process.pid}`;
  await clearLock(projectRoot);

  const calls = [];
  const logs = [];
  const requestFn = async (method, baseUrl, route, body) => {
    calls.push({ body, baseUrl, method, route });

    if (method === 'GET' && route === '/session/status') {
      return {
        activeSession: {
          pauseReason: 'taking a break',
          status: 'paused',
        },
        agentSuggestions: {
          codex: { action: 'dispatch' },
        },
        inProgressTasks: [{ id: 'T-2', owner: 'claude' }],
        pendingHandoffs: [{ from: 'gemini', id: 'H-1', to: 'codex' }],
        staleTasks: [{ id: 'T-1', owner: 'claude', updatedAt: '2026-03-19T10:00:00.000Z' }],
      };
    }

    return {};
  };

  const result = await recoverHydraDaemonState({
    agents: ['codex', 'claude'],
    baseUrl: 'http://127.0.0.1:4173',
    logger: { log: (message = '') => logs.push(String(message)) },
    projectRoot,
    requestFn,
  });

  assert.deepEqual(result, {
    handoffCount: 1,
    launchList: ['codex', 'claude'],
    staleCount: 1,
    succeeded: true,
  });

  assert.equal(
    calls.filter((call) => call.method === 'GET' && call.route === '/session/status').length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.method === 'POST' && call.route === '/session/resume').length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.method === 'POST' && call.route === '/task/update').length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.method === 'POST' && call.route === '/handoff/ack').length,
    1,
  );
  assert(logs.some((line) => line.includes('Session unpaused')));
  assert(logs.some((line) => line.includes('reset to todo')));
  assert(logs.some((line) => line.includes('acknowledged')));
  await clearLock(projectRoot);
});

test('recoverHydraDaemonState serializes concurrent recovery for one worktree', async () => {
  resetHydraStartupRecoveryForTests();
  const projectRoot = `/tmp/parallel-code-hydra-serialize-${process.pid}`;
  await clearLock(projectRoot);

  let resolveStatus = () => {};
  const statusPromise = new Promise((resolve) => {
    resolveStatus = resolve;
  });

  let sessionStatusCalls = 0;
  const requestFn = async (method, baseUrl, route) => {
    if (method === 'GET' && route === '/session/status') {
      sessionStatusCalls += 1;
      await statusPromise;
      return {
        activeSession: null,
        agentSuggestions: {},
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      };
    }

    return {};
  };

  const first = recoverHydraDaemonState({
    agents: [],
    baseUrl: 'http://127.0.0.1:4173',
    projectRoot,
    requestFn,
  });
  const second = recoverHydraDaemonState({
    agents: [],
    baseUrl: 'http://127.0.0.1:4173',
    projectRoot,
    requestFn,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStatusCalls, 1);
  resolveStatus();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.succeeded, true);
  assert.equal(sessionStatusCalls, 1);
  await clearLock(projectRoot);
});

test('recoverHydraDaemonState preserves caller-specific agent filtering during shared recovery', async () => {
  resetHydraStartupRecoveryForTests();
  const projectRoot = `/tmp/parallel-code-hydra-filter-${process.pid}`;
  await clearLock(projectRoot);

  let resolveStatus = () => {};
  const statusPromise = new Promise((resolve) => {
    resolveStatus = resolve;
  });

  const requestFn = async (method, baseUrl, route) => {
    if (method === 'GET' && route === '/session/status') {
      await statusPromise;
      return {
        activeSession: null,
        agentSuggestions: {
          codex: { action: 'dispatch' },
          gemini: { action: 'dispatch' },
        },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      };
    }

    return {};
  };

  const codexRecovery = recoverHydraDaemonState({
    agents: ['codex'],
    baseUrl: 'http://127.0.0.1:4173',
    projectRoot,
    requestFn,
  });
  const geminiRecovery = recoverHydraDaemonState({
    agents: ['gemini'],
    baseUrl: 'http://127.0.0.1:4173',
    projectRoot,
    requestFn,
  });

  resolveStatus();

  const [codexResult, geminiResult] = await Promise.all([codexRecovery, geminiRecovery]);
  assert.deepEqual(codexResult.launchList, ['codex']);
  assert.deepEqual(geminiResult.launchList, ['gemini']);
  await clearLock(projectRoot);
});

test('recoverHydraDaemonState waits for a fresh worktree lock before proceeding', async () => {
  resetHydraStartupRecoveryForTests();

  const projectRoot = `/tmp/parallel-code-hydra-lock-${process.pid}`;
  await clearLock(projectRoot);
  const lockPath = getLockPath(projectRoot);
  await fs.writeFile(lockPath, JSON.stringify({ pid: 123, projectRoot }));

  const calls = [];
  const releaseLock = setTimeout(async () => {
    await fs.unlink(lockPath).catch(() => {});
  }, 50);

  try {
    const result = await recoverHydraDaemonState({
      agents: [],
      baseUrl: 'http://127.0.0.1:4173',
      projectRoot,
      requestFn: async (method, baseUrl, route) => {
        calls.push({ method, baseUrl, route });
        return {
          activeSession: null,
          agentSuggestions: {},
          inProgressTasks: [],
          pendingHandoffs: [],
          staleTasks: [],
        };
      },
    });

    assert.deepEqual(result, {
      handoffCount: 0,
      launchList: [],
      staleCount: 0,
      succeeded: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.route, '/session/status');
  } finally {
    clearTimeout(releaseLock);
    await fs.unlink(lockPath).catch(() => {});
  }
});

test('recoverHydraDaemonState reports unsuccessful recovery when status fetch fails', async () => {
  resetHydraStartupRecoveryForTests();

  const result = await recoverHydraDaemonState({
    agents: ['codex'],
    baseUrl: 'http://127.0.0.1:4173',
    logger: { log: () => {} },
    projectRoot: `/tmp/parallel-code-hydra-failure-${process.pid}`,
    requestFn: async () => {
      throw new Error('daemon unavailable');
    },
  });

  assert.deepEqual(result, {
    handoffCount: 0,
    launchList: [],
    staleCount: 0,
    succeeded: false,
  });
});
