import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskNotificationCapability,
  TaskNotificationRequest,
} from '../domain/task-notification';
import { setStore, store } from '../store/core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import type { TaskNotificationSink } from './task-notification-sinks';
import { startTaskNotificationRuntime } from './task-notification-runtime';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setTaskBusy(taskId: string, agentId: string): void {
  setStore('agents', agentId, createTestAgent({ id: agentId, status: 'running', taskId }));
  setStore('agentSupervision', {});
}

function setTaskReady(taskId: string, agentId: string): void {
  setStore('agentSupervision', agentId, {
    agentId,
    attentionReason: 'ready-for-next-step',
    isShell: false,
    lastOutputAt: 1_000,
    preview: 'Ready',
    state: 'idle-at-prompt',
    taskId,
    updatedAt: 2_000,
  });
}

function setTaskWaiting(taskId: string, agentId: string): void {
  setStore('agentSupervision', agentId, {
    agentId,
    attentionReason: 'waiting-input',
    isShell: false,
    lastOutputAt: 1_000,
    preview: 'Proceed? [Y/n]',
    state: 'awaiting-input',
    taskId,
    updatedAt: 2_000,
  });
}

function setupTask(taskId: string, agentId: string, name = taskId): void {
  setStore('taskOrder', [...store.taskOrder, taskId]);
  setStore('tasks', taskId, createTestTask({ id: taskId, name, agentIds: [agentId] }));
  setTaskBusy(taskId, agentId);
}

function createCapability(
  overrides: Partial<TaskNotificationCapability> = {},
): TaskNotificationCapability {
  return {
    checking: false,
    permission: 'granted',
    provider: 'electron',
    supported: true,
    ...overrides,
  };
}

function createSinkMock(): {
  emitClick: (taskIds: string[]) => void;
  sink: TaskNotificationSink;
  showMock: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(taskIds: string[]) => void>();
  const showMock = vi.fn(async (_request: TaskNotificationRequest) => undefined);

  return {
    emitClick(taskIds) {
      for (const listener of listeners) {
        listener(taskIds);
      }
    },
    sink: {
      show: showMock,
      subscribeClicks(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    showMock,
  };
}

function setDocumentVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('task-notification-runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    setDocumentVisibility('visible');
    localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    setDocumentVisibility('visible');
    localStorage.clear();
  });

  it('skips notifications from the initial snapshot and only arms after startup completes', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed, setNotificationsArmed] = createSignal(false);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setTaskReady('task-1', 'agent-1');
    setStore('taskNotificationsEnabled', true);

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setNotificationsArmed(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('batches ready tasks while the Electron window is unfocused', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setupTask('task-2', 'agent-2', 'Second task');
    setStore('taskNotificationsEnabled', true);

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    setTaskReady('task-2', 'agent-2');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).toHaveBeenCalledWith({
      body: '2 tasks ready for review',
      taskIds: ['task-1', 'task-2'],
      title: 'Task Ready',
    });
    dispose();
  });

  it('only notifies waiting transitions when a task moves from busy to waiting', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskWaiting('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).toHaveBeenCalledWith({
      body: 'First task needs your attention',
      taskIds: ['task-1'],
      title: 'Task Waiting',
    });
    dispose();
  });

  it('clears pending notifications when the current client regains focus', async () => {
    const [isWindowFocused, setWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    setWindowFocused(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('activates the first matching task when a notification is clicked', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setupTask('task-2', 'agent-2', 'Second task');

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    sink.emitClick(['task-2', 'task-1']);

    expect(store.activeTaskId).toBe('task-2');
    dispose();
  });

  it('suppresses notifications when the shared setting is disabled', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('suppresses notifications when browser permission is not granted', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);
    setDocumentVisibility('hidden');

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability({ permission: 'default', provider: 'web' }),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('suppresses browser notifications while the tab is still visible', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);
    setDocumentVisibility('visible');

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability({ provider: 'web' }),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('suppresses browser notifications when another tab already claimed the same burst', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);
    setDocumentVisibility('hidden');
    localStorage.setItem(
      'parallel-code-task-notification-claims',
      JSON.stringify({
        'ready:task-1': {
          expiresAt: Date.now() + 10_000,
          ownerId: 'other-tab',
        },
      }),
    );

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability({ provider: 'web' }),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });

  it('suppresses notifications when another visible peer is already on the task', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setStore('taskNotificationsEnabled', true);
    setStore('peerSessions', {
      'peer-1': {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Peer',
        focusedSurface: 'ai-terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    });

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).not.toHaveBeenCalled();
    dispose();
  });
});
