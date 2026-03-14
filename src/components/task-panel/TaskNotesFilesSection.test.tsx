import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal, For, Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../../store/core';
import { createTestTask, resetStoreForTest } from '../../test/store-test-helpers';
import { TaskNotesFilesSection } from './TaskNotesFilesSection';

const { getProjectMock, setReviewPanelOpenMock, setTaskFocusedPanelMock, updateTaskNotesMock } =
  vi.hoisted(() => ({
    getProjectMock: vi.fn(),
    setReviewPanelOpenMock: vi.fn(),
    setTaskFocusedPanelMock: vi.fn(),
    updateTaskNotesMock: vi.fn(),
  }));

vi.mock('../../store/store', async () => {
  const core = await vi.importActual<typeof import('../../store/core')>('../../store/core');
  return {
    store: core.store,
    getProject: getProjectMock,
    setReviewPanelOpen: setReviewPanelOpenMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    updateTaskNotes: updateTaskNotesMock,
  };
});

vi.mock('../ChangedFilesList', () => ({
  ChangedFilesList: () => <div>Changed files</div>,
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

  it('opens the plan viewer from the floating review button', () => {
    renderSection();

    fireEvent.click(screen.getByTitle('Review Plan'));

    expect(screen.getByText('plan.md')).toBeTruthy();
    expect(screen.getAllByText('Generated plan').length).toBeGreaterThan(0);
  });

  it('opens the plan viewer when Enter is pressed on the plan panel', () => {
    const { container } = renderSection();

    const planPanels = container.querySelectorAll('.plan-markdown');
    const inlinePlan = planPanels[0] as HTMLDivElement | undefined;
    expect(inlinePlan).toBeDefined();

    if (!inlinePlan) {
      return;
    }

    fireEvent.keyDown(inlinePlan, { key: 'Enter' });

    expect(screen.getByText('plan.md')).toBeTruthy();
  });
});
