export type RemoteTaskNotesCatalogLifecycle =
  | {
      catalogVersion: number;
      serverInstanceId: string;
      taskClosing: boolean;
      taskState: 'present';
    }
  | {
      catalogVersion: number;
      serverInstanceId: string;
      taskClosing: false;
      taskState: 'removed';
    };

type RemoteTaskNotesLifecycleOwner = (
  taskId: string,
  lifecycle: RemoteTaskNotesCatalogLifecycle,
) => boolean;

let owner: RemoteTaskNotesLifecycleOwner | null = null;

export function registerRemoteTaskNotesLifecycleOwner(
  nextOwner: RemoteTaskNotesLifecycleOwner,
): void {
  owner = nextOwner;
}

export function reconcileRemoteTaskNotesCatalogLifecycle(
  taskId: string,
  lifecycle: RemoteTaskNotesCatalogLifecycle,
): boolean {
  return owner?.(taskId, lifecycle) ?? false;
}
