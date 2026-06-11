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
const DEC_PRIVATE_MODE_CURSOR_VISIBLE = 25;
const DEC_PRIVATE_MODE_BRACKETED_PASTE = 2004;
const ENABLE_BRACKETED_PASTE_SEQUENCE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE_SEQUENCE = '\x1b[?2004l';
const SHOW_CURSOR_SEQUENCE = '\x1b[?25h';
const HIDE_CURSOR_SEQUENCE = '\x1b[?25l';

type CsiParams = Array<number | number[]>;
type Disposable = { dispose: () => void };

interface DecPrivateModeRestoreState {
  bracketedPasteTouched: boolean;
  cursorVisible: boolean | null;
}

export interface SerializedTerminalState {
  cols: number;
  data: Buffer;
  rows: number;
}

export interface SerializedLatestTerminalState extends SerializedTerminalState {
  // Byte cursor of the last APPLIED mirror write. Callers compose the
  // remaining ring-buffer delta (appliedCursor -> outputCursor) on top of the
  // serialized state instead of awaiting the live write backlog.
  appliedCursor: number;
}

interface PendingMirrorOperation {
  endCursor: number | null;
  queuedAt: number;
  run: () => Promise<void> | void;
  sequence: number;
  resolveSerialize?: (state: SerializedLatestTerminalState | null) => void;
}

function updateDecPrivateModes(
  modes: DecPrivateModeRestoreState,
  params: CsiParams,
  enabled: boolean,
): void {
  for (const param of params) {
    if (Array.isArray(param)) {
      updateDecPrivateModes(modes, param, enabled);
      continue;
    }

    switch (param) {
      case DEC_PRIVATE_MODE_CURSOR_VISIBLE:
        modes.cursorVisible = enabled;
        break;
      case DEC_PRIVATE_MODE_BRACKETED_PASTE:
        modes.bracketedPasteTouched = true;
        break;
      default:
        break;
    }
  }
}

