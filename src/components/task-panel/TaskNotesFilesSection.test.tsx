import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, For, Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../../store/core';
import { createTestTask, resetStoreForTest } from '../../test/store-test-helpers';
import { TaskNotesFilesSection } from './TaskNotesFilesSection';

const {
  getProjectMock,
  isAgentAskingQuestionMock,
  openMarkdownViewerMock,
  sendPromptMock,
  setReviewPanelOpenMock,
  setTaskFocusedPanelMock,
  showNotificationMock,
  updateTaskNotesMock,
} = vi.hoisted(() => ({
  getProjectMock: vi.fn(),
  isAgentAskingQuestionMock: vi.fn(),
  openMarkdownViewerMock: vi.fn(),
  sendPromptMock: vi.fn(),
  setReviewPanelOpenMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  showNotificationMock: vi.fn(),
  updateTaskNotesMock: vi.fn(),
}));

vi.mock('../../app/markdown-viewer', () => ({
  openMarkdownViewer: openMarkdownViewerMock,
}));

vi.mock('../../app/task-workflows', () => ({
  sendPrompt: sendPromptMock,
}));

vi.mock('../../store/store', async () => {
  const core = await vi.importActual<typeof import('../../store/core')>('../../store/core');
  return {
    store: core.store,
    getProject: getProjectMock,
    isAgentAskingQuestion: isAgentAskingQuestionMock,
    setReviewPanelOpen: setReviewPanelOpenMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    showNotification: showNotificationMock,
    updateTaskNotes: updateTaskNotesMock,
  };
});

vi.mock('../ChangedFilesList', () => ({
  ChangedFilesList: (props: { setRootRef?: (element: HTMLDivElement | undefined) => void }) => (
    <div
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
  beforeEach(() => {
    resetStoreForTest();
    getProjectMock.mockReset();
    openMarkdownViewerMock.mockReset();
    openMarkdownViewerMock.mockResolvedValue(true);
    sendPromptMock.mockReset();
    sendPromptMock.mockResolvedValue(true);
    isAgentAskingQuestionMock.mockReset();
    isAgentAskingQuestionMock.mockReturnValue(false);
    showNotificationMock.mockReset();
    setReviewPanelOpenMock.mockReset();
    setTaskFocusedPanelMock.mockReset();
    updateTaskNotesMock.mockReset();

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
        worktreePath: '/tmp/project/task',
      });
    });
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
        worktreePath: '/tmp/project/task',
      });
    });
  });

  it('sends notes through the task prompt workflow', async () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      notes: '  summarize this plan  ',
      projectId: 'project-1',
      worktreePath: '/tmp/project/task',
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

    fireEvent.click(screen.getByRole('button', { name: 'Send notes as prompt' }));

    await waitFor(() => {
      expect(sendPromptMock).toHaveBeenCalledWith('task-1', 'agent-1', 'summarize this plan');
    });
  });
});
