import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GetTaskNotesResult,
  IssueTaskNotesOperationResult,
  TaskNotesSnapshot,
  TaskNotesWireResponse,
  UpdateTaskNotesResult,
} from '../domain/task-notes';
import { TaskNotesRegistry } from '../components/task-notes/task-notes-registry';
import type { TaskNotesTransport } from '../components/task-notes/task-notes-transport';
import { TaskNotesView } from './TaskNotesView';

const TOKEN = 'A'.repeat(43);
const TOKEN_2 = `${'E'.repeat(42)}A`;
const SERVER_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

function snapshot(overrides: Partial<TaskNotesSnapshot> = {}): TaskNotesSnapshot {
  return {
    taskId: 'task-1',
    taskIncarnation: TOKEN,
    notes: 'base',
    contentVersion: TOKEN,
    workspaceRevision: 1,
    ...overrides,
  };
}

function loaded(value = snapshot()): GetTaskNotesResult {
  return {
    kind: 'loaded',
    current: {
      relation: 'same-incarnation',
      currentNotes: { kind: 'present', snapshot: value },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: value.workspaceRevision,
        taskState: 'present',
        taskClosing: false,
        taskIncarnation: value.taskIncarnation,
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => (resolve = next));
  return { promise, resolve };
}

function ok<T>(result: T): TaskNotesWireResponse<T> {
  return { ok: true, result };
}

afterEach(() => cleanup());

describe('TaskNotesView', () => {
  it('edits locally and saves only after the explicit mobile Save action', async () => {
    const update = deferred<TaskNotesWireResponse<UpdateTaskNotesResult>>();
    const saved = snapshot({ notes: 'first draft', contentVersion: TOKEN_2, workspaceRevision: 2 });
    const transport: TaskNotesTransport = {
      get: vi.fn(async () => ok(loaded())),
      issue: vi.fn(async () =>
        ok({
          kind: 'issued',
          operation: {
            operationId: 'A'.repeat(22),
            operationCapability: TOKEN,
            admitUntil: '2026-08-03T10:10:00.000Z',
            replayUntil: '2026-08-04T10:00:00.000Z',
          },
        } satisfies IssueTaskNotesOperationResult),
      ),
      update: vi.fn(() => update.promise),
    };
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));

    const editor = await screen.findByRole('textbox', { name: 'Task notes' });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('base'));
    fireEvent.input(editor, { target: { value: 'first draft' } });
    expect(transport.issue).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.update).toHaveBeenCalledWith(
        expect.objectContaining({ notes: 'first draft' }),
      ),
    );
    fireEvent.input(editor, { target: { value: 'second draft' } });
    expect((editor as HTMLTextAreaElement).value).toBe('second draft');

    update.resolve({
      ok: true,
      result: {
        kind: 'completed',
        originalOutcome: {
          kind: 'saved',
          changed: true,
          committedContentVersion: TOKEN_2,
          committedWorkspaceRevision: 2,
        },
        current: (loaded(saved) as Extract<GetTaskNotesResult, { kind: 'loaded' }>).current,
        replayed: false,
        effectiveRetireAfter: '2026-08-04T10:00:00.000Z',
      },
    });
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeTruthy());
    expect((editor as HTMLTextAreaElement).value).toBe('second draft');
  });

  it('keeps the recovery description target present while recovery actions load', async () => {
    const transport: TaskNotesTransport = {
      get: vi.fn(async () => ok(loaded())),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));

    const editor = (await screen.findByRole('textbox', {
      name: 'Task notes',
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('base'));
    fireEvent.input(editor, { target: { value: 'recover me' } });
    registry.get('task-1')?.applyLifecycle({
      catalogVersion: 2,
      serverInstanceId: SERVER_INSTANCE_ID,
      taskClosing: false,
      taskState: 'removed',
    });

    const fallback = screen.getByText('Loading recovery actions…');
    expect(fallback.id).not.toBe('');
    expect(editor.getAttribute('aria-describedby')).toBe(fallback.id);
  });

  it('shows external notes for review without replacing a dirty draft', async () => {
    const transport: TaskNotesTransport = {
      get: vi
        .fn<TaskNotesTransport['get']>()
        .mockResolvedValueOnce({ ok: true, result: loaded() })
        .mockResolvedValueOnce({
          ok: true,
          result: loaded(
            snapshot({ notes: 'remote note', contentVersion: TOKEN_2, workspaceRevision: 2 }),
          ),
        }),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));
    const editor = await screen.findByRole('textbox', { name: 'Task notes' });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('base'));
    fireEvent.input(editor, { target: { value: 'local draft' } });
    registry
      .get('task-1')
      ?.invalidate({ taskId: 'task-1', workspaceRevision: 2, sourceId: 'peer' });

    await screen.findByText('Changed elsewhere');
    expect((editor as HTMLTextAreaElement).value).toBe('local draft');
    const latestHeading = await screen.findByRole('heading', { name: 'Notes changed elsewhere' });
    await waitFor(() => expect(document.activeElement).toBe(latestHeading));
    const reviewButton = await screen.findByRole('button', { name: 'Review latest' });
    expect(reviewButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(reviewButton);
    expect(reviewButton.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('remote note')).toBeTruthy();
  });

  it('keeps capability-read-only notes enabled for keyboard selection', async () => {
    const transport: TaskNotesTransport = {
      get: vi.fn(async () => ok(loaded())),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite={false}
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));

    const editor = (await screen.findByRole('textbox', {
      name: 'Task notes',
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('base'));
    expect(editor.disabled).toBe(false);
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText(/read-only in this session/i)).toBeTruthy();
  });

  it('preserves an orphaned draft in a focusable copy-and-select recovery editor', async () => {
    const transport: TaskNotesTransport = {
      get: vi.fn(async () => ok(loaded())),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));

    const editor = (await screen.findByRole('textbox', {
      name: 'Task notes',
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('base'));
    fireEvent.input(editor, { target: { value: 'recover me' } });
    registry.get('task-1')?.applyLifecycle({
      catalogVersion: 2,
      serverInstanceId: SERVER_INSTANCE_ID,
      taskClosing: false,
      taskState: 'removed',
    });

    await screen.findByText('Task was deleted—copy your draft');
    expect(editor.disabled).toBe(false);
    expect(editor.readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe('recover me'.length);
  });

  it('can deliberately discard a replaced-task draft and load the current task incarnation', async () => {
    const transport: TaskNotesTransport = {
      get: vi
        .fn<TaskNotesTransport['get']>()
        .mockResolvedValueOnce(ok(loaded()))
        .mockResolvedValueOnce(
          ok(
            loaded(
              snapshot({
                notes: 'replacement notes',
                taskIncarnation: TOKEN_2,
                workspaceRevision: 3,
              }),
            ),
          ),
        ),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const confirm = vi.fn(() => true);
    const registry = new TaskNotesRegistry({ beforeUnloadTarget: null });
    render(() => (
      <TaskNotesView
        canWrite
        confirm={confirm}
        mount={(taskId) => registry.mount(taskId, transport)}
        onChooseAnotherTask={() => {}}
        taskId="task-1"
        taskName="Test task"
      />
    ));

    const editor = (await screen.findByRole('textbox', {
      name: 'Task notes',
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('base'));
    fireEvent.input(editor, { target: { value: 'old incarnation draft' } });
    registry.get('task-1')?.applyLifecycle({
      catalogVersion: 2,
      serverInstanceId: SERVER_INSTANCE_ID,
      taskClosing: false,
      taskIncarnation: TOKEN_2,
      taskState: 'present',
    });

    await screen.findByText('Task was replaced—copy your draft');
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft and reload' }));

    expect(confirm).toHaveBeenCalledWith(
      'Discard the recovered draft and load notes for the current task?',
    );
    await waitFor(() => expect(editor.value).toBe('replacement notes'));
    expect(document.activeElement).toBe(editor);
    expect(editor.readOnly).toBe(false);
    expect(transport.get).toHaveBeenCalledTimes(2);
  });
});
