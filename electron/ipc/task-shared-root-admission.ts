import fs from 'node:fs';
import path from 'node:path';

// Provisional backend admission protects a root while canonical creation is between preparation
// and commit. It is deliberately not a catalog entry, PTY capability, or command-lease identity.
const rootsByTaskId = new Map<string, string>();

function rootIdentity(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export function admitPreparedSharedRootTask(taskId: string, root: string): void {
  const identity = rootIdentity(root);
  const existing = rootsByTaskId.get(taskId);
  if (existing !== undefined && existing !== identity) {
    throw new Error('Prepared shared-root task identity changed');
  }
  rootsByTaskId.set(taskId, identity);
}

export function releasePreparedSharedRootTask(taskId: string): void {
  rootsByTaskId.delete(taskId);
}

export function hasPreparedSharedRootTask(root: string): boolean {
  const identity = rootIdentity(root);
  return [...rootsByTaskId.values()].some((candidate) => candidate === identity);
}

export function resetPreparedSharedRootTasksForTests(): void {
  rootsByTaskId.clear();
}
