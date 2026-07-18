import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import type { StorageEnv } from '../ipc/storage.js';

export function createStorageEnv(tmpdirPrefix: string): StorageEnv {
  return {
    isPackaged: false,
    coordinatorToolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), tmpdirPrefix)),
  } as StorageEnv & { coordinatorToolCallUrl: string };
}

export function removeStorageEnv(env: StorageEnv): void {
  fs.rmSync(env.userDataPath, { force: true, recursive: true });
  fs.rmSync(`${env.userDataPath}-dev`, { force: true, recursive: true });
}

export function createContext(env: StorageEnv): HandlerContext {
  return {
    ...env,
    emitIpcEvent: vi.fn(),
    sendToChannel: vi.fn(),
  };
}

export function createSupervisionSnapshot(
  state: AgentSupervisionSnapshot['state'],
  overrides: Partial<Pick<AgentSupervisionSnapshot, 'agentId' | 'taskId'>> = {},
): AgentSupervisionSnapshot {
  const agentId = overrides.agentId ?? 'agent-child';
  const taskId = overrides.taskId ?? 'task-child';
  return {
    agentId,
    attentionReason: state === 'idle-at-prompt' ? 'ready-for-next-step' : null,
    isShell: false,
    lastOutputAt: 1_000,
    preview: '',
    state,
    taskId,
    updatedAt: 1_000,
  };
}
