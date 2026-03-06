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

export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  if (isElectronRuntime()) {
    return invoke<string | string[] | null>(IPC.DialogOpen, options);
  }

  const entered = window.prompt(
    options?.directory
      ? 'Enter an absolute path on the server host'
      : 'Enter an absolute file path on the server host',
  );
  if (!entered) return null;
  const value = entered.trim();
  if (!value) return null;
  if (options?.multiple) {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return value;
}
