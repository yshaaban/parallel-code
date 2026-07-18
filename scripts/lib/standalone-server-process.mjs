import { execFileSync, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

import { runIndependentCleanups } from './cleanup-outcome.mjs';

const DEFAULT_READY_OUTPUT_BUFFER_MAX_CHARS = 8_192;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_KILL_SETTLE_MS = 1_000;
const POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS = 500;
const POSIX_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES = 4 * 1_024 * 1_024;
const POSIX_TREE_POLL_INTERVAL_MS = 100;
const READY_LINE_PATTERN =
  /(?:^|\r?\n)Parallel Code server listening on (https?:\/\/[^\s\r\n]+)\r?\n/u;
const ownedStandaloneServerProcesses = new WeakSet();
const ownedPosixProcessTrees = new WeakMap();

export function spawnStandaloneServerProcess(command, args = [], options = {}) {
  const serverProcess = spawn(command, args, {
    ...options,
    // A dedicated POSIX process group anchors teardown; stop-time snapshots retain helpers that
    // escape into another group or session. Windows escalation uses taskkill's tree mode below.
    detached: process.platform === 'win32' ? options.detached : true,
  });
  ownedStandaloneServerProcesses.add(serverProcess);
  if (
    process.platform !== 'win32' &&
    Number.isInteger(serverProcess.pid) &&
    serverProcess.pid > 0
  ) {
    ownedPosixProcessTrees.set(serverProcess, {
      anchoredProcessGroups: new Set([serverProcess.pid]),
      initialized: false,
      processes: new Map(),
      rootPid: serverProcess.pid,
    });
  }
  return serverProcess;
}

function appendBoundedOutput(previous, chunk, maxChars) {
  const next = `${previous}${chunk}`;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

export function parseStandaloneServerReadyOutput(output) {
  const match = READY_LINE_PATTERN.exec(output);
  if (!match) {
    return null;
  }

  const url = new URL(match[1]);
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port <= 0) {
    throw new Error(`Failed to parse standalone browser server port from ${match[1]}`);
  }

  return {
    baseUrl: `${url.protocol}//${url.host}`,
    port,
    url: match[1],
  };
}

export function waitForStandaloneServerReady(serverProcess, options = {}) {
  const outputBufferMaxChars =
    options.outputBufferMaxChars ?? DEFAULT_READY_OUTPUT_BUFFER_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let capturedStartupOwnership = false;
    let stderrText = '';
    let stdoutText = '';

    const finish = (error, ready) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeout);
      serverProcess.stdout.off('data', handleStdout);
      serverProcess.stderr.off('data', handleStderr);
      serverProcess.off('error', handleError);
      serverProcess.off('exit', handleExit);
      if (error) {
        reject(error);
      } else {
        resolve(ready);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Standalone server did not report readiness within ${timeoutMs}ms`));
    }, timeoutMs);

    function handleStdout(chunk) {
      stdoutText = appendBoundedOutput(stdoutText, chunk.toString('utf8'), outputBufferMaxChars);
      try {
        const ready = parseStandaloneServerReadyOutput(stdoutText);
        const ownedPosixProcessTree = getOwnedPosixProcessTree(serverProcess);
        // Capture once on the first observable startup output, then once more at readiness. If the
        // root exits before cleanup, these verified identities are the only safe way to retain a
        // descendant that escaped into its own process group or session.
        if (ownedPosixProcessTree && (!capturedStartupOwnership || ready !== null)) {
          refreshOwnedPosixProcessTree(serverProcess, ownedPosixProcessTree);
          capturedStartupOwnership = true;
        }
        if (ready) {
          finish(null, ready);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }

    function handleStderr(chunk) {
      const text = chunk.toString('utf8');
      stderrText = appendBoundedOutput(stderrText, text, outputBufferMaxChars);
      options.onStderr?.(text);
    }

    function handleError(error) {
      finish(error);
    }

    function handleExit(code, signal) {
      const exitReason = code ?? signal ?? 'null';
      const stderrSummary = stderrText.trim();
      const baseMessage = `Standalone server exited before readiness with code ${exitReason}`;
      finish(new Error(stderrSummary ? `${baseMessage}: ${stderrSummary}` : baseMessage));
    }

    serverProcess.stdout.on('data', handleStdout);
    serverProcess.stderr.on('data', handleStderr);
    serverProcess.on('error', handleError);
    serverProcess.on('exit', handleExit);

    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      handleExit(serverProcess.exitCode, serverProcess.signalCode);
    }
  });
}

function getOwnedPosixProcessTree(serverProcess) {
  if (process.platform === 'win32') {
    return null;
  }
  return ownedPosixProcessTrees.get(serverProcess) ?? null;
}

function readPosixProcessSnapshot() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8',
    maxBuffer: POSIX_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
  });
  const snapshot = new Map();

  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) {
      throw new Error(`Could not parse POSIX process snapshot line: ${line}`);
    }

    const processRecord = {
      pgid: Number(match[3]),
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startTime: match[5],
      status: match[4],
    };
    if (
      !Number.isInteger(processRecord.pid) ||
      processRecord.pid <= 0 ||
      !Number.isInteger(processRecord.ppid) ||
      processRecord.ppid < 0 ||
      !Number.isInteger(processRecord.pgid) ||
      processRecord.pgid <= 0 ||
      processRecord.startTime.length === 0 ||
      snapshot.has(processRecord.pid)
    ) {
      throw new Error(`Invalid POSIX process snapshot line: ${line}`);
    }
    snapshot.set(processRecord.pid, processRecord);
  }

  if (!snapshot.has(process.pid)) {
    throw new Error('POSIX process snapshot did not include the current process');
  }

  return snapshot;
}

function hasSamePosixProcessIdentity(previous, current) {
  return previous.pid === current.pid && previous.startTime === current.startTime;
}

function isAlivePosixProcess(processRecord) {
  return !processRecord.status.startsWith('Z');
}

function refreshOwnedPosixProcessTree(serverProcess, state) {
  const snapshot = readPosixProcessSnapshot();
  const rootHasNotExited = serverProcess.exitCode === null && serverProcess.signalCode === null;
  // An unverified root group is safe only while the ChildProcess still reports the root alive.
  // After the first verified snapshot, each retained group remains anchored by at least one
  // identity captured from an earlier snapshot.
  const anchoredProcessGroups =
    state.initialized || rootHasNotExited ? new Set(state.anchoredProcessGroups) : new Set();

  for (const [pid, retainedProcess] of state.processes) {
    const currentProcess = snapshot.get(pid);
    if (
      !currentProcess ||
      !hasSamePosixProcessIdentity(retainedProcess, currentProcess) ||
      !isAlivePosixProcess(currentProcess)
    ) {
      state.processes.delete(pid);
      continue;
    }
    state.processes.set(pid, currentProcess);
  }

  if (!state.initialized) {
    const rootProcess = snapshot.get(state.rootPid);
    if (rootProcess && rootHasNotExited && isAlivePosixProcess(rootProcess)) {
      state.processes.set(rootProcess.pid, rootProcess);
      anchoredProcessGroups.add(rootProcess.pgid);
    }
    state.initialized = true;
  }

  let discoveredProcess = true;
  while (discoveredProcess) {
    discoveredProcess = false;
    const ownedPids = new Set(state.processes.keys());
    for (const ownedProcess of state.processes.values()) {
      anchoredProcessGroups.add(ownedProcess.pgid);
    }

    for (const processRecord of snapshot.values()) {
      if (
        !isAlivePosixProcess(processRecord) ||
        state.processes.has(processRecord.pid) ||
        (!ownedPids.has(processRecord.ppid) && !anchoredProcessGroups.has(processRecord.pgid))
      ) {
        continue;
      }
      state.processes.set(processRecord.pid, processRecord);
      anchoredProcessGroups.add(processRecord.pgid);
      discoveredProcess = true;
    }
  }

  // Do not retain an empty numeric group anchor after all verified members disappear; a later PID
  // or process-group reuse must never turn an unrelated process into an owned descendant.
  state.anchoredProcessGroups = new Set(
    Array.from(state.processes.values(), (ownedProcess) => ownedProcess.pgid),
  );

  return snapshot;
}

function getAliveOwnedPosixProcesses(state, snapshot) {
  const aliveProcesses = [];
  for (const retainedProcess of state.processes.values()) {
    const currentProcess = snapshot.get(retainedProcess.pid);
    if (
      currentProcess &&
      hasSamePosixProcessIdentity(retainedProcess, currentProcess) &&
      isAlivePosixProcess(currentProcess)
    ) {
      aliveProcesses.push(currentProcess);
    }
  }
  return aliveProcesses;
}

function signalOwnedPosixProcessTree(state, snapshot, signal) {
  const aliveProcesses = getAliveOwnedPosixProcesses(state, snapshot);
  const currentProcessRecord = snapshot.get(process.pid);
  if (!currentProcessRecord) {
    throw new Error('Could not identify the current POSIX process group safely');
  }
  const currentProcessGroup = currentProcessRecord.pgid;
  const safeProcessGroups = new Set(
    aliveProcesses
      .map((ownedProcess) => ownedProcess.pgid)
      .filter(
        (processGroup) =>
          Number.isInteger(processGroup) &&
          processGroup > 0 &&
          processGroup !== currentProcessGroup,
      ),
  );

  for (const processGroup of safeProcessGroups) {
    try {
      process.kill(-processGroup, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  for (const ownedProcess of aliveProcesses) {
    if (safeProcessGroups.has(ownedProcess.pgid) || ownedProcess.pid === process.pid) {
      continue;
    }
    try {
      process.kill(ownedProcess.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }
}

function hasOwnedWindowsProcessTree(serverProcess) {
  return (
    process.platform === 'win32' &&
    ownedStandaloneServerProcesses.has(serverProcess) &&
    Number.isInteger(serverProcess.pid) &&
    serverProcess.pid > 0
  );
}

function getWindowsTaskkillPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'taskkill.exe');
}

function runWindowsTreeKill(serverProcess, { force, timeoutMs, forceCloseGraceMs }) {
  return new Promise((resolve) => {
    const args = ['/pid', String(serverProcess.pid), '/t'];
    if (force) {
      args.push('/f');
    }

    let taskkill;
    try {
      taskkill = spawn(getWindowsTaskkillPath(), args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let closeTimer;
    let operationTimer;
    let settled = false;

    const finish = (succeeded) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(operationTimer);
      globalThis.clearTimeout(closeTimer);
      taskkill.off('error', handleError);
      taskkill.off('close', handleClose);
      resolve(succeeded);
    };

    function handleError() {
      finish(false);
    }

    function handleClose(code) {
      finish(code === 0);
    }

    taskkill.on('error', handleError);
    taskkill.once('close', handleClose);
    operationTimer = setTimeout(() => {
      operationTimer = undefined;
      try {
        taskkill.kill('SIGKILL');
      } catch {
        // The helper can exit between its deadline and signal delivery.
      }
      if (!settled) {
        closeTimer = setTimeout(() => finish(false), forceCloseGraceMs);
      }
    }, timeoutMs);
  });
}

async function stopOwnedWindowsProcessTree(serverProcess, options) {
  const gracefulTreeKillSucceeded = await runWindowsTreeKill(serverProcess, {
    force: false,
    forceCloseGraceMs: options.forceKillSettleMs,
    timeoutMs: options.forceKillAfterMs,
  });
  if (gracefulTreeKillSucceeded) {
    return;
  }

  const forcedTreeKillSucceeded = await runWindowsTreeKill(serverProcess, {
    force: true,
    forceCloseGraceMs: options.forceKillSettleMs,
    timeoutMs: options.forceKillSettleMs,
  });
  if (forcedTreeKillSucceeded) {
    return;
  }

  try {
    serverProcess.kill('SIGKILL');
  } catch {
    // The direct process can exit while the final fallback is delivered.
  }
  throw new Error(`Standalone server process tree ${serverProcess.pid} did not exit`);
}

function formatUnknownError(error) {
  return error instanceof Error ? error.message : String(error);
}

function stopOwnedPosixProcessTree(serverProcess, state, options) {
  return new Promise((resolve, reject) => {
    let lastInspectionError = null;
    let pollTimer;
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(forceKillTimer);
      globalThis.clearTimeout(pollTimer);
      globalThis.clearTimeout(settleTimer);
      serverProcess.off('error', handleError);
      serverProcess.off('exit', handleExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const inspectTree = () => {
      try {
        const snapshot = refreshOwnedPosixProcessTree(serverProcess, state);
        lastInspectionError = null;
        return {
          aliveProcesses: getAliveOwnedPosixProcesses(state, snapshot),
          snapshot,
        };
      } catch (error) {
        lastInspectionError = error;
        return null;
      }
    };

    const inspectAndFinishIfExited = () => {
      const inspection = inspectTree();
      if (inspection && inspection.aliveProcesses.length === 0) {
        finish();
        return true;
      }
      return false;
    };

    const schedulePoll = () => {
      if (settled || pollTimer !== undefined) {
        return;
      }
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        if (!inspectAndFinishIfExited()) {
          schedulePoll();
        }
      }, POSIX_TREE_POLL_INTERVAL_MS);
    };

    const handleError = () => {
      if (!inspectAndFinishIfExited()) {
        schedulePoll();
      }
    };

    const handleExit = () => {
      if (!inspectAndFinishIfExited()) {
        schedulePoll();
      }
    };

    const forceKillTimer = setTimeout(() => {
      const inspection = inspectTree();
      if (!inspection || inspection.aliveProcesses.length === 0) {
        if (inspection) {
          finish();
        }
        return;
      }
      try {
        signalOwnedPosixProcessTree(state, inspection.snapshot, 'SIGKILL');
      } catch {
        // The final identity-checked snapshot below is authoritative.
      }
    }, options.forceKillAfterMs);
    const settleTimer = setTimeout(() => {
      const inspection = inspectTree();
      if (!inspection) {
        finish(
          new Error(
            `Could not confirm standalone server process tree ${state.rootPid} exited: ${formatUnknownError(lastInspectionError)}`,
          ),
        );
        return;
      }
      if (inspection.aliveProcesses.length > 0) {
        const alivePids = inspection.aliveProcesses
          .map((ownedProcess) => ownedProcess.pid)
          .sort((left, right) => left - right)
          .join(', ');
        finish(
          new Error(
            `Standalone server process tree ${state.rootPid} did not exit; still alive: ${alivePids}`,
          ),
        );
        return;
      }
      finish();
    }, options.forceKillAfterMs + options.forceKillSettleMs);

    serverProcess.once('error', handleError);
    serverProcess.once('exit', handleExit);

    const initialInspection = inspectTree();
    if (!initialInspection) {
      finish(
        new Error(
          `Could not inspect standalone server process tree ${state.rootPid} before termination: ${formatUnknownError(lastInspectionError)}`,
        ),
      );
      return;
    }
    if (initialInspection.aliveProcesses.length === 0) {
      finish();
      return;
    }

    try {
      signalOwnedPosixProcessTree(state, initialInspection.snapshot, 'SIGTERM');
    } catch {
      // Escalation and the final snapshot still provide bounded cleanup and verification.
    }
    schedulePoll();
  });
}

function stopDirectStandaloneServerProcess(serverProcess, options) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(forceKillTimer);
      globalThis.clearTimeout(settleTimer);
      serverProcess.off('error', handleError);
      serverProcess.off('exit', handleExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const handleError = () => {
      finish();
    };

    const handleExit = () => {
      finish();
    };

    const forceKillTimer = setTimeout(() => {
      if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
        try {
          if (!serverProcess.kill('SIGKILL')) {
            finish();
          }
        } catch {
          finish();
        }
      }
    }, options.forceKillAfterMs);
    const settleTimer = setTimeout(
      () => finish(),
      options.forceKillAfterMs + options.forceKillSettleMs,
    );

    serverProcess.once('error', handleError);
    serverProcess.once('exit', handleExit);
    try {
      if (!serverProcess.kill('SIGTERM')) {
        finish();
      }
    } catch {
      finish();
    }
  });
}

export function stopStandaloneServerProcess(serverProcess, options = {}) {
  const normalizedOptions = {
    forceKillAfterMs: options.forceKillAfterMs ?? DEFAULT_STOP_TIMEOUT_MS,
    forceKillSettleMs: options.forceKillSettleMs ?? DEFAULT_FORCE_KILL_SETTLE_MS,
  };

  if (hasOwnedWindowsProcessTree(serverProcess)) {
    return stopOwnedWindowsProcessTree(serverProcess, normalizedOptions);
  }

  const ownedPosixProcessTree = getOwnedPosixProcessTree(serverProcess);
  if (ownedPosixProcessTree) {
    return stopOwnedPosixProcessTree(serverProcess, ownedPosixProcessTree, normalizedOptions);
  }

  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return Promise.resolve();
  }

  return stopDirectStandaloneServerProcess(serverProcess, normalizedOptions);
}

export async function stopStandaloneServerProcessWithRetry(serverProcess, options = {}) {
  const failures = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await stopStandaloneServerProcess(serverProcess, options);
      return;
    } catch (error) {
      failures.push(error);
    }
  }

  throw new AggregateError(
    failures,
    `Standalone server process ${serverProcess.pid ?? 'unknown'} did not stop after 2 attempts`,
  );
}

export function getDevelopmentStateDir(userDataPath) {
  const resolvedUserDataPath = path.resolve(userDataPath);
  return path.join(
    path.dirname(resolvedUserDataPath),
    `${path.basename(resolvedUserDataPath)}-dev`,
  );
}

export function cleanupDevelopmentServerData(userDataPath, dependencies = {}) {
  const remove = dependencies.remove ?? rm;
  return runIndependentCleanups('Development server data', [
    [
      'remove server user data',
      () => remove(path.resolve(userDataPath), { force: true, recursive: true }),
    ],
    [
      'remove server development state',
      () => remove(getDevelopmentStateDir(userDataPath), { force: true, recursive: true }),
    ],
  ]);
}
