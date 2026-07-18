import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { isInteger, isTcpPortNumber } from '../../src/lib/type-guards.js';
import { isPathInsideOrEqual } from './path-utils.js';
import { compareTaskPortExposureCandidateOrder } from './task-port-candidate-order.js';

export interface TaskPortDiscoveryTarget {
  taskId: string;
  worktreePath: string;
}

export interface RediscoveredTaskPort {
  host: string | null;
  port: number;
  suggestion: string;
  taskId: string;
}

export interface TaskPortExposureCandidateScanResult {
  host: string | null;
  port: number;
  source: 'task' | 'local';
}

interface ListeningSocket {
  host: string | null;
  pid: number;
  port: number;
}

const COMMON_DEV_PORTS = new Set([
  3000, 3001, 3002, 3003, 4173, 4200, 4321, 5000, 5001, 5173, 5174, 5175, 6006, 7007, 8000, 8001,
  8080, 8081, 8088, 8787, 8888, 9000, 9090,
]);
export const PORT_DISCOVERY_LSOF_TIMEOUT_MS = 3_000;

interface LsofScanBudget {
  deadlineAtMs: number;
  exhausted: boolean;
}

function createLsofScanBudget(): LsofScanBudget {
  return {
    deadlineAtMs: Date.now() + PORT_DISCOVERY_LSOF_TIMEOUT_MS,
    exhausted: false,
  };
}

function getRemainingLsofBudgetMs(budget: LsofScanBudget): number {
  if (budget.exhausted) {
    return 0;
  }

  const remainingMs = Math.ceil(budget.deadlineAtMs - Date.now());
  if (remainingMs <= 0) {
    budget.exhausted = true;
    return 0;
  }
  return remainingMs;
}

function isLsofTimeoutError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    String((error as NodeJS.ErrnoException).code) === 'ETIMEDOUT'
  );
}

function runBoundedLsof(args: string[], budget: LsofScanBudget): string | null {
  const timeout = getRemainingLsofBudgetMs(budget);
  if (timeout === 0) {
    return null;
  }

  try {
    const output = execFileSync('lsof', args, {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    });
    getRemainingLsofBudgetMs(budget);
    return output;
  } catch (error) {
    if (isLsofTimeoutError(error) || getRemainingLsofBudgetMs(budget) === 0) {
      budget.exhausted = true;
    }
    throw error;
  }
}

function getTaskPathMatch(
  cwd: string,
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): TaskPortDiscoveryTarget | null {
  let bestMatch: TaskPortDiscoveryTarget | null = null;

  for (const task of tasks) {
    const normalizedWorktreePath = path.resolve(task.worktreePath);
    if (!isPathInsideOrEqual(normalizedWorktreePath, cwd)) {
      continue;
    }

    if (!bestMatch || normalizedWorktreePath.length > path.resolve(bestMatch.worktreePath).length) {
      bestMatch = task;
    }
  }

  return bestMatch;
}

function isLikelyLocalServerPort(port: number): boolean {
  return (
    COMMON_DEV_PORTS.has(port) ||
    (port >= 3_000 && port <= 3_999) ||
    (port >= 4_000 && port <= 4_299) ||
    (port >= 5_000 && port <= 5_299) ||
    (port >= 6_000 && port <= 6_099) ||
    (port >= 7_000 && port <= 7_099) ||
    (port >= 8_000 && port <= 8_999) ||
    (port >= 9_000 && port <= 9_099)
  );
}

function normalizeDiscoveredHost(host: string): string | null {
  if (host === '*' || host === '0.0.0.0' || host === '[::]' || host === '::') {
    return null;
  }

  if (host === '[::1]') {
    return '::1';
  }

  return host;
}

function parseListeningSocketName(value: string): ListeningSocket | null {
  const match = /^(.*):(\d{1,5})$/u.exec(value.trim());
  if (!match) {
    return null;
  }

  const port = Number.parseInt(match[2] ?? '', 10);
  if (!isTcpPortNumber(port)) {
    return null;
  }

  return {
    host: normalizeDiscoveredHost(match[1] ?? ''),
    pid: 0,
    port,
  };
}

function parseListeningSockets(raw: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  let currentPid: number | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = isInteger(pid) ? pid : null;
      continue;
    }

    if (!line.startsWith('n') || currentPid === null) {
      continue;
    }

    const parsedSocket = parseListeningSocketName(line.slice(1));
    if (!parsedSocket) {
      continue;
    }

    sockets.push({
      ...parsedSocket,
      pid: currentPid,
    });
  }

  return sockets;
}

