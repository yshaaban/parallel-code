import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    setStore('showPlans', false);
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
    expect(store.showPlans).toBe(false);
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
  });
});
