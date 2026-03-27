import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTerminalHighLoadModeEnabled } from '../app/terminal-high-load-mode';
import { setStore, store } from './core';
import {
  loadClientSessionState,
  reconcileClientSessionState,
  saveClientSessionState,
} from './client-session';
import { resetStoreForTest } from '../test/store-test-helpers';

const { isElectronRuntimeMock } = vi.hoisted(() => ({
  isElectronRuntimeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

function createSessionStorage(): Storage {
  const values = new Map<string, string>();

  return {
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    get length(): number {
      return values.size;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

describe('client session state', () => {
  const originalSessionStorage = globalThis.sessionStorage;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(false);
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: createSessionStorage(),
    });
  });

  it('saves and restores browser-local selection, layout, and focus state', () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('editorCommand', 'code');
    setStore('lastProjectId', 'project-1');
    setStore('lastAgentId', 'agent-1');
    setStore('focusedPanel', { 'task-1': 'shell:0' });
    setStore('fontScales', { 'task-1': 1.2 });
    setStore('globalScale', 1.1);
    setStore('inactiveColumnOpacity', 0.75);
    setStore('panelSizes', { 'left:right': 0.4 });
    setStore('placeholderFocused', true);
    setStore('placeholderFocusedButton', 'add-terminal');
    setStore('sidebarSectionCollapsed', {
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    });
    setStore('showPlans', false);
    setStore('terminalHighLoadMode', true);
    setStore('taskNotificationsEnabled', true);
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedProjectId', 'project-1');
    setStore('sidebarFocusedTaskId', 'task-1');
    setStore('sidebarVisible', false);
    setStore('themePreset', 'minimal');
    setStore('terminalFont', 'JetBrains Mono');
    setStore('windowState', {
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
      maximized: false,
    });

    saveClientSessionState();

    resetStoreForTest();
    setStore('projects', [
      {
        id: 'project-1',
        name: 'Project 1',
        path: '/tmp/project-1',
        color: '#4477aa',
      },
    ]);
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });

    expect(loadClientSessionState()).toBe(true);
    expect(store.activeTaskId).toBe('task-1');
    expect(store.activeAgentId).toBe('agent-1');
    expect(store.editorCommand).toBe('code');
    expect(store.lastProjectId).toBe('project-1');
    expect(store.lastAgentId).toBe('agent-1');
    expect(store.focusedPanel).toEqual({ 'task-1': 'shell:0' });
    expect(store.fontScales).toEqual({ 'task-1': 1.2 });
    expect(store.globalScale).toBe(1.1);
    expect(store.inactiveColumnOpacity).toBe(0.75);
    expect(store.panelSizes).toEqual({ 'left:right': 0.4 });
    expect(store.placeholderFocused).toBe(true);
    expect(store.placeholderFocusedButton).toBe('add-terminal');
    expect(store.sidebarSectionCollapsed).toEqual({
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    });
    expect(store.showPlans).toBe(false);
    expect(store.terminalHighLoadMode).toBe(true);
    expect(store.taskNotificationsEnabled).toBe(true);
    expect(store.sidebarFocused).toBe(true);
    expect(store.sidebarFocusedProjectId).toBe('project-1');
    expect(store.sidebarFocusedTaskId).toBe('task-1');
    expect(store.sidebarVisible).toBe(false);
    expect(store.windowState).toEqual({
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
      maximized: false,
    });
  });

  it('reconciles local selection when the saved task is no longer present', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'agent-stale',
        activeTaskId: 'task-stale',
      }),
    );
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });

    expect(loadClientSessionState()).toBe(true);
    expect(store.activeTaskId).toBe('task-1');
    expect(store.activeAgentId).toBe('agent-1');
  });

  it('restores the selected terminal agent when the browser session targets a terminal id', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'agent-stale',
        activeTaskId: 'terminal-1',
      }),
    );
    setStore('taskOrder', ['terminal-1']);
    setStore('terminals', {
      'terminal-1': {
        id: 'terminal-1',
        name: 'Shell',
        agentId: 'terminal-agent-1',
      },
    });

    expect(loadClientSessionState()).toBe(true);
    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.activeAgentId).toBe('terminal-agent-1');
  });

  it('clears stale sidebar focus and focused panels for removed entities during reconciliation', () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('projects', [
      {
        id: 'project-1',
        name: 'Project 1',
        path: '/tmp/project-1',
        color: '#4477aa',
      },
    ]);
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('sidebarFocusedProjectId', 'project-stale');
    setStore('sidebarFocusedTaskId', 'task-stale');
    setStore('focusedPanel', {
      'task-1': 'terminal',
      'task-stale': 'shell:0',
      'terminal-stale': 'terminal',
    });

    reconcileClientSessionState();

    expect(store.sidebarFocusedProjectId).toBeNull();
    expect(store.sidebarFocusedTaskId).toBeNull();
    expect(store.focusedPanel).toEqual({ 'task-1': 'terminal' });
  });

  it('defaults browser task notifications on for legacy session state without an initialized preference marker', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        taskNotificationsEnabled: false,
      }),
    );

    expect(loadClientSessionState()).toBe(true);
    expect(store.taskNotificationsEnabled).toBe(true);
    expect(store.taskNotificationsPreferenceInitialized).toBe(true);
  });

  it('restores the legacy desktop notification field when the preference marker is present', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        desktopNotificationsEnabled: false,
        taskNotificationsPreferenceInitialized: true,
      }),
    );

    expect(loadClientSessionState()).toBe(true);
    expect(store.taskNotificationsEnabled).toBe(false);
    expect(store.taskNotificationsPreferenceInitialized).toBe(true);
  });

  it('saves the reconciled local selection after runtime changes', () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');

    reconcileClientSessionState();

    const saved = sessionStorage.getItem('parallel-code-client-session');
    expect(saved).toBeTypeOf('string');
    expect(saved ? JSON.parse(saved) : null).toMatchObject({
      activeAgentId: 'agent-1',
      activeTaskId: 'task-1',
    });
  });

  it('preserves the current high load mode when the client session omits it', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeTaskId: null,
      }),
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
    window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ = true;
    resetStoreForTest();

    expect(loadClientSessionState()).toBe(true);
    expect(store.terminalHighLoadMode).toBe(true);
    expect(isTerminalHighLoadModeEnabled()).toBe(true);
  });

  it('skips browser-local persistence in electron runtime', () => {
    isElectronRuntimeMock.mockReturnValue(true);
    setStore('activeTaskId', 'task-1');

    saveClientSessionState();

    expect(sessionStorage.getItem('parallel-code-client-session')).toBeNull();
    expect(loadClientSessionState()).toBe(false);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Reflect.deleteProperty(globalThis, '__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__');
  });
});
