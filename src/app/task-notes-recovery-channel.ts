export interface DetachedDesktopTaskNotesDraft {
  draft: string;
  taskId: string;
  taskName: string;
}

type DraftListener = (drafts: readonly DetachedDesktopTaskNotesDraft[]) => void;
type UnsavedListener = (unsaved: boolean) => void;

interface DesktopTaskNotesOwner {
  discardRecovered: (taskId: string) => void;
  reconcileTasks: (taskIds: readonly string[]) => void;
  retireRemovedTask: (taskId: string) => void;
}

export interface DesktopTaskNotesRemovalAdmissionOptions {
  confirmed?: boolean;
  confirmDiscard: (message: string) => boolean | Promise<boolean>;
  message?: string;
}

export const DESKTOP_TASK_NOTES_REMOVAL_WARNING =
  'This action will remove the task and discard its unsaved task notes. Continue?';

export const EMPTY_DETACHED_DESKTOP_TASK_NOTES: readonly DetachedDesktopTaskNotesDraft[] =
  Object.freeze([]);
let currentDrafts = EMPTY_DETACHED_DESKTOP_TASK_NOTES;
let currentTaskIds: readonly string[] = [];
let taskNotesOwner: DesktopTaskNotesOwner | null = null;
const draftListeners = new Set<DraftListener>();
const unsavedListeners = new Map<string, Set<UnsavedListener>>();
const unsavedTaskIds = new Set<string>();

export function publishDesktopTaskIds(taskIds: readonly string[]): void {
  currentTaskIds = taskIds;
  taskNotesOwner?.reconcileTasks(taskIds);
}

export function registerDesktopTaskNotesOwner(owner: DesktopTaskNotesOwner): () => void {
  taskNotesOwner = owner;
  owner.reconcileTasks(currentTaskIds);
  return () => {
    if (taskNotesOwner === owner) taskNotesOwner = null;
  };
}

export function publishUnsavedDesktopTaskNotes(taskIds: readonly string[]): void {
  const nextTaskIds = new Set(taskIds);
  const changedTaskIds = new Set<string>();
  for (const taskId of unsavedTaskIds) {
    if (!nextTaskIds.has(taskId)) changedTaskIds.add(taskId);
  }
  for (const taskId of nextTaskIds) {
    if (!unsavedTaskIds.has(taskId)) changedTaskIds.add(taskId);
  }
  unsavedTaskIds.clear();
  for (const taskId of nextTaskIds) unsavedTaskIds.add(taskId);
  for (const taskId of changedTaskIds) {
    const unsaved = unsavedTaskIds.has(taskId);
    for (const listener of unsavedListeners.get(taskId) ?? []) listener(unsaved);
  }
}

export function hasUnsavedDesktopTaskNotes(taskId: string): boolean {
  return unsavedTaskIds.has(taskId);
}

export function subscribeDesktopTaskNotesUnsaved(
  taskId: string,
  listener: UnsavedListener,
): () => void {
  let listeners = unsavedListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    unsavedListeners.set(taskId, listeners);
  }
  listeners.add(listener);
  listener(unsavedTaskIds.has(taskId));
  return () => {
    const current = unsavedListeners.get(taskId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) unsavedListeners.delete(taskId);
  };
}

export async function admitDesktopTaskNotesRemoval(
  taskId: string,
  options: DesktopTaskNotesRemovalAdmissionOptions,
): Promise<boolean> {
  if (!unsavedTaskIds.has(taskId) || options.confirmed) return true;
  return options.confirmDiscard(options.message ?? DESKTOP_TASK_NOTES_REMOVAL_WARNING);
}

export function completeDesktopTaskNotesRemoval(taskId: string): void {
  taskNotesOwner?.retireRemovedTask(taskId);
}

export function discardRecoveredDesktopTaskNotes(taskId: string): void {
  taskNotesOwner?.discardRecovered(taskId);
}

export function publishDetachedDesktopTaskNotes(
  drafts: readonly DetachedDesktopTaskNotesDraft[],
): void {
  const nextDrafts = drafts.length === 0 ? EMPTY_DETACHED_DESKTOP_TASK_NOTES : drafts;
  if (
    currentDrafts.length === nextDrafts.length &&
    currentDrafts.every((draft, index) => {
      const next = nextDrafts[index];
      if (!next) return false;
      return (
        draft.taskId === next.taskId &&
        draft.taskName === next.taskName &&
        draft.draft === next.draft
      );
    })
  ) {
    return;
  }
  currentDrafts = nextDrafts;
  for (const listener of draftListeners) listener(nextDrafts);
}

export function subscribeDetachedDesktopTaskNotesChannel(listener: DraftListener): () => void {
  draftListeners.add(listener);
  listener(currentDrafts);
  return () => draftListeners.delete(listener);
}
