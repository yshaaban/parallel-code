import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { mountDesktopTaskNotes } from '../../app/task-notes-runtime';
import type {
  TaskNotesController,
  TaskNotesControllerSnapshot,
} from '../task-notes/task-notes-controller';
import { TypedTaskNotesEditor } from './TypedTaskNotesEditor';

function clean(taskId = 'task-1', text = ''): TaskNotesControllerSnapshot {
  return {
    savedNoticeVisible: false,
    slowSaving: false,
    state: {
      kind: 'clean',
      taskId,
      generation: 1,
      draft: text,
      base: {
        taskId,
        taskIncarnation: 'A'.repeat(43),
        contentVersion: 'A'.repeat(43),
        notes: text,
        workspaceRevision: 1,
      },
    },
  };
}

function fixture(initial: TaskNotesControllerSnapshot) {
  let listener: ((value: TaskNotesControllerSnapshot) => void) | undefined;
  const controller = {
    edit: vi.fn(),
    save: vi.fn(),
    retry: vi.fn(),
    checkStatus: vi.fn(),
    overwrite: vi.fn(),
    useLatest: vi.fn(),
    subscribe: vi.fn((next: typeof listener) => {
      listener = next;
      next?.(initial);
      return vi.fn();
    }),
  };
  const release = vi.fn();
  return {
    controller,
    release,
    emit: (next: TaskNotesControllerSnapshot) => listener?.(next),
    mount: (() => ({
      controller: controller as unknown as TaskNotesController,
      release,
    })) as typeof mountDesktopTaskNotes,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TypedTaskNotesEditor', () => {
  it('keeps empty read-only notes compact without useless copy/select actions', () => {
    const owner = fixture(clean());
    const result = render(() => (
      <TypedTaskNotesEditor
        taskId="task-1"
        capability={{ read: true, write: false }}
        mountTaskNotes={owner.mount}
        onDraftChange={() => {}}
        setNotesRef={() => {}}
      />
    ));
    expect(result.getByText('Read-only in this session')).toBeTruthy();
    expect(result.queryByRole('button', { name: /copy|select/i })).toBeNull();
    const editor = result.getByRole('textbox') as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(editor.disabled).toBe(false);
    fireEvent.input(editor, { target: { value: 'Not writable' } });
    expect(owner.controller.edit).not.toHaveBeenCalled();
  });

  it('preserves actual error/conflict guidance under read-only capability and never retries a write', () => {
    const base = clean('task-1', 'Local draft');
    const owner = fixture({
      ...base,
      state: { ...base.state, kind: 'error', reason: 'notes-unavailable', recovery: 'retry-load' },
    } as TaskNotesControllerSnapshot);
    const result = render(() => (
      <TypedTaskNotesEditor
        taskId="task-1"
        capability={{ read: true, write: false }}
        mountTaskNotes={owner.mount}
        onDraftChange={() => {}}
        setNotesRef={() => {}}
      />
    ));
    expect(result.getByText('Task notes are temporarily unavailable.')).toBeTruthy();
    expect(result.queryByText('Read-only in this session')).toBeNull();
    expect(result.queryByRole('button', { name: 'Retry' })).toBeNull();
    owner.controller.checkStatus.mockImplementation(() => owner.emit(base));
    result.getByRole('button', { name: 'Check status' }).click();
    expect(owner.controller.checkStatus).toHaveBeenCalledOnce();
    expect(owner.controller.retry).not.toHaveBeenCalled();
    expect(result.queryByText('Task notes are temporarily unavailable.')).toBeNull();
    expect((result.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Local draft');
    owner.emit({
      ...base,
      state: {
        ...base.state,
        kind: 'conflict',
        external: base.state.kind === 'clean' ? base.state.base : undefined,
      },
    } as TaskNotesControllerSnapshot);
    expect(result.getByText('Notes changed on another device')).toBeTruthy();
    const overwrite = result.getByRole('button', { name: 'Overwrite' }) as HTMLButtonElement;
    expect(overwrite.disabled).toBe(true);
    overwrite.click();
    expect(owner.controller.overwrite).not.toHaveBeenCalled();
  });

  it('drops old subscription callbacks and autosaves when a mounted editor changes tasks', async () => {
    vi.useFakeTimers();
    const first = fixture(clean('task-1', 'First'));
    const second = fixture(clean('task-2', 'Second'));
    const [taskId, setTaskId] = createSignal('task-1');
    const onDraftChange = vi.fn();
    const result = render(() => (
      <TypedTaskNotesEditor
        taskId={taskId()}
        capability={{ read: true, write: true }}
        mountTaskNotes={(id) => (id === 'task-1' ? first : second).mount(id)}
        onDraftChange={onDraftChange}
        setNotesRef={() => {}}
      />
    ));
    first.emit({
      ...clean('task-1', 'Pending'),
      state: { ...clean('task-1', 'Pending').state, kind: 'dirty' },
    } as TaskNotesControllerSnapshot);
    setTaskId('task-2');
    first.emit(clean('task-1', 'Stale callback'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((result.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second');
    expect(onDraftChange).toHaveBeenLastCalledWith('Second');
    expect(first.controller.save).not.toHaveBeenCalled();
    expect(second.controller.save).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledOnce();
  });

  it('does not select a different task when an old clipboard request fails', async () => {
    let fail!: () => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              fail = () => reject(new Error('Denied'));
            }),
        ),
      },
    });
    const first = fixture(clean('task-1', 'First'));
    const second = fixture(clean('task-2', 'Second'));
    const [taskId, setTaskId] = createSignal('task-1');
    const result = render(() => (
      <>
        <button>Other control</button>
        <TypedTaskNotesEditor
          taskId={taskId()}
          capability={{ read: true, write: false }}
          mountTaskNotes={(id) => (id === 'task-1' ? first : second).mount(id)}
          onDraftChange={() => {}}
          setNotesRef={() => {}}
        />
      </>
    ));
    result.getByRole('button', { name: 'Copy draft' }).click();
    setTaskId('task-2');
    const other = result.getByRole('button', { name: 'Other control' });
    other.focus();
    fail();
    await Promise.resolve();
    expect(document.activeElement).toBe(other);
    expect((result.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second');
  });

  it('does not select a newer draft from the same controller after a stale clipboard failure', async () => {
    let fail!: () => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              fail = () => reject(new Error('Denied'));
            }),
        ),
      },
    });
    const owner = fixture(clean('task-1', 'First'));
    const result = render(() => (
      <>
        <button>Other control</button>
        <TypedTaskNotesEditor
          taskId="task-1"
          capability={{ read: true, write: false }}
          mountTaskNotes={owner.mount}
          onDraftChange={() => {}}
          setNotesRef={() => {}}
        />
      </>
    ));
    result.getByRole('button', { name: 'Copy draft' }).click();
    owner.emit(clean('task-1', 'Newer draft'));
    const other = result.getByRole('button', { name: 'Other control' });
    other.focus();
    fail();
    await Promise.resolve();
    expect(document.activeElement).toBe(other);
  });
});
