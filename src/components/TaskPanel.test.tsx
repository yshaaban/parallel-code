import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createRenderEffect, For, Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  handlePermissionResponseMock,
  isElectronRuntimeMock,
  registerFocusFnMock,
  retryCloseTaskMock,
  setActiveTaskMock,
  setTaskFocusedPanelMock,
  showNotificationMock,
  triggerFocusMock,
  unexposeTaskPortForTaskMock,
  unregisterFocusFnMock,
  updateTaskNameMock,
  exposePortDialogPropsRef,
  pushDialogPropsRef,
} = vi.hoisted(() => ({
  applyTaskPortsEventMock: vi.fn(),
  clearPendingActionMock: vi.fn(),
  collapseTaskMock: vi.fn(),
  exposeTaskPortForTaskMock: vi.fn(),
  fetchTaskPortExposureCandidatesMock: vi.fn(),
  getTaskPortSnapshotMock: vi.fn(),
  handlePermissionResponseMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  registerFocusFnMock: vi.fn(),
  retryCloseTaskMock: vi.fn(),
  setActiveTaskMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  showNotificationMock: vi.fn(),
  triggerFocusMock: vi.fn(),
  unexposeTaskPortForTaskMock: vi.fn(),
  unregisterFocusFnMock: vi.fn(),
  updateTaskNameMock: vi.fn(),
  exposePortDialogPropsRef: {
    current: null as null | {
      onExpose: (port: number, label?: string) => Promise<void> | void;
      open: boolean;
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

vi.mock('./ExposePortDialog', () => ({
  ExposePortDialog: (props: {
    open: boolean;
    candidates?: unknown[];
    onExpose: (port: number, label?: string) => Promise<void> | void;
  }) => {
    createRenderEffect(() => {
      exposePortDialogPropsRef.current = {
        onExpose: props.onExpose,
        open: props.open,
      };
    });

    return (
      <Show when={props.open}>
        <div>Expose port dialog</div>
        <div>Expose candidates: {props.candidates?.length ?? 0}</div>
      </Show>
    );
  },
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { open: boolean; children: JSX.Element }) => (
    <Show when={props.open}>
      <div>{props.children}</div>
    </Show>
  ),
}));

vi.mock('./PermissionCard', () => ({
  PermissionCard: () => <div>Permission card</div>,
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
  createTaskPreviewSection: vi.fn(() => ({
    id: 'preview',
    content: () => <div>Preview section</div>,
  })),
}));

vi.mock('./task-panel/task-panel-helpers', () => ({
  getAgentStatusBadgeText: vi.fn(() => 'Running'),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    store: core.store,
    clearInitialPrompt: vi.fn(),
    clearPendingAction: clearPendingActionMock,
    clearPrefillPrompt: vi.fn(),
    collapseTask: collapseTaskMock,
    getProject: vi.fn((projectId: string) =>
      projectId === 'project-1'
        ? { id: 'project-1', path: '/tmp/project', deleteBranchOnClose: true }
        : null,
    ),
    getTaskDotStatus: vi.fn(() => 'busy'),
    handlePermissionResponse: handlePermissionResponseMock,
    registerFocusFn: registerFocusFnMock,
    reorderTask: vi.fn(),
    retryCloseTask: retryCloseTaskMock,
    setActiveTask: setActiveTaskMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    triggerFocus: triggerFocusMock,
    unregisterFocusFn: unregisterFocusFnMock,
    updateTaskName: updateTaskNameMock,
  };
});

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

import { TaskPanel } from './TaskPanel';

describe('TaskPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('opens the close dialog from the title bar action', () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Open close' }));

    expect(screen.getByText('Close task dialog')).toBeDefined();
  });

  it('opens the expose port dialog from the title bar action', () => {
    render(() => <TaskPanel task={createTestTask({ agentIds: ['agent-1'] })} isActive />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle preview' }));

    expect(screen.getByText('Expose port dialog')).toBeDefined();
    expect(fetchTaskPortExposureCandidatesMock).toHaveBeenCalledWith(
      'task-1',
      '/tmp/project/task-1',
    );
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

  it('opens the preview after exposing a port from the dialog', async () => {
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
    expect(screen.getByText('Expose port dialog')).toBeDefined();

    await exposePortDialogPropsRef.current?.onExpose(3001);

    expect(screen.getByText('Preview section')).toBeDefined();
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'preview');
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
          closingStatus: 'error',
          closingError: 'Delete failed',
        })}
        isActive
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryCloseTaskMock).toHaveBeenCalledWith('task-1');
  });
});
