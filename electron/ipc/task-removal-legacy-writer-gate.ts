export class TaskRemovalLegacyWriterDisabledError extends Error {
  readonly code = 'task-removal-legacy-writer-disabled';

  constructor() {
    super('The legacy task removal writer is disabled');
  }
}

/**
 * Process-local cutover barrier for ordinary close/delete routes. Failed-creation rollback keeps
 * using the lower-level cleanup primitive directly because it never owns canonical task membership.
 */
export class WorkspaceTaskRemovalLegacyWriterGate {
  private disabledEpoch: string | null = null;
  private inFlight = 0;
  private readonly drainWaiters = new Set<() => void>();

  async runLegacyRemoval<TResult>(effect: () => Promise<TResult>): Promise<TResult> {
    const release = this.beginAdmission();
    try {
      return await effect();
    } finally {
      release();
    }
  }

  async disableLegacyRemovalWriters(cutoverEpoch: string): Promise<void> {
    assertCutoverEpoch(cutoverEpoch);
    if (this.disabledEpoch !== null && this.disabledEpoch !== cutoverEpoch) {
      throw new Error('Task removal cutover epoch changed');
    }
    this.disabledEpoch = cutoverEpoch;
    await this.waitForDrain();
  }

  async verifyLegacyRemovalWritersDisabled(cutoverEpoch: string): Promise<void> {
    assertCutoverEpoch(cutoverEpoch);
    if (this.disabledEpoch !== cutoverEpoch || this.inFlight !== 0) {
      throw new Error('Task removal legacy-writer cutover is incomplete');
    }
  }

  private beginAdmission(): () => void {
    if (this.disabledEpoch !== null) throw new TaskRemovalLegacyWriterDisabledError();
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (this.inFlight !== 0) return;
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    };
  }

  private waitForDrain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }
}

function assertCutoverEpoch(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new TypeError('Task removal cutover epoch is invalid');
  }
}
