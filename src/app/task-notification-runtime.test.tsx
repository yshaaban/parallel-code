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
      body: 'First task and Second task are ready for review',
      taskIds: ['task-1', 'task-2'],
      title: 'Tasks Ready',
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
      body: 'Proceed? [Y/n]',
      taskIds: ['task-1'],
      title: 'First task is waiting for input',
    });
    dispose();
  });

  it('uses specific single-task ready copy instead of a generic review message', async () => {
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
    setStore('agentSupervision', 'agent-1', {
      agentId: 'agent-1',
      attentionReason: 'ready-for-next-step',
      isShell: false,
      lastOutputAt: 1_000,
      preview: 'Describe the next step to run',
      state: 'idle-at-prompt',
      taskId: 'task-1',
      updatedAt: 2_000,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).toHaveBeenCalledWith({
      body: 'Describe the next step to run',
      taskIds: ['task-1'],
      title: 'First task is ready',
    });
    dispose();
  });

  it('falls back to panel-aware waiting copy when there is no useful preview', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setStore('taskOrder', ['task-1']);
    setStore(
      'tasks',
      'task-1',
      createTestTask({
        agentIds: [],
        id: 'task-1',
        name: 'Shell task',
        shellAgentIds: ['shell-1'],
      }),
    );
    setStore('taskNotificationsEnabled', true);
    setStore('agentSupervision', 'shell-1', {
      agentId: 'shell-1',
      attentionReason: 'waiting-input',
      isShell: true,
      lastOutputAt: 1_000,
      preview: 'Waiting',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 2_000,
    });

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setStore('agentSupervision', 'shell-1', {
      agentId: 'shell-1',
      attentionReason: null,
      isShell: true,
      lastOutputAt: 1_000,
      preview: '',
      state: 'active',
      taskId: 'task-1',
      updatedAt: 1_500,
    });
    await flushMicrotasks();
    setStore('agentSupervision', 'shell-1', {
      agentId: 'shell-1',
      attentionReason: 'waiting-input',
      isShell: true,
      lastOutputAt: 1_000,
      preview: 'Waiting',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 2_000,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).toHaveBeenCalledWith({
      body: 'Shell is waiting for your response',
      taskIds: ['task-1'],
      title: 'Shell task is waiting for input',
    });
    dispose();
  });

  it('summarizes larger waiting batches with concrete task names', async () => {
    const [isWindowFocused] = createSignal(false);
    const [isNotificationsArmed] = createSignal(true);
    const sink = createSinkMock();

    setupTask('task-1', 'agent-1', 'First task');
    setupTask('task-2', 'agent-2', 'Second task');
    setupTask('task-3', 'agent-3', 'Third task');
    setStore('taskNotificationsEnabled', true);

    const dispose = startTaskNotificationRuntime({
      capability: () => createCapability(),
      isNotificationsArmed,
      isWindowFocused,
      sink: sink.sink,
    });

    await flushMicrotasks();
    setTaskWaiting('task-1', 'agent-1');
    setTaskWaiting('task-2', 'agent-2');
    setTaskWaiting('task-3', 'agent-3');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sink.showMock).toHaveBeenCalledWith({
      body: 'First task, Second task, and 1 more are waiting for input',
      taskIds: ['task-1', 'task-2', 'task-3'],
      title: 'Tasks Waiting for Input',
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
    setStore('taskNotificationsEnabled', false);

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
