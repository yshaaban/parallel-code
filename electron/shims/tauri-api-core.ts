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

export class Channel<T> {
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

  toJSON() {
    return { __CHANNEL_ID__: this._id };
  }
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // JSON round-trip ensures all args are structured-clone-safe.
  // Triggers Channel.toJSON() to replace Channel instances with
  // plain { __CHANNEL_ID__: id } objects.
  const safeArgs = args
    ? (JSON.parse(JSON.stringify(args)) as Record<string, unknown>)
    : undefined;
  return window.electron.ipcRenderer.invoke(cmd, safeArgs) as Promise<T>;
}
