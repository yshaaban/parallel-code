import {
  TASK_NOTES_MAX_ACKNOWLEDGEMENTS,
  type AcknowledgedTaskNotesOperation,
} from '../../domain/task-notes';
import { subscribeTaskNotesInvalidation } from '../../runtime/task-notes-invalidation';
import { TaskNotesController, type TaskNotesControllerOptions } from './task-notes-controller';
import type { TaskNotesTransport } from './task-notes-transport';

interface RegistryEntry {
  controller: TaskNotesController;
  mounts: number;
  unsubscribe: () => void;
}

export interface MountedTaskNotesController {
  controller: TaskNotesController;
  release: () => void;
}

export interface TaskNotesRegistryOptions {
  beforeUnloadTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  onInvariantViolation?: (code: string) => void;
  onNavigateTaskList?: (taskId: string) => void;
  sourceId?: string | null;
}

export class TaskNotesRegistry {
  protected readonly entries = new Map<string, RegistryEntry>();
  private acknowledgements: readonly AcknowledgedTaskNotesOperation[] = [];
  private unloadListening = false;
  private readonly unloadTarget: TaskNotesRegistryOptions['beforeUnloadTarget'];

  constructor(private readonly options: TaskNotesRegistryOptions = {}) {
    this.unloadTarget =
      options.beforeUnloadTarget === undefined
        ? typeof window === 'undefined'
          ? null
          : window
        : options.beforeUnloadTarget;
  }

  mount(taskId: string, transport: TaskNotesTransport): MountedTaskNotesController {
    let entry = this.entries.get(taskId);
    if (!entry) {
      const controllerOptions: TaskNotesControllerOptions = {
        confirmAcknowledgements: (operations) => this.confirmAcknowledgements(operations),
        enqueueAcknowledgement: (operation) => this.enqueueAcknowledgement(operation),
        getAcknowledgements: () => this.acknowledgements.slice(0, TASK_NOTES_MAX_ACKNOWLEDGEMENTS),
        subscribeInvalidation: subscribeTaskNotesInvalidation,
        ...(this.options.onInvariantViolation
          ? { onInvariantViolation: this.options.onInvariantViolation }
          : {}),
        ...(this.options.onNavigateTaskList
          ? { onNavigateTaskList: this.options.onNavigateTaskList }
          : {}),
        ...(this.options.sourceId !== undefined ? { sourceId: this.options.sourceId } : {}),
      };
      const controller = new TaskNotesController(taskId, transport, controllerOptions);
      entry = { controller, mounts: 0, unsubscribe: () => undefined };
      this.entries.set(taskId, entry);
      entry.unsubscribe = controller.subscribe(() => {
        this.syncUnloadGuard();
        this.entryChanged(taskId);
      });
    }
    entry.mounts += 1;
    entry.controller.attach();
    this.entryChanged(taskId);
    let released = false;
    return {
      controller: entry.controller,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(taskId);
        if (!current) return;
        current.mounts = Math.max(0, current.mounts - 1);
        current.controller.detach();
        this.entryChanged(taskId);
      },
    };
  }

  get(taskId: string): TaskNotesController | undefined {
    return this.entries.get(taskId)?.controller;
  }

  hasUnsaved(taskId?: string): boolean {
    if (taskId !== undefined)
      return this.entries.get(taskId)?.controller.hasUnsavedChanges ?? false;
    return [...this.entries.values()].some((entry) => entry.controller.hasUnsavedChanges);
  }

  /** Revalidate only editors that are visible; detached drafts keep their local recovery state. */
  refreshMounted(): void {
    for (const entry of this.entries.values()) {
      if (entry.mounts > 0) entry.controller.checkStatus();
    }
  }

  /** Permanently release controller state after the task has been structurally removed. */
  remove(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    entry.unsubscribe();
    entry.controller.dispose();
    this.entries.delete(taskId);
    this.syncUnloadGuard();
    this.entryChanged(taskId);
  }

  private enqueueAcknowledgement(operation: AcknowledgedTaskNotesOperation): void {
    if (
      this.acknowledgements.some(
        (candidate) =>
          candidate.operationId === operation.operationId &&
          candidate.operationCapability === operation.operationCapability,
      )
    ) {
      return;
    }
    if (this.acknowledgements.length >= TASK_NOTES_MAX_ACKNOWLEDGEMENTS) {
      this.options.onInvariantViolation?.('acknowledgement-queue-overflow');
      return;
    }
    this.acknowledgements = [...this.acknowledgements, operation];
  }

  private confirmAcknowledgements(operations: readonly AcknowledgedTaskNotesOperation[]): void {
    if (operations.length === 0) return;
    this.acknowledgements = this.acknowledgements.filter(
      (candidate) =>
        !operations.some(
          (operation) =>
            operation.operationId === candidate.operationId &&
            operation.operationCapability === candidate.operationCapability,
        ),
    );
  }

  protected entryChanged(_taskId: string): void {}

  private readonly handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.hasUnsaved()) return;
    event.preventDefault();
    event.returnValue = '';
  };

  protected syncUnloadGuard(): void {
    const shouldListen = this.hasUnsaved();
    if (shouldListen === this.unloadListening || !this.unloadTarget) return;
    if (shouldListen) {
      this.unloadTarget.addEventListener('beforeunload', this.handleBeforeUnload as EventListener);
      this.unloadListening = true;
    } else this.removeUnloadGuard();
  }

  protected removeUnloadGuard(): void {
    if (!this.unloadListening || !this.unloadTarget) return;
    this.unloadTarget.removeEventListener('beforeunload', this.handleBeforeUnload as EventListener);
    this.unloadListening = false;
  }
}

export interface DesktopTaskNotesRegistryOptions extends TaskNotesRegistryOptions {
  onEntryChange: (taskId: string) => void;
}

export class DesktopTaskNotesRegistry extends TaskNotesRegistry {
  constructor(private readonly desktopOptions: DesktopTaskNotesRegistryOptions) {
    super(desktopOptions);
  }

  isMounted(taskId: string): boolean {
    return (this.entries.get(taskId)?.mounts ?? 0) > 0;
  }

  discard(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    if (entry.mounts > 0) {
      entry.controller.discard();
      return;
    }
    entry.unsubscribe();
    entry.controller.dispose();
    this.entries.delete(taskId);
    this.syncUnloadGuard();
    this.entryChanged(taskId);
  }

  dispose(): void {
    const taskIds = [...this.entries.keys()];
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.controller.dispose();
    }
    this.entries.clear();
    this.removeUnloadGuard();
    for (const taskId of taskIds) this.entryChanged(taskId);
  }

  protected override entryChanged(taskId: string): void {
    this.desktopOptions.onEntryChange(taskId);
  }
}
