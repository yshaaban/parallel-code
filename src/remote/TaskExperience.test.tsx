import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteProjectSummary,
  RemoteTaskSessionRef,
  RemoteTaskSummary,
} from '../domain/task-catalog';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import type { TaskCatalogProjection, TaskCatalogStoreSnapshot } from './task-catalog-store';

const taskNotesState = vi.hoisted(() => ({
  discard: vi.fn(),
  hasUnsaved: vi.fn((_taskId?: string) => false),
}));

vi.mock('./TaskNotesView', () => ({
  confirmRemoteTaskNotesLeave: (
    taskId: string,
    message: string,
    confirm: typeof window.confirm,
  ) => {
    if (!taskNotesState.hasUnsaved(taskId)) return true;
    if (!confirm(message)) return false;
    taskNotesState.discard(taskId);
    return true;
  },
  TaskNotesView: (props: { canWrite: boolean; taskName: string }) => (
    <div>
      Notes for {props.taskName} ({props.canWrite ? 'editable' : 'read only'})
    </div>
  ),
}));

vi.mock('./task-notes-runtime', () => ({
  discardRemoteTaskNotes: taskNotesState.discard,
  hasUnsavedRemoteTaskNotes: taskNotesState.hasUnsaved,
}));

function project(): RemoteProjectSummary {
  return {
    baseBranchChoiceCount: 0,
    baseBranchChoicesTruncated: false,
    id: 'project-1',
    label: 'Core project',
    labelTruncated: false,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    projectMode: 'git',
    worktreeChoiceCount: 0,
    worktreeChoicesTruncated: false,
  };
}

function task(overrides: Partial<RemoteTaskSummary> = {}): RemoteTaskSummary {
  return {
    branchLabel: 'feature/reliable-terminal',
    branchLabelTruncated: false,
    creationStatus: 'ready',
    lifecycle: 'active',
    location: 'project-root',
    name: 'Reliable terminal',
    nameTruncated: false,
    ownership: 'shared',
    primarySessionId: 'session-1',
    projectId: 'project-1',
    sessionCount: 1,
    taskId: 'task-1',
    taskMode: 'terminal',
    ...overrides,
  };
}

function session(overrides: Partial<RemoteTaskSessionRef> = {}): RemoteTaskSessionRef {
  return {
    generation: 1,
    kind: 'shell',
    orderKey: '0001',
    sessionId: 'session-1',
    state: 'running',
    taskId: 'task-1',
    ...overrides,
  };
}

function catalog(status: TaskCatalogStoreSnapshot['status'] = 'ready'): TaskCatalogStoreSnapshot {
  const currentTask = task();
  const currentSession = session();
  const projection: TaskCatalogProjection = {
    agents: new Map(),
    catalogVersion: 2,
    projects: new Map([['project-1', project()]]),
    serverInstanceId: 'server-1',
    sessions: new Map([['session-1', currentSession]]),
    sessionsByTask: new Map([['task-1', [currentSession]]]),
    tasks: new Map([['task-1', currentTask]]),
  };
  return {
    projection,
    revision: 1,
    staleReason: status === 'stale' ? 'delta-gap' : null,
    status,
  };
}

