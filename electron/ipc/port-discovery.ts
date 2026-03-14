import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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

function getTaskPathMatch(
  cwd: string,
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): TaskPortDiscoveryTarget | null {
  let bestMatch: TaskPortDiscoveryTarget | null = null;

  for (const task of tasks) {
    const normalizedWorktreePath = path.resolve(task.worktreePath);
    if (cwd !== normalizedWorktreePath && !cwd.startsWith(`${normalizedWorktreePath}${path.sep}`)) {
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
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
      currentPid = Number.isInteger(pid) ? pid : null;
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

function readProcessWorkingDirectory(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function findTaskForListeningSocket(
  socket: ListeningSocket,
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): TaskPortDiscoveryTarget | null {
  const cwd = readProcessWorkingDirectory(socket.pid);
  if (!cwd) {
    return null;
  }

  return getTaskPathMatch(cwd, tasks);
}

function getListeningSockets(): ListeningSocket[] {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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

function compareTaskPortExposureCandidates(
  left: TaskPortExposureCandidateScanResult,
  right: TaskPortExposureCandidateScanResult,
): number {
  const sourceRank = left.source === right.source ? 0 : left.source === 'task' ? -1 : 1;
  if (sourceRank !== 0) {
    return sourceRank;
  }

  return left.port - right.port;
}

export function scanTaskPortExposureCandidates(
  task: TaskPortDiscoveryTarget,
): TaskPortExposureCandidateScanResult[] {
  const results: TaskPortExposureCandidateScanResult[] = [];
  const seenPorts = new Set<number>();
  const listeningSockets = getListeningSockets();

  for (const socket of listeningSockets) {
    if (!findTaskForListeningSocket(socket, [task])) {
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

  return results.sort(compareTaskPortExposureCandidates);
}

export function rediscoverTaskPorts(
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): RediscoveredTaskPort[] {
  if (tasks.length === 0) {
    return [];
  }

  const discoveredPorts: RediscoveredTaskPort[] = [];
  const seenPorts = new Set<string>();

  for (const socket of getListeningSockets()) {
    const matchingTask = findTaskForListeningSocket(socket, tasks);
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
