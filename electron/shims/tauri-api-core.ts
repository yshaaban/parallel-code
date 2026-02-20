// Shim for @tauri-apps/api/core
// Replaces Tauri invoke() and Channel with Electron IPC equivalents.

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}

const CHANNEL_MARKER = Symbol("ElectronChannel");

export class Channel<T> {
  readonly [CHANNEL_MARKER] = true;
  private _id = crypto.randomUUID();
  private _cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor() {
    this._cleanup = window.electron.ipcRenderer.on(
      `channel:${this._id}`,
      (msg: unknown) => {
        this.onmessage?.(msg as T);
      }
    );
  }

  get id() {
    return this._id;
  }
}

// Electron IPC uses structured clone, not JSON.stringify, so toJSON() is
// never called.  We must convert Channel instances to plain serializable
// objects before handing args to ipcRenderer.invoke().
function processArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return args;
  const processed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value && typeof value === "object" && CHANNEL_MARKER in value) {
      processed[key] = { __CHANNEL_ID__: (value as Channel<unknown>).id };
    } else {
      processed[key] = value;
    }
  }
  return processed;
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  return window.electron.ipcRenderer.invoke(cmd, processArgs(args)) as Promise<T>;
}
