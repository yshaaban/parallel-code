import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createRenderEffect, For, Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import {
  createTestAgent,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';

const {
  applyTaskPortsEventMock,
  clearPendingActionMock,
  collapseTaskMock,
  exposeTaskPortForTaskMock,
  fetchTaskPortExposureCandidatesMock,
  getTaskPortSnapshotMock,
  handleTaskPermissionResponseMock,
  isElectronRuntimeMock,
  registerFocusFnMock,
  refreshTaskPreviewForTaskMock,
  retryCloseTaskMock,
  setActiveTaskMock,
  setTaskFocusedPanelMock,
  showNotificationMock,
  triggerFocusMock,
  unexposeTaskPortForTaskMock,
  unregisterFocusFnMock,
  updateTaskNameMock,
  previewSectionPropsRef,
  pushDialogPropsRef,
} = vi.hoisted(() => ({
  applyTaskPortsEventMock: vi.fn(),
  clearPendingActionMock: vi.fn(),
  collapseTaskMock: vi.fn(),
  exposeTaskPortForTaskMock: vi.fn(),
  fetchTaskPortExposureCandidatesMock: vi.fn(),
  getTaskPortSnapshotMock: vi.fn(),
  handleTaskPermissionResponseMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  registerFocusFnMock: vi.fn(),
  refreshTaskPreviewForTaskMock: vi.fn(),
  retryCloseTaskMock: vi.fn(),
  setActiveTaskMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  showNotificationMock: vi.fn(),
  triggerFocusMock: vi.fn(),
  unexposeTaskPortForTaskMock: vi.fn(),
  unregisterFocusFnMock: vi.fn(),
  updateTaskNameMock: vi.fn(),
  previewSectionPropsRef: {
    current: null as null | {
      availableCandidates: () => unknown[];
      availableScanError: () => string | null;
      availableScanning: () => boolean;
      onExposePort: (port: number, label?: string) => Promise<void> | void;
      onRefreshAvailablePorts: () => Promise<void> | void;
      onUnexposePort: (port: number) => Promise<void> | void;
    },
  },
  pushDialogPropsRef: {
    current: null as null | {
      onClose: () => void;
      onDone: (success: boolean) => void;
      open: boolean;
    },
  },
}));

vi.mock('../lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../lib/drag-reorder', () => ({
  handleDragReorder: vi.fn(),
}));

vi.mock('../lib/hydra', () => ({
  isHydraAgentDef: vi.fn(() => false),
}));

vi.mock('../app/task-ports', () => ({
  applyTaskPortsEvent: applyTaskPortsEventMock,
  exposeTaskPortForTask: exposeTaskPortForTaskMock,
  fetchTaskPortExposureCandidates: fetchTaskPortExposureCandidatesMock,
  getTaskPortSnapshot: getTaskPortSnapshotMock,
  refreshTaskPreviewForTask: refreshTaskPreviewForTaskMock,
  unexposeTaskPortForTask: unexposeTaskPortForTaskMock,
}));

vi.mock('./CloseTaskDialog', () => ({
  CloseTaskDialog: (props: { open: boolean }) => (
    <Show when={props.open}>
      <div>Close task dialog</div>
    </Show>
  ),
}));

vi.mock('./MergeDialog', () => ({
  MergeDialog: (props: { open: boolean }) => (
    <Show when={props.open}>
      <div>Merge dialog</div>
    </Show>
  ),
}));

vi.mock('./PushDialog', () => ({
  PushDialog: (props: {
    onClose: () => void;
    onDone: (success: boolean) => void;
    open: boolean;
  }) => {
    createRenderEffect(() => {
      pushDialogPropsRef.current = {
        onClose: props.onClose,
        onDone: props.onDone,
        open: props.open,
      };
    });
    return (
      <Show when={props.open}>
        <div>Push dialog</div>
      </Show>
    );
  },
}));

vi.mock('./DiffViewerDialog', () => ({
  DiffViewerDialog: () => null,
}));

vi.mock('./EditProjectDialog', () => ({
  EditProjectDialog: () => null,
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { open: boolean; children: JSX.Element }) => (
    <Show when={props.open}>
      <div>{props.children}</div>
    </Show>
  ),
}));

