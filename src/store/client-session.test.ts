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
    setStore('terminalFontSize', 16);
    setStore('themePreset', 'minimal');
    setStore('terminalFont', 'JetBrains Mono');
    setStore('fontSmoothing', false);
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
    expect(store.terminalFontSize).toBe(16);
    expect(store.terminalFont).toBe('JetBrains Mono');
    expect(store.fontSmoothing).toBe(false);
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

  it('preserves browser-local selected agent for a multi-agent task', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'agent-2',
        activeTaskId: 'task-1',
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
        agentIds: ['agent-1', 'agent-2'],
        selectedAgentId: 'agent-1',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });

    expect(loadClientSessionState()).toBe(true);
    expect(store.activeTaskId).toBe('task-1');
    expect(store.activeAgentId).toBe('agent-2');
  });

  it('preserves browser-local shell selection for a task terminal', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'shell-agent-1',
        activeTaskId: 'task-1',
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
        shellAgentIds: ['shell-agent-1'],
        notes: '',
        lastPrompt: '',
      },
    });

    expect(loadClientSessionState()).toBe(true);
    expect(store.activeAgentId).toBe('shell-agent-1');
  });

  it('does not restore standalone terminal panels by default', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'shell-agent-1',
        activeTaskId: 'terminal-1',
        terminalPanels: {
          collapsedTaskOrder: [],
          taskOrder: ['task-1', 'terminal-1'],
          terminals: {
            'terminal-1': {
              agentId: 'shell-agent-1',
              id: 'terminal-1',
              name: 'Shell',
            },
          },
        },
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
    expect(store.taskOrder).toEqual(['task-1']);
    expect(store.terminals).toEqual({});
  });

  it('restores standalone terminal panels only when explicitly requested', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'shell-agent-1',
        activeTaskId: 'terminal-1',
        terminalPanels: {
          collapsedTaskOrder: [],
          taskOrder: ['task-1', 'terminal-1'],
          terminals: {
            'terminal-1': {
              agentId: 'shell-agent-1',
              id: 'terminal-1',
              name: 'Shell',
            },
          },
        },
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

    expect(loadClientSessionState({ restoreTerminalPanels: true })).toBe(true);
    expect(store.taskOrder).toEqual(['task-1', 'terminal-1']);
    expect(store.terminals).toEqual({
      'terminal-1': {
        agentId: 'shell-agent-1',
        id: 'terminal-1',
        name: 'Shell',
      },
    });
    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.activeAgentId).toBe('shell-agent-1');
  });

  it('skips invalid standalone terminal panel records when restoring browser session terminals', () => {
    sessionStorage.setItem(
      'parallel-code-client-session',
      JSON.stringify({
        activeAgentId: 'shell-agent-1',
        activeTaskId: 'terminal-good',
        terminalPanels: {
          collapsedTaskOrder: [],
          taskOrder: [
            'task-1',
            'terminal-good',
            'terminal-bad-id',
            'terminal-bad-name',
            'terminal-mismatched-id',
          ],
          terminals: {
            'terminal-good': {
              agentId: 'shell-agent-1',
              id: 'terminal-good',
              name: 'Shell',
            },
            'terminal-bad-id': {
              agentId: 'shell-agent-2',
              id: 123,
              name: 'Broken',
            },
            'terminal-bad-name': {
              agentId: 'shell-agent-3',
              id: 'terminal-bad-name',
              name: false,
            },
            'terminal-mismatched-id': {
              agentId: 'shell-agent-4',
              id: 'terminal-other-id',
              name: 'Broken',
            },
          },
        },
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
    setStore('terminals', {
      'terminal-bad-id': {
        agentId: 'old-shell-agent-2',
        id: 'terminal-bad-id',
        name: 'Old broken shell',
      },
      'terminal-mismatched-id': {
        agentId: 'old-shell-agent-4',
        id: 'terminal-mismatched-id',
        name: 'Old mismatched shell',
      },
    });

    expect(loadClientSessionState({ restoreTerminalPanels: true })).toBe(true);
    expect(store.taskOrder).toEqual(['task-1', 'terminal-good']);
    expect(store.terminals).toEqual({
      'terminal-good': {
        agentId: 'shell-agent-1',
        id: 'terminal-good',
        name: 'Shell',
      },
    });
    expect(store.activeTaskId).toBe('terminal-good');
    expect(store.activeAgentId).toBe('shell-agent-1');
  });

  it('rejects malformed browser-local session records before restoring selection', () => {
    for (const malformedSession of ['null', '[]', '"stale-session"']) {
      sessionStorage.setItem('parallel-code-client-session', malformedSession);
      setStore('activeTaskId', 'current-task');

      expect(loadClientSessionState()).toBe(false);
      expect(sessionStorage.getItem('parallel-code-client-session')).toBeNull();
      expect(store.activeTaskId).toBe('current-task');
    }
  });

  it('defaults malformed numeric browser-local session fields without rejecting the session', () => {
    sessionStorage.setItem('parallel-code-client-session', '{"globalScale":1e999}');
    setStore('globalScale', 1.25);

    expect(loadClientSessionState()).toBe(true);
    expect(store.globalScale).toBe(1);
  });

  it('treats browser session storage as unavailable when the document blocks access', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });

    expect(() => saveClientSessionState()).not.toThrow();
    expect(loadClientSessionState()).toBe(false);
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

  it('treats browser-local session storage as unavailable when access throws', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });

    expect(loadClientSessionState()).toBe(false);
    expect(() => saveClientSessionState()).not.toThrow();
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
