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

interface SingleOpenDialogOptions extends OpenDialogOptions {
  multiple?: false;
}

interface MultipleOpenDialogOptions extends OpenDialogOptions {
  multiple: true;
}

export async function confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  if (isElectronRuntime()) {
    return invoke(IPC.DialogConfirm, {
      message,
      ...options,
    });
  }

  if (!confirmNotify) {
    return window.confirm(message);
  }

  return new Promise<boolean>((resolve) => {
    if (pendingConfirm) {
      pendingConfirm.resolve(false);
    }
    pendingConfirm = {
      message,
      options: options ?? {},
      resolve,
    };
    confirmNotify?.();
  });
}

type ConfirmResolver = {
  message: string;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
};

type PathInputResolver = {
  resolve: (value: string | null) => void;
  options: OpenDialogOptions;
};

let pendingPathInput: PathInputResolver | null = null;
let pathInputNotify: (() => void) | null = null;
let pendingConfirm: ConfirmResolver | null = null;
let confirmNotify: (() => void) | null = null;

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

export function registerConfirmNotifier(notify: () => void): void {
  confirmNotify = notify;
}

export function clearConfirmNotifier(): void {
  confirmNotify = null;
  if (!pendingConfirm) return;
  pendingConfirm.resolve(false);
  pendingConfirm = null;
}

export function getPendingConfirm(): ConfirmResolver | null {
  return pendingConfirm;
}

export function resolvePendingConfirm(value: boolean): void {
  if (!pendingConfirm) return;
  pendingConfirm.resolve(value);
  pendingConfirm = null;
}

export function getPendingPathInput(): PathInputResolver | null {
  return pendingPathInput;
}

export function resolvePendingPathInput(value: string | null): void {
  if (!pendingPathInput) return;
  pendingPathInput.resolve(value);
  pendingPathInput = null;
}

export async function openDialog(options: MultipleOpenDialogOptions): Promise<string[] | null>;
export async function openDialog(options?: SingleOpenDialogOptions): Promise<string | null>;
export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  if (isElectronRuntime()) {
    return options ? invoke(IPC.DialogOpen, options) : invoke(IPC.DialogOpen);
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