describe('remote task-first experience', () => {
  beforeEach(() => {
    taskNotesState.discard.mockReset();
    taskNotesState.hasUnsaved.mockReset();
    taskNotesState.hasUnsaved.mockReturnValue(false);
  });

  it('announces and opens terminal-only project-root tasks', async () => {
    const onSelectTask = vi.fn();
    render(() => (
      <TaskList
        canCreate
        catalog={catalog()}
        connectionStatus="connected"
        onCreate={vi.fn()}
        onEditSessionName={vi.fn()}
        onSelectTask={onSelectTask}
        sessionName="Phone"
      />
    ));

    expect(screen.getByLabelText('1 task visible')).toBeTruthy();
    expect(screen.getByText('Terminal only')).toBeTruthy();
    expect(screen.getByText('Project root')).toBeTruthy();
    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Reliable terminal. Running. Terminal-only task.',
      }),
    );
    expect(onSelectTask).toHaveBeenCalledWith('task-1');
  });

  it('retains the complete task projection while stale and exposes filtered empty status', async () => {
    render(() => (
      <TaskList
        canCreate={false}
        catalog={catalog('stale')}
        connectionStatus="connected"
        onCreate={vi.fn()}
        onEditSessionName={vi.fn()}
        onSelectTask={vi.fn()}
        sessionName="Phone"
      />
    ));

    expect(screen.getByText(/Task updates fell out of sync/u)).toBeTruthy();
    expect(screen.getByText('Reliable terminal')).toBeTruthy();
    await fireEvent.input(screen.getByRole('searchbox'), {
      target: { value: 'no-match' },
    });
    expect(screen.getByText('No tasks match this search.').getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('0 tasks visible')).toBeTruthy();
  });

  it('moves focus to task detail and reports failed session attachment without hiding truth', async () => {
    const importedTask = task({ location: 'existing-worktree', ownership: 'external' });
    const currentSession = session();
    const onOpenSession = vi.fn(() => false);
    render(() => (
      <TaskDetail
        onBack={vi.fn()}
        onOpenSession={onOpenSession}
        project={project()}
        sessions={[currentSession]}
        task={importedTask}
      />
    ));

    const heading = screen.getByRole('heading', { level: 1, name: 'Reliable terminal' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText('Imported')).toBeTruthy();
    expect(screen.getByLabelText('1 session')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Terminal. Running.' }));
    expect(onOpenSession).toHaveBeenCalledWith(currentSession);
    expect(screen.getByRole('status').textContent).toContain('could not be attached');
  });

  it('removes stale session actions while a task is closing', () => {
    render(() => (
      <TaskDetail
        onBack={vi.fn()}
        onOpenSession={vi.fn(() => true)}
        project={project()}
        sessions={[session()]}
        task={task({ lifecycle: 'closing' })}
      />
    ));

    expect(screen.getByText('Closing')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Open Terminal. Running.' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('lazily exposes read-only notes for terminal-only tasks', async () => {
    render(() => (
      <TaskDetail
        onBack={vi.fn()}
        onOpenSession={vi.fn(() => true)}
        project={project()}
        sessions={[session()]}
        task={task()}
        taskNotesCapability={{ read: true, write: false }}
      />
    ));

    expect(screen.queryByText(/Notes for Reliable terminal/u)).toBeNull();
    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    await vi.dynamicImportSettled();

    expect(screen.getByText('Notes for Reliable terminal (read only)')).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Notes' })).toBeTruthy();
  });

  it('keeps a dirty notes draft in place when task navigation is cancelled', async () => {
    const onBack = vi.fn();
    const confirm = vi.fn(() => false);
    taskNotesState.hasUnsaved.mockReturnValue(true);
    render(() => (
      <TaskDetail
        confirm={confirm}
        onBack={onBack}
        onOpenSession={vi.fn(() => true)}
        project={project()}
        sessions={[session()]}
        task={task()}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));

    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    await vi.dynamicImportSettled();
    const notesTab = screen.getByRole('tab', { name: 'Notes' });
    notesTab.focus();
    await fireEvent.keyDown(notesTab, { key: 'ArrowLeft' });
    await vi.dynamicImportSettled();

    expect(document.activeElement).toBe(notesTab);
    expect(notesTab.getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(screen.getByRole('button', { name: 'Back to tasks' }));
    await vi.dynamicImportSettled();

    expect(confirm).toHaveBeenCalledWith('Discard the unsaved notes draft and leave this task?');
    expect(onBack).not.toHaveBeenCalled();
    expect(taskNotesState.discard).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
  });

  it('supports keyboard navigation between Sessions and Notes tabs', async () => {
    render(() => (
      <TaskDetail
        onBack={vi.fn()}
        onOpenSession={vi.fn(() => true)}
        project={project()}
        sessions={[session()]}
        task={task()}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));

    const sessionsTab = screen.getByRole('tab', { name: 'Sessions' });
    sessionsTab.focus();
    await fireEvent.keyDown(sessionsTab, { key: 'ArrowRight' });

    expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
  });
});
