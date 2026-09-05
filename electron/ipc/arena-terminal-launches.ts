import { randomUUID } from 'crypto';
import path from 'path';

interface ArenaTerminalLaunchCapability {
  agentId: string;
  branchName: string;
  projectRoot: string;
  root: string;
  taskId: string;
}

export interface ConsumedArenaTerminalLaunch {
  readonly root: string;
}

const pendingLaunches = new Map<string, ArenaTerminalLaunchCapability>();

export function registerArenaTerminalLaunch(options: ArenaTerminalLaunchCapability): string {
  const token = randomUUID();
  pendingLaunches.set(token, {
    ...options,
    projectRoot: path.resolve(options.projectRoot),
    root: path.resolve(options.root),
  });
  return token;
}

export function consumeArenaTerminalLaunch(options: {
  agentId: string;
  cwd: string;
  taskId: string;
  token: string;
}): ConsumedArenaTerminalLaunch | null {
  const capability = pendingLaunches.get(options.token);
  if (
    !capability ||
    capability.agentId !== options.agentId ||
    capability.taskId !== options.taskId ||
    capability.root !== path.resolve(options.cwd)
  ) {
    return null;
  }

  pendingLaunches.delete(options.token);
  return Object.freeze({ root: capability.root });
}

export function revokeArenaTerminalLaunches(projectRoot: string, branchName: string): void {
  const canonicalProjectRoot = path.resolve(projectRoot);
  for (const [token, capability] of pendingLaunches) {
    if (capability.projectRoot === canonicalProjectRoot && capability.branchName === branchName) {
      pendingLaunches.delete(token);
    }
  }
}

export function resetArenaTerminalLaunchesForTest(): void {
  pendingLaunches.clear();
}
