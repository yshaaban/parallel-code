import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import {
  recordTerminalStateMirrorInstance,
  recordTerminalStateMirrorOperationDrain,
  recordTerminalStateMirrorOutputEnqueue,
  recordTerminalStateMirrorResizeEnqueue,
  recordTerminalStateMirrorSerialize,
} from './runtime-diagnostics.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

const TERMINAL_STATE_MIRROR_SCROLLBACK_ROWS = 5_000;

export interface SerializedTerminalState {
  cols: number;
  data: Buffer;
  rows: number;
}

export class TerminalStateMirror {
  private readonly terminal: import('@xterm/headless').Terminal;
  private readonly serializeAddon: import('@xterm/addon-serialize').SerializeAddon;
  private pendingOperation: Promise<void> = Promise.resolve();
  private pendingOperationCount = 0;
  private queuedSequence = 0;
  private completedSequence = 0;
  private cachedState: SerializedTerminalState | null = null;
  private cachedSequence = 0;
  private disposed = false;
  private failed = false;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: TERMINAL_STATE_MIRROR_SCROLLBACK_ROWS,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
    recordTerminalStateMirrorInstance();
  }

  dispose(): void {
    this.disposed = true;
    this.terminal.dispose();
  }

  enqueueOutput(data: Uint8Array): void {
    if (this.disposed || this.failed) {
      return;
    }

    const sequence = this.nextSequence();
    this.enqueueOperation(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
      sequence,
    );
    recordTerminalStateMirrorOutputEnqueue(data.length, this.pendingOperationCount);
  }

  enqueueResize(cols: number, rows: number): void {
    if (this.disposed || this.failed) {
      return;
    }

    const sequence = this.nextSequence();
    this.enqueueOperation(() => {
      this.terminal.resize(cols, rows);
    }, sequence);
    recordTerminalStateMirrorResizeEnqueue(this.pendingOperationCount);
  }

  private nextSequence(): number {
    this.queuedSequence += 1;
    return this.queuedSequence;
  }

  private cloneSerializedState(state: SerializedTerminalState): SerializedTerminalState {
    return {
      cols: state.cols,
      data: Buffer.from(state.data),
      rows: state.rows,
    };
  }

  private getCachedSerializedState(
    requestedSequence: number,
    startedAt: number,
  ): SerializedTerminalState | null {
    if (
      !this.cachedState ||
      this.cachedSequence < requestedSequence ||
      this.completedSequence < requestedSequence
    ) {
      return null;
    }

    const cached = this.cloneSerializedState(this.cachedState);
    recordTerminalStateMirrorSerialize({
      bytes: cached.data.length,
      cacheHit: true,
      durationMs: performance.now() - startedAt,
    });
    return cached;
  }

  private enqueueOperation(operation: () => Promise<void> | void, sequence: number): void {
    if (this.disposed || this.failed) {
      return;
    }

    this.pendingOperationCount += 1;
    const queuedAt = performance.now();
    this.pendingOperation = this.pendingOperation
      .then(async () => {
        if (this.disposed || this.failed) {
          return;
        }
        await operation();
        this.completedSequence = Math.max(this.completedSequence, sequence);
      })
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.pendingOperationCount = Math.max(0, this.pendingOperationCount - 1);
        recordTerminalStateMirrorOperationDrain(performance.now() - queuedAt);
      });
  }

  async serialize(): Promise<SerializedTerminalState | null> {
    if (this.disposed || this.failed) {
      return null;
    }

    const requestedSequence = this.queuedSequence;
    const startedAt = performance.now();
    try {
      const readyCachedState = this.getCachedSerializedState(requestedSequence, startedAt);
      if (readyCachedState) {
        return readyCachedState;
      }

      const pendingOperation = this.pendingOperation;
      await pendingOperation;
      if (this.disposed || this.failed) {
        return null;
      }

      const completedCachedState = this.getCachedSerializedState(requestedSequence, startedAt);
      if (completedCachedState) {
        return completedCachedState;
      }

      const state = {
        cols: this.terminal.cols,
        data: Buffer.from(this.serializeAddon.serialize(), 'utf8'),
        rows: this.terminal.rows,
      };
      this.cachedState = this.cloneSerializedState(state);
      this.cachedSequence = this.completedSequence;
      recordTerminalStateMirrorSerialize({
        bytes: state.data.length,
        cacheHit: false,
        durationMs: performance.now() - startedAt,
      });

      return state;
    } catch {
      this.failed = true;
      return null;
    }
  }
}
