import {
  readTaskMergeOwnerCutoverState,
  TaskMergeOwnerCutoverError,
  type TaskMergeLegacyWriterCutover,
} from './task-merge-operation-issuer.js';
import { unchanged, type WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';

export class TaskMergeLegacyWriterDisabledError extends Error {
  readonly code = 'task-merge-legacy-writer-disabled';

  constructor() {
    super('The legacy task merge writer is disabled');
  }
}

/**
 * Process-local admission plus a durable restart barrier for the legacy merge
 * handler. A cutover first closes new admissions, waits for every admitted
 * legacy merge to finish, and only then lets the backend owner activate.
 */
export class WorkspaceTaskMergeLegacyWriterGate implements TaskMergeLegacyWriterCutover {
  private disabledEpoch: string | null = null;
  private inFlight = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly authority: WorkspacePrivateMutationAuthority) {}

  async runLegacyMerge<TResult>(effect: () => Promise<TResult>): Promise<TResult> {
    const release = this.beginAdmission();
    try {
      const durableCutover = await this.readDurableCutover();
      if (durableCutover || this.disabledEpoch !== null) {
        throw new TaskMergeLegacyWriterDisabledError();
      }
      return await effect();
    } finally {
      release();
    }
  }

  async disableLegacyMergeWriters(cutoverEpoch: string): Promise<void> {
    if (!isCutoverEpoch(cutoverEpoch)) {
      throw new TaskMergeOwnerCutoverError('Task merge cutover epoch is invalid');
    }
    if (this.disabledEpoch !== null && this.disabledEpoch !== cutoverEpoch) {
      throw new TaskMergeOwnerCutoverError('Task merge cutover epoch changed');
    }
    this.disabledEpoch = cutoverEpoch;
    await this.waitForDrain();
  }

  async verifyLegacyMergeWritersDisabled(cutoverEpoch: string): Promise<void> {
    await this.disableLegacyMergeWriters(cutoverEpoch);
    const durableCutover = await this.readDurableCutover();
    if (!durableCutover || durableCutover.cutoverEpoch !== cutoverEpoch) {
      throw new TaskMergeOwnerCutoverError('Task merge cutover is not durably prepared');
    }
  }

  private beginAdmission(): () => void {
    if (this.disabledEpoch !== null) {
      throw new TaskMergeLegacyWriterDisabledError();
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  private async readDurableCutover() {
    const result = await this.authority.mutate(
      { operation: 'read-task-merge-legacy-writer-cutover' },
      (slices) => unchanged(readTaskMergeOwnerCutoverState(slices.privateState)),
    );
    return result.result;
  }

  private waitForDrain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }
}

function isCutoverEpoch(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}
