import { IPC } from '../../electron/ipc/channels';
import { isTaskNotesCapability, type TaskNotesCapability } from '../domain/task-notes';
import { invokeOnce } from '../lib/ipc';
import { createTaskNotesCapability, DESKTOP_TASK_NOTES_CAPABILITY } from './task-notes-capability';

let advertisedDesktopCapability: Readonly<TaskNotesCapability> | undefined;
let desktopCapabilityRequest: Promise<Readonly<TaskNotesCapability>> | undefined;

/** The immutable backend composition advertises whether this exact desktop artifact may write. */
export function loadDesktopTaskNotesCapability(): Promise<Readonly<TaskNotesCapability>> {
  if (advertisedDesktopCapability) return Promise.resolve(advertisedDesktopCapability);
  desktopCapabilityRequest ??= invokeOnce(IPC.GetTaskNotesCapability)
    .then((value) =>
      isTaskNotesCapability(value)
        ? (advertisedDesktopCapability = createTaskNotesCapability(value.read, value.write))
        : DESKTOP_TASK_NOTES_CAPABILITY,
    )
    .catch(() => DESKTOP_TASK_NOTES_CAPABILITY)
    .finally(() => {
      desktopCapabilityRequest = undefined;
    });
  return desktopCapabilityRequest;
}
