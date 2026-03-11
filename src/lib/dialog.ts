import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from './ipc';

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  if (isElectronRuntime()) {
    return invoke<boolean>(IPC.DialogConfirm, {
      message,
      ...options,
    });
  }
  return window.confirm(message);
}

type PathInputResolver = {
  resolve: (value: string | null) => void;
  options: OpenDialogOptions;
};

let pendingPathInput: PathInputResolver | null = null;
let pathInputNotify: (() => void) | null = null;

function splitPathList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function registerPathInputNotifier(notify: () => void): void {
  pathInputNotify = notify;
}

export function clearPathInputNotifier(): void {
  pathInputNotify = null;
  if (!pendingPathInput) return;
  pendingPathInput.resolve(null);
  pendingPathInput = null;
}

export function getPendingPathInput(): PathInputResolver | null {
  return pendingPathInput;
}

export function resolvePendingPathInput(value: string | null): void {
  if (!pendingPathInput) return;
  pendingPathInput.resolve(value);
  pendingPathInput = null;
}

export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  if (isElectronRuntime()) {
    return invoke<string | string[] | null>(IPC.DialogOpen, options);
  }

  if (!pathInputNotify) {
    const entered = window.prompt(
      options?.directory
        ? 'Enter an absolute path on the server host'
        : 'Enter an absolute file path on the server host',
    );
    if (!entered) return null;
    const trimmed = entered.trim();
    if (!trimmed) return null;
    return options?.multiple ? splitPathList(trimmed) : trimmed;
  }

  const value = await new Promise<string | null>((resolve) => {
    if (pendingPathInput) pendingPathInput.resolve(null);
    pendingPathInput = { resolve, options: options ?? {} };
    pathInputNotify?.();
  });

  if (!value) return null;
  if (options?.multiple) return splitPathList(value);
  return value;
}
