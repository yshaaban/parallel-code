import { createRequire } from 'node:module';

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
  }

  dispose(): void {
    this.disposed = true;
    this.terminal.dispose();
  }

  enqueueOutput(data: Uint8Array): void {
    this.enqueueOperation(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
    );
  }

  enqueueResize(cols: number, rows: number): void {
    this.enqueueOperation(() => {
      this.terminal.resize(cols, rows);
    });
  }

  private enqueueOperation(operation: () => Promise<void> | void): void {
    if (this.disposed || this.failed) {
      return;
    }

    this.pendingOperation = this.pendingOperation
      .then(async () => {
        if (this.disposed || this.failed) {
          return;
        }
        await operation();
      })
      .catch(() => {
        this.failed = true;
      });
  }

  async serialize(): Promise<SerializedTerminalState | null> {
    if (this.disposed || this.failed) {
      return null;
    }

    try {
      await this.pendingOperation;
      if (this.disposed || this.failed) {
        return null;
      }

      return {
        cols: this.terminal.cols,
        data: Buffer.from(this.serializeAddon.serialize(), 'utf8'),
        rows: this.terminal.rows,
      };
    } catch {
      this.failed = true;
      return null;
    }
  }
}
