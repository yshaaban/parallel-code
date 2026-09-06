import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, For, Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskNotesControllerSnapshot } from '../task-notes/task-notes-controller';
import type { TaskNotesController } from '../task-notes/task-notes-controller';
import type { mountDesktopTaskNotes } from '../../app/task-notes-runtime';

import { setStore, store } from '../../store/core';
import { createTestTask, resetStoreForTest } from '../../test/store-test-helpers';
import { TaskNotesFilesSection } from './TaskNotesFilesSection';

const {
  getProjectMock,
  getLocalAgentQuestionGenerationMock,
  openMarkdownViewerMock,
  sendPromptMock,
  mountDesktopTaskNotesMock,
  setReviewPanelOpenMock,
  setTaskFocusedPanelMock,
  showNotificationMock,
} = vi.hoisted(() => ({
  getProjectMock: vi.fn(),
  getLocalAgentQuestionGenerationMock: vi.fn(),
  openMarkdownViewerMock: vi.fn(),
  sendPromptMock: vi.fn(),
  mountDesktopTaskNotesMock: vi.fn(),
  setReviewPanelOpenMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  showNotificationMock: vi.fn(),
}));

vi.mock('../../app/markdown-viewer', () => ({
  openMarkdownViewer: openMarkdownViewerMock,
}));

vi.mock('../../app/task-workflows', () => ({
  sendPrompt: sendPromptMock,
}));

vi.mock('../../app/task-notes-runtime', () => ({
  mountDesktopTaskNotes: mountDesktopTaskNotesMock,
}));

vi.mock('../../store/store', async () => {
  const core = await vi.importActual<typeof import('../../store/core')>('../../store/core');
  return {
    store: core.store,
    getProject: getProjectMock,
    getSelectedTaskAgentId: (
      task: { agentIds: string[]; selectedAgentId?: string },
      preferredAgentId?: string | null,
    ) => {
      if (preferredAgentId && task.agentIds.includes(preferredAgentId)) {
        return preferredAgentId;
      }

      if (task.selectedAgentId && task.agentIds.includes(task.selectedAgentId)) {
        return task.selectedAgentId;
      }

      return task.agentIds[0] ?? null;
    },
    getLocalAgentQuestionGeneration: getLocalAgentQuestionGenerationMock,
    isTaskCommandControlledByPeer: () => false,
    setReviewPanelOpen: setReviewPanelOpenMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    observeTaskPanelFocus: setTaskFocusedPanelMock,
    showNotification: showNotificationMock,
  };
});

vi.mock('../ChangedFilesList', () => ({
  ChangedFilesList: (props: { setRootRef?: (element: HTMLDivElement | undefined) => void }) => (
    <div
      tabIndex={0}
      ref={(element) => {
        props.setRootRef?.(element);
      }}
    >
      Changed files
    </div>
  ),
}));

vi.mock('../ReviewPanel', () => ({
  ReviewPanel: () => <div>Review panel</div>,
}));

vi.mock('../Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>
      <div>{props.children}</div>
    </Show>
  ),
}));

vi.mock('../IconButton', () => ({
  IconButton: (props: { icon: JSX.Element; onClick: () => void; title: string }) => (
    <button onClick={() => props.onClick()} title={props.title} type="button">
      {props.icon}
    </button>
  ),
}));

vi.mock('../ResizablePanel', () => ({
  ResizablePanel: (props: { children: Array<{ content: () => JSX.Element; id: string }> }) => (
    <div>
      <For each={props.children}>
        {(child) => <div data-panel-id={child.id}>{child.content()}</div>}
      </For>
    </div>
  ),
}));

