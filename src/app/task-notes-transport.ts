import { IPC } from '../../electron/ipc/channels';
import {
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationWireResponse,
  isUpdateTaskNotesWireResponse,
} from '../domain/task-notes';
import { invoke, invokeOnce, invokeWithAbortSignal } from '../lib/ipc';
import type { TaskNotesTransport } from '../components/task-notes/task-notes-transport';

function requireResponse<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T {
  if (!guard(value)) throw new Error('Invalid task-notes response');
  return value;
}

export const desktopTaskNotesTransport: TaskNotesTransport = {
  async get(request, signal) {
    return requireResponse(
      await invokeWithAbortSignal(IPC.GetTaskNotes, signal, request),
      isGetTaskNotesWireResponse,
    );
  },
  async issue(request) {
    return requireResponse(
      await invokeOnce(IPC.IssueTaskNotesOperation, request),
      isIssueTaskNotesOperationWireResponse,
    );
  },
  async update(request) {
    return requireResponse(
      await invoke(IPC.UpdateTaskNotes, request),
      isUpdateTaskNotesWireResponse,
    );
  },
};