export class TerminalStateMirror {
  private readonly terminal: import('@xterm/headless').Terminal;
  private readonly serializeAddon: import('@xterm/addon-serialize').SerializeAddon;
  private readonly parserDisposables: Disposable[];
  private readonly decPrivateModeRestoreState: DecPrivateModeRestoreState = {
    bracketedPasteTouched: false,
    cursorVisible: null,
  };
  private readonly pendingOperations: PendingMirrorOperation[] = [];
  private currentOperation: Promise<void> | null = null;
  private pendingOperationCount = 0;
  private queuedSequence = 0;
  private completedSequence = 0;
  private appliedEndCursor = 0;
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
    this.parserDisposables = this.registerDecPrivateModeTracking();
    recordTerminalStateMirrorInstance();
  }

  dispose(): void {
    this.disposed = true;
    this.flushPendingSerializeResolvers();
    for (const disposable of this.parserDisposables) {
      disposable.dispose();
    }
    this.terminal.dispose();
  }

  enqueueOutput(data: Uint8Array, endCursor: number | null = null): void {
    if (this.disposed || this.failed) {
      return;
    }

    const sequence = this.nextSequence();
    this.enqueueOperation({
      endCursor,
      queuedAt: performance.now(),
      run: () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
      sequence,
    });
    recordTerminalStateMirrorOutputEnqueue(data.length, this.pendingOperationCount);
  }

  enqueueResize(cols: number, rows: number): void {
    if (this.disposed || this.failed) {
      return;
    }

    const sequence = this.nextSequence();
    this.enqueueOperation({
      endCursor: null,
      queuedAt: performance.now(),
      run: () => {
        this.terminal.resize(cols, rows);
      },
      sequence,
    });
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

  private flushPendingSerializeResolvers(): void {
    const pending = this.pendingOperations.splice(0, this.pendingOperations.length);
    this.pendingOperationCount = 0;
    for (const operation of pending) {
      operation.resolveSerialize?.(null);
    }
  }

  private enqueueOperation(operation: PendingMirrorOperation): void {
    if (this.disposed || this.failed) {
      operation.resolveSerialize?.(null);
      return;
    }

    this.pendingOperationCount += 1;
    this.pendingOperations.push(operation);
    this.pump();
  }

  private pump(): void {
    if (this.currentOperation) {
      return;
    }

    if (this.disposed || this.failed) {
      this.flushPendingSerializeResolvers();
      return;
    }

    const next = this.pendingOperations.shift();
    if (!next) {
      return;
    }

    this.currentOperation = Promise.resolve()
      .then(async () => {
        if (this.disposed || this.failed) {
          next.resolveSerialize?.(null);
          return;
        }
        await next.run();
        this.completedSequence = Math.max(this.completedSequence, next.sequence);
        if (next.endCursor !== null) {
          this.appliedEndCursor = next.endCursor;
        }
      })
      .catch(() => {
        this.failed = true;
        next.resolveSerialize?.(null);
      })
      .finally(() => {
        this.pendingOperationCount = Math.max(0, this.pendingOperationCount - 1);
        recordTerminalStateMirrorOperationDrain(performance.now() - next.queuedAt);
        this.currentOperation = null;
        this.pump();
      });
  }

  private registerDecPrivateModeTracking(): Disposable[] {
    return [
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        updateDecPrivateModes(this.decPrivateModeRestoreState, params, true);
        return false;
      }),
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        updateDecPrivateModes(this.decPrivateModeRestoreState, params, false);
        return false;
      }),
      this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
        this.decPrivateModeRestoreState.bracketedPasteTouched = true;
        this.decPrivateModeRestoreState.cursorVisible = true;
        return false;
      }),
      this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
        // xterm full reset restores DEC private modes, but cursor visibility is separate state.
        this.decPrivateModeRestoreState.bracketedPasteTouched = true;
        return false;
      }),
    ];
  }

  private serializeDecPrivateModes(): string {
    // SerializeAddon restores the grid but not DEC private modes such as DECTCEM.
    // Replay the parsed protocol state so restored TUIs keep native cursor semantics.
    let result = '';
    if (this.decPrivateModeRestoreState.bracketedPasteTouched) {
      result += this.terminal.modes.bracketedPasteMode
        ? ENABLE_BRACKETED_PASTE_SEQUENCE
        : DISABLE_BRACKETED_PASTE_SEQUENCE;
    }
    if (this.decPrivateModeRestoreState.cursorVisible !== null) {
      result += this.decPrivateModeRestoreState.cursorVisible
        ? SHOW_CURSOR_SEQUENCE
        : HIDE_CURSOR_SEQUENCE;
    }
    return result;
  }

  private serializeTerminalStateData(): Buffer {
    return Buffer.from(
      `${this.serializeAddon.serialize()}${this.serializeDecPrivateModes()}`,
      'utf8',
    );
  }

  private captureSerializedState(startedAt: number): SerializedTerminalState {
    const state = {
      cols: this.terminal.cols,
      data: this.serializeTerminalStateData(),
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
  }

  /**
   * Serialize against the last APPLIED write without awaiting the queued
   * backlog. The serialize runs between operation boundaries (bounded by the
   * one in-flight operation), so the returned appliedCursor is exactly
   * consistent with the serialized grid; callers append the retained
   * ring-buffer delta appliedCursor -> outputCursor for full continuity.
   */
  serializeLatest(): Promise<SerializedLatestTerminalState | null> {
    if (this.disposed || this.failed) {
      return Promise.resolve(null);
    }

    const startedAt = performance.now();
    return new Promise<SerializedLatestTerminalState | null>((resolve) => {
      const operation: PendingMirrorOperation = {
        endCursor: null,
        queuedAt: startedAt,
        resolveSerialize: resolve,
        run: () => {
          if (this.disposed || this.failed) {
            resolve(null);
            return;
          }

          try {
            resolve({
              ...this.captureSerializedState(startedAt),
              appliedCursor: this.appliedEndCursor,
            });
          } catch {
            this.failed = true;
            resolve(null);
          }
        },
        sequence: this.completedSequence,
      };
      // Jump the queued backlog: serialize right after the in-flight
      // operation completes instead of waiting for every queued write.
      this.pendingOperationCount += 1;
      this.pendingOperations.unshift(operation);
      this.pump();
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

      while (
        (this.currentOperation !== null || this.pendingOperations.length > 0) &&
        !this.disposed &&
        !this.failed
      ) {
        await (this.currentOperation ?? Promise.resolve());
        if (this.currentOperation === null && this.pendingOperations.length > 0) {
          this.pump();
        }
      }
      if (this.disposed || this.failed) {
        return null;
      }

      const completedCachedState = this.getCachedSerializedState(requestedSequence, startedAt);
      if (completedCachedState) {
        return completedCachedState;
      }

      return this.captureSerializedState(startedAt);
    } catch {
      this.failed = true;
      return null;
    }
  }
}