vi.mock('../ScalablePanel', () => ({
  ScalablePanel: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));

describe('TaskNotesFilesSection', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    resetStoreForTest();
    getProjectMock.mockReset();
    openMarkdownViewerMock.mockReset();
    openMarkdownViewerMock.mockResolvedValue('opened');
    sendPromptMock.mockReset();
    sendPromptMock.mockResolvedValue(true);
    getLocalAgentQuestionGenerationMock.mockReset();
    getLocalAgentQuestionGenerationMock.mockReturnValue(undefined);
    showNotificationMock.mockReset();
    setReviewPanelOpenMock.mockReset();
    setTaskFocusedPanelMock.mockReset();
    mountDesktopTaskNotesMock.mockReset();
    mountDesktopTaskNotesMock.mockImplementation((taskId: string) => {
      let listener: ((value: TaskNotesControllerSnapshot) => void) | undefined;
      let snapshot: TaskNotesControllerSnapshot = {
        savedNoticeVisible: false,
        slowSaving: false,
        state: {
          base: {
            contentVersion: 'A'.repeat(43),
            notes: store.tasks[taskId]?.notes ?? '',
            taskId,
            taskIncarnation: 'B'.repeat(43),
            workspaceRevision: 1,
          },
          draft: store.tasks[taskId]?.notes ?? '',
          generation: 1,
          kind: 'clean',
          taskId,
        },
      };
      const controller = {
        edit(value: string) {
          snapshot = {
            ...snapshot,
            state: { ...snapshot.state, draft: value, kind: 'dirty' },
          } as TaskNotesControllerSnapshot;
          listener?.(snapshot);
        },
        save: vi.fn(),
        subscribe(next: (value: TaskNotesControllerSnapshot) => void) {
          listener = next;
          next(snapshot);
          return () => {
            listener = undefined;
          };
        },
      } as unknown as TaskNotesController;
      return { controller, release: vi.fn() };
    });

    getProjectMock.mockReturnValue({
      id: 'project-1',
      path: '/tmp/project',
    });

    setStore('showPlans', true);
  });

  function renderSection() {
    const task = createTestTask({
      id: 'task-1',
      projectId: 'project-1',
      planContent: '# Generated plan\n\n- step one',
      planFileName: 'plan.md',
      planRelativePath: 'docs/plans/plan.md',
      notes: '',
      worktreePath: '/tmp/project/task',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('plan');

    return render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));
  }

  it('clears the notes focus ref when the plan panel replaces notes', async () => {
    const notesRefs: Array<HTMLTextAreaElement | undefined> = [];
    const task = createTestTask({
      id: 'task-1',
      planContent: '# Generated plan',
      notes: '',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');

    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={(element) => notesRefs.push(element)}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    await waitFor(() => {
      expect(notesRefs.at(-1)).toBeInstanceOf(HTMLTextAreaElement);
    });

    await waitFor(() => expect(notesRefs.at(-1)?.disabled).toBe(false));
    notesRefs.at(-1)?.focus();
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'notes');

    setNotesTab('plan');

    await waitFor(() => {
      expect(notesRefs.at(-1)).toBeUndefined();
    });
  });

  it('clears the changed-files focus ref when review mode replaces changed files', async () => {
    const changedFilesRefs: Array<HTMLDivElement | undefined> = [];
    const task = createTestTask({
      id: 'task-1',
      notes: '',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');

    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={(element) => changedFilesRefs.push(element)}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    await waitFor(() => {
      expect(changedFilesRefs.at(-1)).toBeInstanceOf(HTMLDivElement);
    });

    changedFilesRefs.at(-1)?.focus();
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'changed-files');

    setStore('reviewPanelOpen', 'task-1', true);

    await waitFor(() => {
      expect(changedFilesRefs.at(-1)).toBeUndefined();
    });
  });

  it('opens the shared markdown viewer from the floating review button', async () => {
    renderSection();

    fireEvent.click(await screen.findByTitle('Review Plan'));

    await waitFor(() => {
      expect(openMarkdownViewerMock).toHaveBeenCalledWith({
        agentId: undefined,
        relativePath: 'docs/plans/plan.md',
        taskId: 'task-1',
      });
    });
  });

  it('does not reopen cached plan content after a file request is superseded', async () => {
    openMarkdownViewerMock.mockResolvedValueOnce('superseded');
    renderSection();

    fireEvent.click(await screen.findByTitle('Review Plan'));
    await Promise.resolve();

    expect(openMarkdownViewerMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes inline plan markdown through the shared renderer', async () => {
    const task = createTestTask({
      id: 'task-1',
      projectId: 'project-1',
      planContent: '<img src=x onerror=alert(1)>',
      planFileName: 'plan.md',
      notes: '',
      worktreePath: '/tmp/project/task',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('plan');

    const { container } = render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    await waitFor(() => {
      const planPanels = container.querySelectorAll('.plan-markdown');
      expect(planPanels[0]?.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(planPanels[0]?.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    });
  });

  it('opens the shared markdown viewer when Enter is pressed on the plan panel', async () => {
    const { container } = renderSection();

    let inlinePlan: HTMLDivElement | undefined;
    await waitFor(() => {
      inlinePlan = container.querySelector<HTMLDivElement>('.plan-markdown') ?? undefined;
      expect(inlinePlan).toBeDefined();
    });

    if (!inlinePlan) {
      return;
    }

    fireEvent.keyDown(inlinePlan, { key: 'Enter' });

    await waitFor(() => {
      expect(openMarkdownViewerMock).toHaveBeenCalledWith({
        agentId: undefined,
        relativePath: 'docs/plans/plan.md',
        taskId: 'task-1',
      });
    });
  });

  it('sends notes through the task prompt workflow', async () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      notes: '  summarize this plan  ',
      projectId: 'project-1',
      selectedAgentId: 'agent-2',
      worktreePath: '/tmp/project/task',
    });
    setStore('tasks', task.id, task);
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');

    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    await vi.dynamicImportSettled();
    fireEvent.click(screen.getByRole('button', { name: 'Send notes as prompt' }));

    await waitFor(() => {
      expect(sendPromptMock).toHaveBeenCalledWith('task-1', 'agent-2', 'summarize this plan');
    });
  });

  it('surfaces a control race without clearing or mutating the notes draft', async () => {
    sendPromptMock.mockResolvedValue(false);
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      notes: 'keep this draft',
      projectId: 'project-1',
    });
    setStore('tasks', task.id, task);
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');

    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    await vi.dynamicImportSettled();
    fireEvent.click(screen.getByRole('button', { name: 'Send notes as prompt' }));

    await waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledWith(
        'Notes were not sent because another session controls this task',
      );
    });
    expect(task.notes).toBe('keep this draft');
  });

  it('does not show agent prompt actions for terminal-only tasks', () => {
    const task = createTestTask({
      agentIds: [],
      id: 'task-1',
      notes: 'terminal notes',
      shellAgentIds: ['shell-1'],
      taskMode: 'terminal',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');

    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
      />
    ));

    expect(screen.queryByRole('button', { name: 'Send notes as prompt' })).toBeNull();
  });

  it('keeps typed edits local, autosaves once after one second, and sends the visible draft', async () => {
    vi.useFakeTimers();
    let snapshot: TaskNotesControllerSnapshot = {
      state: {
        kind: 'clean',
        generation: 1,
        taskId: 'task-1',
        base: {
          taskId: 'task-1',
          taskIncarnation: 'A'.repeat(43),
          contentVersion: 'A'.repeat(43),
          notes: 'server base',
          workspaceRevision: 1,
        },
        draft: 'server base',
      },
      savedNoticeVisible: false,
      slowSaving: false,
    };
    let listener: ((value: TaskNotesControllerSnapshot) => void) | undefined;
    const save = vi.fn();
    const fakeController = {
      edit(value: string) {
        snapshot = {
          ...snapshot,
          state: { ...snapshot.state, kind: 'dirty', draft: value },
        } as TaskNotesControllerSnapshot;
        listener?.(snapshot);
      },
      save,
      subscribe(next: (value: TaskNotesControllerSnapshot) => void) {
        listener = next;
        next(snapshot);
        return () => {
          listener = undefined;
        };
      },
    } as unknown as TaskNotesController;
    const mountTaskNotes = vi.fn(() => ({
      controller: fakeController,
      release: vi.fn(),
    })) as unknown as typeof mountDesktopTaskNotes;
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      notes: 'legacy value',
      projectId: 'project-1',
    });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        mountTaskNotes={mountTaskNotes}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));

    await vi.dynamicImportSettled();
    const editor = screen.getByRole('textbox');
    expect((editor as HTMLTextAreaElement).value).toBe('server base');
    fireEvent.input(editor, { target: { value: 'first draft' } });
    await vi.advanceTimersByTimeAsync(500);
    fireEvent.input(editor, { target: { value: 'visible draft' } });
    expect(task.notes).toBe('legacy value');
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Send notes as prompt' }));
    await vi.runAllTimersAsync();
    expect(sendPromptMock).toHaveBeenCalledWith('task-1', 'agent-1', 'visible draft');
  });

  it('keeps capability-read-only notes focusable and selectable', async () => {
    const task = createTestTask({ id: 'task-1', notes: 'copy this', projectId: 'project-1' });
    setStore('tasks', { 'task-1': task });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
        taskNotesCapability={{ read: true, write: false }}
      />
    ));

    await vi.dynamicImportSettled();
    const editor = screen.getByRole('textbox', { name: 'Task notes' }) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(false);
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText(/read-only in this session/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(editor.value.length);
  });

  it('offers confirmed reset when the task id now names a replacement task', async () => {
    let listener: ((value: TaskNotesControllerSnapshot) => void) | undefined;
    const oldBase = {
      contentVersion: 'A'.repeat(43),
      notes: 'old notes',
      taskId: 'task-1',
      taskIncarnation: 'B'.repeat(43),
      workspaceRevision: 1,
    };
    const snapshot = {
      savedNoticeVisible: false,
      slowSaving: false,
      state: {
        base: oldBase,
        draft: 'recover this',
        generation: 1,
        kind: 'orphaned',
        reason: 'task-replaced',
        taskId: 'task-1',
      },
    } as TaskNotesControllerSnapshot;
    const discard = vi.fn(() => {
      listener?.({
        ...snapshot,
        state: { draft: '', generation: 2, kind: 'loading', taskId: 'task-1' },
      });
      queueMicrotask(() =>
        listener?.({
          ...snapshot,
          state: {
            ...snapshot.state,
            base: { ...oldBase, notes: 'replacement notes' },
            draft: 'replacement notes',
            generation: 2,
            kind: 'clean',
          },
        } as TaskNotesControllerSnapshot),
      );
    });
    const controller = {
      discard,
      subscribe(next: (value: TaskNotesControllerSnapshot) => void) {
        listener = next;
        next(snapshot);
        return () => {};
      },
    } as unknown as TaskNotesController;
    const mountTaskNotes = vi.fn(() => ({
      controller,
      release: vi.fn(),
    })) as unknown as typeof mountDesktopTaskNotes;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const task = createTestTask({ id: 'task-1', projectId: 'project-1' });
    const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
    render(() => (
      <TaskNotesFilesSection
        isActive={() => true}
        isHydraTask={() => false}
        mountTaskNotes={mountTaskNotes}
        notesTab={notesTab}
        onFileClick={() => {}}
        setChangedFilesRef={() => {}}
        setNotesRef={() => {}}
        setPlanFocusRef={() => {}}
        setNotesTab={setNotesTab}
        task={() => task}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));

    await vi.dynamicImportSettled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft and reload' }));
    expect(confirm).toHaveBeenCalledWith(
      'Discard the recovered draft and load notes for the current task?',
    );
    expect(discard).toHaveBeenCalledOnce();
    const editor = screen.getByRole('textbox', { name: 'Task notes' });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    confirm.mockRestore();
  });
});