function readProcessWorkingDirectory(pid: number, budget: LsofScanBudget): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return readProcessWorkingDirectoryWithLsof(pid, budget);
  }
}

function readProcessWorkingDirectoryWithLsof(pid: number, budget: LsofScanBudget): string | null {
  try {
    const output = runBoundedLsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], budget);
    if (output === null) {
      return null;
    }
    for (const line of output.split('\n')) {
      if (line.startsWith('n') && line.length > 1) {
        return line.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

const MAX_WORKING_DIRECTORY_LOOKUPS_PER_PID = 2;

function createProcessWorkingDirectoryReader(
  budget: LsofScanBudget,
): (pid: number) => string | null {
  const cache = new Map<number, { attempts: number; cwd: string | null }>();
  return (pid) => {
    const cached = cache.get(pid);
    if (cached?.cwd) {
      return cached.cwd;
    }
    if (cached && cached.attempts >= MAX_WORKING_DIRECTORY_LOOKUPS_PER_PID) {
      return null;
    }

    const cwd = readProcessWorkingDirectory(pid, budget);
    cache.set(pid, {
      attempts: (cached?.attempts ?? 0) + 1,
      cwd,
    });
    return cwd;
  };
}

function findTaskForListeningSocket(
  socket: ListeningSocket,
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
  readWorkingDirectory: (pid: number) => string | null,
): TaskPortDiscoveryTarget | null {
  const cwd = readWorkingDirectory(socket.pid);
  if (!cwd) {
    return null;
  }

  return getTaskPathMatch(cwd, tasks);
}

function getListeningSockets(budget: LsofScanBudget): ListeningSocket[] {
  try {
    const output = runBoundedLsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'], budget);
    if (output === null) {
      return [];
    }
    return parseListeningSockets(output);
  } catch {
    return [];
  }
}

function pushUniquePortCandidate(
  results: TaskPortExposureCandidateScanResult[],
  seenPorts: Set<number>,
  port: number,
  source: TaskPortExposureCandidateScanResult['source'],
  host: string | null,
): void {
  if (seenPorts.has(port)) {
    return;
  }

  seenPorts.add(port);
  results.push({
    host,
    port,
    source,
  });
}

export function scanTaskPortExposureCandidates(
  task: TaskPortDiscoveryTarget,
): TaskPortExposureCandidateScanResult[] {
  const results: TaskPortExposureCandidateScanResult[] = [];
  const seenPorts = new Set<number>();
  const lsofBudget = createLsofScanBudget();
  const listeningSockets = getListeningSockets(lsofBudget);
  const readWorkingDirectory = createProcessWorkingDirectoryReader(lsofBudget);

  for (const socket of listeningSockets) {
    if (!findTaskForListeningSocket(socket, [task], readWorkingDirectory)) {
      continue;
    }

    pushUniquePortCandidate(results, seenPorts, socket.port, 'task', socket.host);
  }

  for (const socket of listeningSockets) {
    if (!isLikelyLocalServerPort(socket.port)) {
      continue;
    }

    pushUniquePortCandidate(results, seenPorts, socket.port, 'local', socket.host);
  }

  return results.sort(compareTaskPortExposureCandidateOrder);
}

export function rediscoverTaskPorts(
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): RediscoveredTaskPort[] {
  if (tasks.length === 0) {
    return [];
  }

  const discoveredPorts: RediscoveredTaskPort[] = [];
  const seenPorts = new Set<string>();
  const lsofBudget = createLsofScanBudget();
  const readWorkingDirectory = createProcessWorkingDirectoryReader(lsofBudget);

  for (const socket of getListeningSockets(lsofBudget)) {
    const matchingTask = findTaskForListeningSocket(socket, tasks, readWorkingDirectory);
    if (!matchingTask) {
      continue;
    }

    const uniqueKey = `${matchingTask.taskId}:${socket.port}`;
    if (seenPorts.has(uniqueKey)) {
      continue;
    }

    seenPorts.add(uniqueKey);
    discoveredPorts.push({
      taskId: matchingTask.taskId,
      host: socket.host,
      port: socket.port,
      suggestion: `Rediscovered listening port ${socket.port}`,
    });
  }

  return discoveredPorts;
}
