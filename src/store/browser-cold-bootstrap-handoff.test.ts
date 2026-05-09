import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentDef } from '../test/store-test-helpers.js';
import {
  hasMeaningfulBrowserColdBootstrapProjection,
  saveBrowserColdBootstrapHandoffSnapshot,
  takeBrowserColdBootstrapHandoffProjection,
} from './browser-cold-bootstrap-handoff.js';

vi.mock('../lib/ipc.js', () => ({
  isElectronRuntime: () => false,
}));

const buildOptions = {
  currentAvailableAgents: [createTestAgentDef({ id: 'claude-code', name: 'Claude Code' })],
  currentCustomAgents: [],
} as const;
const browserColdBootstrapHandoffStorageKey = 'parallel-code-browser-cold-bootstrap-handoff';

function createMemoryStorage(): Storage {
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

describe('browser-cold-bootstrap-handoff', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    window.name = '';
    vi.stubGlobal('sessionStorage', createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores a browser cold bootstrap projection from same-tab handoff storage', () => {
    saveBrowserColdBootstrapHandoffSnapshot(
      JSON.stringify({
        projects: [
          {
            color: '#335577',
            id: 'project-1',
            name: 'Project',
            path: '/tmp/project',
          },
        ],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            agentDef: {
              args: [],
              command: 'claude',
              description: 'Claude Code',
              id: 'claude-code',
              name: 'Claude Code',
              resume_args: [],
              skip_permissions_args: [],
            },
            agentId: 'agent-1',
            branchName: 'feature/task-1',
            id: 'task-1',
            lastPrompt: '',
            name: 'Task 1',
            notes: '',
            projectId: 'project-1',
            shellCount: 0,
            worktreePath: '/tmp/project/task-1',
          },
        },
      }),
    );

    const projection = takeBrowserColdBootstrapHandoffProjection(buildOptions);

    expect(projection).toMatchObject({
      projects: [expect.objectContaining({ id: 'project-1' })],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': expect.objectContaining({
          agentIds: ['agent-1'],
          id: 'task-1',
        }),
      },
    });
    expect(sessionStorage.getItem(browserColdBootstrapHandoffStorageKey)).toBeNull();
    expect(window.name).toBe('');
  });

  it('returns null when sessionStorage access is unavailable', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });

    saveBrowserColdBootstrapHandoffSnapshot(
      JSON.stringify({
        projects: [
          {
            color: '#335577',
            id: 'project-window-name',
            name: 'Project',
            path: '/tmp/project',
          },
        ],
        taskOrder: ['task-window-name'],
        tasks: {
          'task-window-name': {
            agentDef: {
              args: [],
              command: 'claude',
              description: 'Claude Code',
              id: 'claude-code',
              name: 'Claude Code',
              resume_args: [],
              skip_permissions_args: [],
            },
            agentId: 'agent-window-name',
            branchName: 'feature/task-window-name',
            id: 'task-window-name',
            lastPrompt: '',
            name: 'Task Window Name',
            notes: '',
            projectId: 'project-window-name',
            shellCount: 0,
            worktreePath: '/tmp/project/task-window-name',
          },
        },
      }),
    );

    const projection = takeBrowserColdBootstrapHandoffProjection(buildOptions);

    expect(projection).toBeNull();
    expect(window.name).toBe('');
  });

  it('returns null when sessionStorage operations throw during save and load', () => {
    const throwingStorage = {
      clear(): void {},
      getItem(): string | null {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
      key(): string | null {
        return null;
      },
      get length(): number {
        return 0;
      },
      removeItem(): void {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
      setItem(): void {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    } satisfies Storage;
    vi.stubGlobal('sessionStorage', throwingStorage);

    saveBrowserColdBootstrapHandoffSnapshot(
      JSON.stringify({
        projects: [
          {
            color: '#335577',
            id: 'project-window-name-storage-error',
            name: 'Project',
            path: '/tmp/project',
          },
        ],
        taskOrder: ['task-window-name-storage-error'],
        tasks: {
          'task-window-name-storage-error': {
            agentDef: {
              args: [],
              command: 'claude',
              description: 'Claude Code',
              id: 'claude-code',
              name: 'Claude Code',
              resume_args: [],
              skip_permissions_args: [],
            },
            agentId: 'agent-window-name-storage-error',
            branchName: 'feature/task-window-name-storage-error',
            id: 'task-window-name-storage-error',
            lastPrompt: '',
            name: 'Task Window Name Storage Error',
            notes: '',
            projectId: 'project-window-name-storage-error',
            shellCount: 0,
            worktreePath: '/tmp/project/task-window-name-storage-error',
          },
        },
      }),
    );

    const projection = takeBrowserColdBootstrapHandoffProjection(buildOptions);

    expect(projection).toBeNull();
    expect(window.name).toBe('');
  });

  it('ignores malformed browser cold bootstrap handoff payloads', () => {
    const malformedPayloads = [
      'null',
      '[]',
      JSON.stringify({ capturedAtMs: Date.now() }),
      JSON.stringify({
        capturedAtMs: Number.POSITIVE_INFINITY,
        workspaceStateJson: JSON.stringify({ projects: [] }),
      }),
      JSON.stringify({
        capturedAtMs: Date.now(),
        workspaceStateJson: { projects: [] },
      }),
    ];

    for (const payload of malformedPayloads) {
      sessionStorage.setItem(browserColdBootstrapHandoffStorageKey, payload);

      expect(takeBrowserColdBootstrapHandoffProjection(buildOptions)).toBeNull();
      expect(sessionStorage.getItem(browserColdBootstrapHandoffStorageKey)).toBeNull();
    }
  });

  it('ignores stale handoff snapshots', () => {
    sessionStorage.setItem(
      browserColdBootstrapHandoffStorageKey,
      JSON.stringify({
        capturedAtMs: Date.now() - 20_000,
        workspaceStateJson: JSON.stringify({
          projects: [
            {
              color: '#335577',
              id: 'project-stale',
              name: 'Project',
              path: '/tmp/project',
            },
          ],
          taskOrder: ['task-stale'],
          tasks: {
            'task-stale': {
              agentDef: {
                args: [],
                command: 'claude',
                description: 'Claude Code',
                id: 'claude-code',
                name: 'Claude Code',
                resume_args: [],
                skip_permissions_args: [],
              },
              agentId: 'agent-stale',
              branchName: 'feature/stale',
              id: 'task-stale',
              lastPrompt: '',
              name: 'Task Stale',
              notes: '',
              projectId: 'project-stale',
              shellCount: 0,
              worktreePath: '/tmp/project/task-stale',
            },
          },
        }),
      }),
    );

    const projection = takeBrowserColdBootstrapHandoffProjection(buildOptions);

    expect(projection).toBeNull();
    expect(sessionStorage.getItem(browserColdBootstrapHandoffStorageKey)).toBeNull();
  });

  it('detects whether a cold bootstrap projection carries meaningful workspace state', () => {
    expect(
      hasMeaningfulBrowserColdBootstrapProjection({
        availableAgents: [],
        collapsedTaskOrder: [],
        completedTaskCount: 0,
        completedTaskDate: '2026-04-08',
        customAgents: [],
        hydraCommand: '',
        hydraForceDispatchFromPromptPanel: true,
        hydraStartupMode: 'auto',
        lastProjectId: null,
        mergedLinesAdded: 0,
        mergedLinesRemoved: 0,
        projects: [],
        taskOrder: [],
        tasks: {},
        terminals: {},
      }),
    ).toBe(false);
    expect(
      hasMeaningfulBrowserColdBootstrapProjection({
        availableAgents: [],
        collapsedTaskOrder: [],
        completedTaskCount: 0,
        completedTaskDate: '2026-04-08',
        customAgents: [],
        hydraCommand: '',
        hydraForceDispatchFromPromptPanel: true,
        hydraStartupMode: 'auto',
        lastProjectId: null,
        mergedLinesAdded: 0,
        mergedLinesRemoved: 0,
        projects: [],
        taskOrder: ['shell-1'],
        tasks: {},
        terminals: {
          'shell-1': {
            agentId: 'shell-agent-1',
            id: 'shell-1',
            name: 'Shell 1',
          },
        },
      }),
    ).toBe(false);
    expect(
      hasMeaningfulBrowserColdBootstrapProjection({
        availableAgents: [],
        collapsedTaskOrder: [],
        completedTaskCount: 0,
        completedTaskDate: '2026-04-08',
        customAgents: [],
        hydraCommand: '',
        hydraForceDispatchFromPromptPanel: true,
        hydraStartupMode: 'auto',
        lastProjectId: null,
        mergedLinesAdded: 0,
        mergedLinesRemoved: 0,
        projects: [{ color: '#335577', id: 'project-1', name: 'Project', path: '/tmp/project' }],
        taskOrder: [],
        tasks: {},
        terminals: {},
      }),
    ).toBe(true);
  });
});
