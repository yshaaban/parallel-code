import { describe, expect, it, vi } from 'vitest';
import {
  getCurrentTaskCatalogSessionRuntime,
  subscribeTaskCatalogPtyRuntime,
  type TaskCatalogPtyRuntimeDependencies,
} from './task-catalog-runtime-composition.js';

function createDependencies() {
  const listeners = new Map<string, (sessionId: string, data?: unknown) => void>();
  const dependencies: TaskCatalogPtyRuntimeDependencies = {
    getActiveAgentIds: () => ['agent-1', 'missing'],
    getAgentMeta: (sessionId) =>
      sessionId === 'agent-1'
        ? { agentId: sessionId, generation: 3, isShell: false, taskId: 'task-1' }
        : null,
    subscribe: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  return { dependencies, listeners };
}

describe('task catalog PTY runtime composition', () => {
  it('collects only bounded lifecycle identity from active PTYs', () => {
    const { dependencies } = createDependencies();
    expect(getCurrentTaskCatalogSessionRuntime(dependencies)).toEqual([
      { generation: 3, sessionId: 'agent-1', state: 'running' },
    ]);
  });

  it('maps lifecycle events to keyed runtime facts and releases every subscription', () => {
    const { dependencies, listeners } = createDependencies();
    const updateSessionRuntime = vi.fn();
    const cleanup = subscribeTaskCatalogPtyRuntime({ updateSessionRuntime }, dependencies);

    listeners.get('spawn')?.('agent-1', { generation: 4 });
    listeners.get('pause')?.('agent-1', { generation: 4 });
    listeners.get('resume')?.('agent-1', { generation: 4 });
    listeners.get('exit')?.('agent-1', { exitCode: 0, generation: 4 });
    listeners.get('exit')?.('agent-1', { exitCode: 2, generation: 5 });
    expect(updateSessionRuntime.mock.calls).toEqual([
      [{ generation: 4, sessionId: 'agent-1', state: 'running' }],
      [{ generation: 4, sessionId: 'agent-1', state: 'running' }],
      [{ generation: 4, sessionId: 'agent-1', state: 'running' }],
      [{ generation: 4, sessionId: 'agent-1', state: 'stopped' }],
      [{ generation: 5, sessionId: 'agent-1', state: 'failed' }],
    ]);

    cleanup();
    expect(listeners.size).toBe(0);
  });
});
