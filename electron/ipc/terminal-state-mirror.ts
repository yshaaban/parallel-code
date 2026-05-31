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
    this.parserDisposables = this.registerDecPrivateModeTracking();
    recordTerminalStateMirrorInstance();
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.parserDisposables) {
      disposable.dispose();
    }
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
    } catch {
      this.failed = true;
      return null;
    }
  }
}
