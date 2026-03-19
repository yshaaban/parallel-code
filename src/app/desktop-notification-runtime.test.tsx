import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from '../store/core';
import { getTaskDotStatus } from '../store/taskStatus';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import { startDesktopNotificationRuntime } from './desktop-notification-runtime';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const { invokeMock, listenNotificationClickedMock, notificationClickedRef } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenNotificationClickedMock: vi.fn(),
  notificationClickedRef: {
    current: null as null | ((payload: { taskIds: string[] }) => void),
  },
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../lib/ipc-events', () => ({
  listenNotificationClicked: listenNotificationClickedMock,
}));

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

describe('desktop-notification-runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    notificationClickedRef.current = null;
    invokeMock.mockResolvedValue(undefined);
    listenNotificationClickedMock.mockImplementation((listener) => {
      notificationClickedRef.current = listener;
      return () => {
        notificationClickedRef.current = null;
      };
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('skips notifications during the initial status snapshot', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setTaskReady('task-1', 'agent-1');
    setStore('desktopNotificationsEnabled', true);

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(invokeMock).not.toHaveBeenCalled();
    dispose();
  });

  it('batches ready tasks while the window is unfocused', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setupTask('task-2', 'agent-2', 'Second task');
    setStore('desktopNotificationsEnabled', true);

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    setTaskReady('task-2', 'agent-2');

    await flushMicrotasks();
    expect(getTaskDotStatus('task-1')).toBe('ready');
    expect(getTaskDotStatus('task-2')).toBe('ready');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(invokeMock).toHaveBeenCalledWith(IPC.ShowNotification, {
      body: '2 tasks ready for review',
      taskIds: ['task-1', 'task-2'],
      title: 'Task Ready',
    });

    dispose();
  });

  it('only notifies waiting transitions when a task moves from busy to waiting', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setStore('desktopNotificationsEnabled', true);

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    await flushMicrotasks();
    setTaskWaiting('task-1', 'agent-1');

    await flushMicrotasks();
    expect(getTaskDotStatus('task-1')).toBe('waiting');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(invokeMock).toHaveBeenCalledWith(IPC.ShowNotification, {
      body: 'First task needs your attention',
      taskIds: ['task-1'],
      title: 'Task Waiting',
    });

    dispose();
  });

  it('clears pending notifications when the window regains focus', async () => {
    const [windowFocused, setWindowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setStore('desktopNotificationsEnabled', true);

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    setWindowFocused(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(invokeMock).not.toHaveBeenCalled();

    dispose();
  });

  it('activates the first task from a notification click', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setupTask('task-2', 'agent-2', 'Second task');

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    notificationClickedRef.current?.({ taskIds: ['task-2', 'task-1'] });

    expect(store.activeTaskId).toBe('task-2');

    dispose();
  });

  it('suppresses notifications when the setting is disabled', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: true,
      isWindowFocused: windowFocused,
    });

    await flushMicrotasks();
    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(invokeMock).not.toHaveBeenCalled();

    dispose();
  });

  it('is a no-op outside Electron runtime', async () => {
    const [windowFocused] = createSignal(false);
    setupTask('task-1', 'agent-1', 'First task');
    setStore('desktopNotificationsEnabled', true);

    const dispose = startDesktopNotificationRuntime({
      electronRuntime: false,
      isWindowFocused: windowFocused,
    });

    setTaskReady('task-1', 'agent-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(listenNotificationClickedMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    dispose();
  });
});