vi.mock('./PermissionCard', () => ({
  PermissionCard: (props: {
    onApprove: (requestId: string) => void;
    onDeny: (requestId: string) => void;
    request: { id: string; tool: string; status: string };
  }) => (
    <div>
      <div>Permission card</div>
      <button onClick={() => props.onApprove(props.request.id)}>Approve permission</button>
      <button onClick={() => props.onDeny(props.request.id)}>Deny permission</button>
    </div>
  ),
}));

vi.mock('./ScalablePanel', () => ({
  ScalablePanel: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));

vi.mock('./ResizablePanel', () => ({
  ResizablePanel: (props: { children: Array<{ id: string; content: () => JSX.Element }> }) => (
    <div>
      <For each={props.children}>
        {(child) => <div data-panel-id={child.id}>{child.content()}</div>}
      </For>
    </div>
  ),
}));

vi.mock('./TaskTitleBar', () => ({
  TaskTitleBar: (props: {
    onClose: () => void;
    onPreviewButtonClick: () => void;
    onOpenMerge: () => void;
    onOpenPush: () => void;
    onUpdateTaskName: (value: string) => void;
    onCollapse: () => void;
    onSetTitleEditHandle: (handle: { startEdit: () => void }) => void;
  }) => {
    createRenderEffect(() => {
      props.onSetTitleEditHandle({ startEdit: vi.fn() });
    });

    return (
      <div>
        <button onClick={() => props.onUpdateTaskName('Renamed')}>Rename task</button>
        <button onClick={() => props.onPreviewButtonClick()}>Toggle preview</button>
        <button onClick={() => props.onOpenMerge()}>Open merge</button>
        <button onClick={() => props.onOpenPush()}>Open push</button>
        <button onClick={() => props.onCollapse()}>Collapse task</button>
        <button onClick={() => props.onClose()}>Open close</button>
      </div>
    );
  },
}));

vi.mock('./TaskBranchInfoBar', () => ({
  TaskBranchInfoBar: () => <div>Branch info</div>,
}));

vi.mock('./PromptInput', () => ({
  PromptInput: (props: {
    ref?: (element: HTMLTextAreaElement) => void;
    handle?: (handle: { getText: () => string; setText: (value: string) => void }) => void;
  }) => {
    let textarea!: HTMLTextAreaElement;
    return (
      <textarea
        aria-label="Prompt input"
        ref={(element) => {
          textarea = element;
          props.ref?.(element);
          props.handle?.({
            getText: () => textarea.value,
            setText: (value: string) => {
              textarea.value = value;
            },
          });
        }}
      />
    );
  },
}));

vi.mock('./task-panel/TaskNotesFilesSection', () => ({
  createTaskNotesFilesSection: vi.fn(() => ({
    id: 'notes-files',
    content: () => <div>Notes and files</div>,
  })),
}));

vi.mock('./task-panel/TaskShellSection', () => ({
  createTaskShellSection: vi.fn(() => ({
    id: 'shell',
    content: () => <div>Shell section</div>,
  })),
}));

vi.mock('./task-panel/TaskAiTerminalSection', () => ({
  createTaskAiTerminalSection: vi.fn(() => ({
    id: 'ai-terminal',
    content: () => <div>AI terminal</div>,
  })),
}));

vi.mock('./task-panel/TaskPreviewSection', () => ({
  createTaskPreviewSection: vi.fn((props: unknown) => {
    const typedProps = props as {
      availableCandidates: () => unknown[];
      availableScanError: () => string | null;
      availableScanning: () => boolean;
      onExposePort: (port: number, label?: string) => Promise<void> | void;
      onRefreshAvailablePorts: () => Promise<void> | void;
      onUnexposePort: (port: number) => Promise<void> | void;
    };

    createRenderEffect(() => {
      previewSectionPropsRef.current = typedProps;
    });

    return {
      id: 'preview',
      content: () => <div>Preview section</div>,
    };
  }),
}));

vi.mock('./task-panel/task-panel-helpers', () => ({
  getAgentStatusBadgeText: vi.fn(() => 'Running'),
}));

vi.mock('../app/task-workflows', () => ({
  collapseTask: collapseTaskMock,
  retryCloseTask: retryCloseTaskMock,
  sendAgentEnter: vi.fn(),
  sendPrompt: vi.fn(),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    store: core.store,
    clearInitialPrompt: vi.fn(),
    clearPendingAction: clearPendingActionMock,
    clearPrefillPrompt: vi.fn(),
    getProject: vi.fn((projectId: string) =>
      projectId === 'project-1'
        ? { id: 'project-1', path: '/tmp/project', deleteBranchOnClose: true }
        : null,
    ),
    getStoredTaskFocusedPanel: vi.fn((taskId: string) => core.store.focusedPanel[taskId] ?? null),
    getTaskDotStatus: vi.fn(() => 'busy'),
    isTaskPanelFocused: vi.fn(
      (taskId: string, panelId: string) => core.store.focusedPanel[taskId] === panelId,
    ),
    registerFocusFn: registerFocusFnMock,
    reorderTask: vi.fn(),
    setActiveTask: setActiveTaskMock,
    setTaskFocusedPanel: vi.fn((taskId: string, panelId: string) => {
      setTaskFocusedPanelMock(taskId, panelId);
      core.setStore('focusedPanel', taskId, panelId);
    }),
    triggerFocus: triggerFocusMock,
    unregisterFocusFn: unregisterFocusFnMock,
    updateTaskName: updateTaskNameMock,
  };
});

vi.mock('../app/task-permission-workflows', () => ({
  handleTaskPermissionResponse: handleTaskPermissionResponseMock,
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

import { TaskPanel } from './TaskPanel';

describe('TaskPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
    vi.useFakeTimers();
    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(true);
    getTaskPortSnapshotMock.mockReturnValue(undefined);
    fetchTaskPortExposureCandidatesMock.mockResolvedValue([]);
    setStore('projects', [createTestProject()]);
    const task = createTestTask({
      agentIds: ['agent-1'],
      initialPrompt: 'hello',
      prefillPrompt: 'prefill',
    });
    setStore('tasks', { 'task-1': task });
    setStore('taskOrder', ['task-1']);
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
    setStore('permissionRequests', {
      'agent-1': [
        {
          agentId: 'agent-1',
          arguments: '--dangerously-skip-permissions',
          description: 'Run a command',
          detectedAt: 1_000,
          id: 'permission-1',
          status: 'pending',
          taskId: 'task-1',
          tool: 'Bash',
        },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('opens the close dialog from the title bar action', () => {
    setStore('focusedPanel', { 'task-1': 'prompt' });

    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Open close' }));

    expect(screen.getByText('Close task dialog')).toBeDefined();
  });

  it('routes permission responses through the app-layer workflow owner', () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    expect(screen.getByText('Permission card')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Approve permission' }));
    expect(handleTaskPermissionResponseMock).toHaveBeenCalledWith(
      'agent-1',
      'permission-1',
      'approve',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny permission' }));
    expect(handleTaskPermissionResponseMock).toHaveBeenCalledWith(
      'agent-1',
      'permission-1',
      'deny',
    );
  });

  it('opens the preview manager from the title bar action without scanning automatically', () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));

    expect(screen.getByText('Preview section')).toBeDefined();
    expect(fetchTaskPortExposureCandidatesMock).not.toHaveBeenCalled();
  });

  it('keeps the preview hidden by default and toggles it open when ports exist', () => {
    getTaskPortSnapshotMock.mockReturnValue({
      taskId: 'task-1',
      observed: [
        {
          host: '127.0.0.1',
          port: 5173,
          protocol: 'http',
          source: 'output',
          suggestion: 'http://127.0.0.1:5173',
          updatedAt: 1_000,
        },
      ],
      exposed: [],
      updatedAt: 1_000,
    });

    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    expect(screen.queryByText('Preview section')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));
    expect(screen.getByText('Preview section')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));
    expect(screen.queryByText('Preview section')).toBeNull();
  });

  it('keeps the preview manager available even when no preview ports exist yet', () => {
    setStore('focusedPanel', { 'task-1': 'preview' });

    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    expect(screen.getByText('Preview section')).toBeDefined();
    expect(fetchTaskPortExposureCandidatesMock).not.toHaveBeenCalled();
    expect(setTaskFocusedPanelMock).not.toHaveBeenCalledWith('task-1', 'prompt');
  });

  it('rescans preview candidates only when requested explicitly', async () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));

    expect(fetchTaskPortExposureCandidatesMock).not.toHaveBeenCalled();

    await previewSectionPropsRef.current?.onRefreshAvailablePorts();

    expect(fetchTaskPortExposureCandidatesMock).toHaveBeenCalledWith(
      'task-1',
      '/tmp/project/task-1',
    );
  });

  it('opens the preview after exposing a port from the preview manager', async () => {
    const snapshot = {
      taskId: 'task-1',
      observed: [],
      exposed: [
        {
          availability: 'available' as const,
          host: null,
          label: 'Frontend',
          lastVerifiedAt: 1_100,
          port: 3001,
          protocol: 'http' as const,
          statusMessage: null,
          source: 'manual' as const,
          updatedAt: 1_100,
          verifiedHost: '127.0.0.1',
        },
      ],
      updatedAt: 1_100,
    };
    let currentSnapshot:
      | {
          exposed: typeof snapshot.exposed;
          observed: typeof snapshot.observed;
          taskId: string;
          updatedAt: number;
        }
      | undefined;
    getTaskPortSnapshotMock.mockImplementation(() => currentSnapshot);
    exposeTaskPortForTaskMock.mockImplementation(async () => {
      currentSnapshot = snapshot;
      return snapshot;
    });

    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));
    expect(screen.getByText('Preview section')).toBeDefined();

    await previewSectionPropsRef.current?.onExposePort(3001);

    expect(screen.getByText('Preview section')).toBeDefined();
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'preview');
  });

  it('clears stale scan candidates and surfaces the scan error when a rescan fails', async () => {
    fetchTaskPortExposureCandidatesMock
      .mockResolvedValueOnce([
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ])
      .mockRejectedValueOnce(new Error('Scan failed'));

    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));

    await previewSectionPropsRef.current?.onRefreshAvailablePorts();

    expect(previewSectionPropsRef.current?.availableCandidates()).toHaveLength(1);

    await previewSectionPropsRef.current?.onRefreshAvailablePorts();

    expect(previewSectionPropsRef.current?.availableCandidates()).toHaveLength(0);
    expect(previewSectionPropsRef.current?.availableScanError()).toBe('Scan failed');
  });

  it('shows a notification when a push finishes after the dialog was closed', async () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Open push' }));
    expect(screen.getByText('Push dialog')).toBeDefined();

    pushDialogPropsRef.current?.onClose();
    await waitFor(() => {
      expect(screen.queryByText('Push dialog')).toBeNull();
    });

    pushDialogPropsRef.current?.onDone(false);
    expect(showNotificationMock).toHaveBeenCalledWith('Push failed for feature/task-1');
  });

  it('auto-focuses the prompt for the active task when no panel is focused', async () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    await vi.advanceTimersByTimeAsync(0);

    const promptInput = screen.getByLabelText('Prompt input');
    await waitFor(() => {
      expect(document.activeElement).toBe(promptInput);
    });
  });

  it('retries a failed close from the error overlay', async () => {
    render(() => (
      <TaskPanel
        task={createTestTask({
          agentIds: ['agent-1'],
          closeState: { kind: 'error', message: 'Delete failed' },
        })}
        isActive
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryCloseTaskMock).toHaveBeenCalledWith('task-1');
  });
});
