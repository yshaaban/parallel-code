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

interface ListeningSocket {
  host: string | null;
  pid: number;
  port: number;
}

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

export function rediscoverTaskPorts(
  tasks: ReadonlyArray<TaskPortDiscoveryTarget>,
): RediscoveredTaskPort[] {
  if (tasks.length === 0) {
    return [];
  }

  const discoveredPorts: RediscoveredTaskPort[] = [];
  const seenPorts = new Set<string>();

  for (const socket of getListeningSockets()) {
    const cwd = readProcessWorkingDirectory(socket.pid);
    if (!cwd) {
      continue;
    }

    const matchingTask = getTaskPathMatch(cwd, tasks);
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
