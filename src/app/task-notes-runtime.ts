import { warn as logWarn } from '../lib/log';
import { listenTaskNotesChanged } from '../lib/ipc-events';
import { publishTaskNotesInvalidation } from '../runtime/task-notes-invalidation';
import { DesktopTaskNotesRegistry } from '../components/task-notes/task-notes-registry';
import { desktopTaskNotesTransport } from './task-notes-transport';
import {
  EMPTY_DETACHED_DESKTOP_TASK_NOTES,
  publishDetachedDesktopTaskNotes,
  publishUnsavedDesktopTaskNotes,
  registerDesktopTaskNotesOwner,
  type DetachedDesktopTaskNotesDraft,
} from './task-notes-recovery-channel';

export type { DetachedDesktopTaskNotesDraft } from './task-notes-recovery-channel';

let mountedEditors = 0;
let stopListening: (() => void) | null = null;
let currentTaskIds: ReadonlySet<string> | null = null;
const detachedStatusChecks = new Set<string>();
const pendingTaskNames = new Map<string, string>();
const taskNames = new Map<string, string>();
const recoveryEligibleTaskIds = new Set<string>();
const unsavedTaskIds = new Set<string>();

function isRecoveryEligible(taskId: string): boolean {
  if (!currentTaskIds || !unsavedTaskIds.has(taskId)) return false;
  if (!currentTaskIds.has(taskId)) return true;
  const state = desktopTaskNotesRegistry.get(taskId)?.state;
  return (
    !desktopTaskNotesRegistry.isMounted(taskId) &&
    state?.kind === 'orphaned' &&
    state.reason === 'task-replaced'
  );
}

function handleRegistryEntryChange(taskId: string): void {
  const wasUnsaved = unsavedTaskIds.has(taskId);
  const isUnsaved = desktopTaskNotesRegistry.hasUnsaved(taskId);
  if (isUnsaved) unsavedTaskIds.add(taskId);
  else unsavedTaskIds.delete(taskId);
  const state = desktopTaskNotesRegistry.get(taskId)?.state;
  if (!isUnsaved && state?.kind !== 'orphaned') {
    const pendingTaskName = pendingTaskNames.get(taskId);
    if (pendingTaskName) taskNames.set(taskId, pendingTaskName);
    pendingTaskNames.delete(taskId);
  }
  if (wasUnsaved !== isUnsaved) publishUnsavedDesktopTaskNotes([...unsavedTaskIds]);

  const eligible = isRecoveryEligible(taskId);
  if (wasUnsaved !== isUnsaved || eligible || recoveryEligibleTaskIds.has(taskId) !== eligible) {
    notifyRecoveryListeners();
  }
}

export const desktopTaskNotesRegistry = new DesktopTaskNotesRegistry({
  onEntryChange: handleRegistryEntryChange,
  onInvariantViolation: (code) => logWarn('notes', 'Task notes invariant violation', { code }),
});

export function mountDesktopTaskNotes(taskId: string, taskName?: string) {
  const existing = desktopTaskNotesRegistry.get(taskId);
  const preserveExistingName =
    existing !== undefined && (existing.hasUnsavedChanges || existing.state.kind === 'orphaned');
  const mounted = desktopTaskNotesRegistry.mount(taskId, desktopTaskNotesTransport);
  try {
    if (mountedEditors === 0) {
      stopListening = listenTaskNotesChanged((notification) => {
        publishTaskNotesInvalidation(notification);
      });
    }
    mountedEditors += 1;
    if (taskName) {
      if (preserveExistingName) pendingTaskNames.set(taskId, taskName);
      else {
        taskNames.set(taskId, taskName);
        pendingTaskNames.delete(taskId);
      }
    }
  } catch (error) {
    mounted.release();
    throw error;
  }
  let released = false;
  return {
    controller: mounted.controller,
    release: () => {
      if (released) return;
      released = true;
      mounted.release();
      mountedEditors = Math.max(0, mountedEditors - 1);
      if (mountedEditors === 0) {
        const stop = stopListening;
        stopListening = null;
        stop?.();
      }
    },
  };
}

/** Call only after canonical task removal has committed. */
function retireDesktopTaskNotes(taskId: string): void {
  desktopTaskNotesRegistry.remove(taskId);
  taskNames.delete(taskId);
  pendingTaskNames.delete(taskId);
  detachedStatusChecks.delete(taskId);
  notifyRecoveryListeners();
}

function reconcileDesktopTaskNotesTasks(taskIds: readonly string[]): void {
  const nextTaskIds = new Set(taskIds);
  currentTaskIds = nextTaskIds;
  for (const taskId of unsavedTaskIds) {
    if (nextTaskIds.has(taskId)) {
      detachedStatusChecks.delete(taskId);
      continue;
    }
    if (!detachedStatusChecks.has(taskId)) {
      detachedStatusChecks.add(taskId);
      desktopTaskNotesRegistry.get(taskId)?.checkStatus();
    }
  }
  notifyRecoveryListeners();
}

function discardRecoveredDesktopTaskNotes(taskId: string): void {
  desktopTaskNotesRegistry.discard(taskId);
  if (!desktopTaskNotesRegistry.get(taskId)) taskNames.delete(taskId);
  if (!desktopTaskNotesRegistry.get(taskId)) pendingTaskNames.delete(taskId);
  detachedStatusChecks.delete(taskId);
  notifyRecoveryListeners();
}

function listDetachedDesktopTaskNotes(): readonly DetachedDesktopTaskNotesDraft[] {
  if (!currentTaskIds) return EMPTY_DETACHED_DESKTOP_TASK_NOTES;
  const drafts: DetachedDesktopTaskNotesDraft[] = [];
  for (const taskId of unsavedTaskIds) {
    if (!isRecoveryEligible(taskId)) continue;
    drafts.push({
      draft: desktopTaskNotesRegistry.get(taskId)?.state.draft ?? '',
      taskId,
      taskName: taskNames.get(taskId) ?? taskId,
    });
  }
  return drafts.length === 0 ? EMPTY_DETACHED_DESKTOP_TASK_NOTES : drafts;
}

function notifyRecoveryListeners(): void {
  const drafts = listDetachedDesktopTaskNotes();
  recoveryEligibleTaskIds.clear();
  for (const draft of drafts) recoveryEligibleTaskIds.add(draft.taskId);
  publishDetachedDesktopTaskNotes(drafts);
}

registerDesktopTaskNotesOwner({
  discardRecovered: discardRecoveredDesktopTaskNotes,
  reconcileTasks: reconcileDesktopTaskNotesTasks,
  retireRemovedTask: retireDesktopTaskNotes,
});
