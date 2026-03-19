import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pc from 'picocolors';

import { boolFlag, request } from './hydra-utils.mjs';
import { colorAgent, DIM, ERROR, SUCCESS, WARNING } from './hydra-ui.mjs';

const recoveryByProjectRoot = new Map();
const STARTUP_RECOVERY_LOCK_POLL_MS = 100;
const STARTUP_RECOVERY_LOCK_STALE_MS = 30_000;

function emitLine(logger, message = '') {
  if (typeof logger?.log === 'function') {
    logger.log(message);
    return;
  }

  console.log(message);
}

function normalizeAgentList(agents) {
  const normalizedAgents = Array.isArray(agents) ? agents : [];
  const agentNames = normalizedAgents
    .map((agent) => String(agent || '').toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(agentNames));
}

function createEmptyRecoveryResult(succeeded = false) {
  return {
    handoffCount: 0,
    launchList: [],
    staleCount: 0,
    succeeded,
  };
}

function filterRecoveryResultForAgents(result, allowedAgents) {
  return {
    ...result,
    launchList: result.launchList.filter((agent) => allowedAgents.has(agent)),
  };
}

function getHydraStartupRecoveryLockPath(projectRoot) {
  const normalizedRoot = String(projectRoot || '').trim();
  const projectHash = createHash('sha1').update(normalizedRoot).digest('hex');
  return path.join(os.tmpdir(), `parallel-code-hydra-startup-${projectHash}.lock`);
}

async function removeLockFileIfStale(lockPath) {
  try {
    const stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs <= STARTUP_RECOVERY_LOCK_STALE_MS) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function waitForHydraStartupRecoveryLock(projectRoot) {
  const normalizedRoot = String(projectRoot || '').trim();
  if (!normalizedRoot) {
    return null;
  }

  const lockPath = getHydraStartupRecoveryLockPath(normalizedRoot);

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({
          createdAt: new Date().toISOString(),
          pid: process.pid,
          projectRoot: normalizedRoot,
        }),
      );
      await handle.close();
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const removedStaleLock = await removeLockFileIfStale(lockPath);
      if (!removedStaleLock) {
        await new Promise((resolve) => setTimeout(resolve, STARTUP_RECOVERY_LOCK_POLL_MS));
      }
    }
  }
}

export function shouldResumeHydraOnStart(options = {}) {
  return boolFlag(
    options.resumeOnStart ?? options.resumeonstart ?? options['resume-on-start'],
    false,
  );
}

export function resetHydraStartupRecoveryForTests() {
  recoveryByProjectRoot.clear();
}

export async function recoverHydraDaemonState({
  agents = [],
  baseUrl,
  logger = console,
  projectRoot = '',
  requestFn = request,
} = {}) {
  const lockKey = String(projectRoot || '').trim();
  const allowedAgents = new Set(normalizeAgentList(agents));
  const existing = recoveryByProjectRoot.get(lockKey);
  if (existing) {
    const result = await existing;
    return filterRecoveryResultForAgents(result, allowedAgents);
  }

  const recovery = (async () => {
    const releaseLock = await waitForHydraStartupRecoveryLock(lockKey);
    try {
      const sessionStatus = await requestFn('GET', baseUrl, '/session/status');

      if (sessionStatus.activeSession?.status === 'paused') {
        try {
          await requestFn('POST', baseUrl, '/session/resume', {});
          emitLine(logger, `  ${SUCCESS('✓')} Session unpaused`);
        } catch (error) {
          emitLine(
            logger,
            `  ${WARNING('⚠')} Could not unpause: ${String(error?.message || error)}`,
          );
        }
      }

      const stale = sessionStatus.staleTasks || [];
      if (stale.length > 0) {
        emitLine(logger, '');
        for (const task of stale) {
          try {
            await requestFn('POST', baseUrl, '/task/update', { taskId: task.id, status: 'todo' });
            const mins = Math.round((Date.now() - new Date(task.updatedAt).getTime()) / 60_000);
            emitLine(
              logger,
              `  ${WARNING('↻')} ${pc.white(task.id)} ${colorAgent(task.owner)} reset to todo ${DIM(`(was stale ${mins}m)`)}`,
            );
          } catch {
            // Skip individual stale-task failures.
          }
        }
      }

      const handoffs = sessionStatus.pendingHandoffs || [];
      const agentsToLaunch = new Set();
      if (handoffs.length > 0) {
        emitLine(logger, '');
        for (const handoff of handoffs) {
          const targetAgent = String(handoff.to || '').toLowerCase();
          try {
            await requestFn('POST', baseUrl, '/handoff/ack', {
              agent: targetAgent,
              handoffId: handoff.id,
            });
            emitLine(
              logger,
              `  ${SUCCESS('✓')} ${pc.white(handoff.id)} ${colorAgent(handoff.from)}→${colorAgent(handoff.to)} acknowledged`,
            );
            if (targetAgent) {
              agentsToLaunch.add(targetAgent);
            }
          } catch (error) {
            emitLine(logger, `  ${ERROR('✗')} ${pc.white(handoff.id)} ${String(error?.message || error)}`);
          }
        }
      }

      for (const task of sessionStatus.inProgressTasks || []) {
        const owner = String(task.owner || '').toLowerCase();
        if (owner) {
          agentsToLaunch.add(owner);
        }
      }

      for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions || {})) {
        if (suggestion?.action && suggestion.action !== 'idle' && suggestion.action !== 'unknown') {
          agentsToLaunch.add(String(agent || '').toLowerCase());
        }
      }

      return {
        handoffCount: handoffs.length,
        launchList: [...agentsToLaunch],
        staleCount: stale.length,
        succeeded: true,
      };
    } catch (error) {
      emitLine(logger, `  ${ERROR(String(error?.message || error))}`);
      return createEmptyRecoveryResult();
    } finally {
      await releaseLock?.();
    }
  })();

  recoveryByProjectRoot.set(lockKey, recovery);

  try {
    const result = await recovery;
    return filterRecoveryResultForAgents(result, allowedAgents);
  } finally {
    if (recoveryByProjectRoot.get(lockKey) === recovery) {
      recoveryByProjectRoot.delete(lockKey);
    }
  }
}
