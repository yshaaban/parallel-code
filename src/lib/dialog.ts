import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from './ipc';

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

interface ChoiceDialogOptions {
  cancelIndex?: number;
  choices: string[];
  defaultIndex?: number;
  kind?: string;
  title?: string;
}

interface OpenDialogOptions {
  allowSshClone?: boolean;
  directory?: boolean;
  multiple?: boolean;
  // Hide the path browser's "Recent Projects" list — used when the caller (e.g. AddProjectDialog)
  // already presents discovered projects, so Browse doesn't show a second project picker.
  suppressRecentProjects?: boolean;
}

interface SingleOpenDialogOptions extends OpenDialogOptions {
  multiple?: false;
}

interface MultipleOpenDialogOptions extends OpenDialogOptions {
  multiple: true;
}

interface NativeOpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
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

export async function choose(message: string, options: ChoiceDialogOptions): Promise<number> {
  if (isElectronRuntime()) {
    return invoke(IPC.DialogChoose, {
      message,
      ...options,
    });
  }

  const defaultIndex = options.defaultIndex ?? 0;
  const cancelIndex = options.cancelIndex ?? options.choices.length - 1;
  return window.confirm(message) ? defaultIndex : cancelIndex;
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

function getOpenDialogPromptMessage(options?: OpenDialogOptions): string {
  if (options?.allowSshClone) {
    return 'Enter an absolute path or a git SSH URL on the server host';
  }

  if (options?.directory) {
    return 'Enter an absolute path on the server host';
  }

  return 'Enter an absolute file path on the server host';
}

function getNativeOpenDialogOptions(
  options?: OpenDialogOptions,
): NativeOpenDialogOptions | undefined {
  if (!options) {
    return undefined;
  }

  const nativeOptions: NativeOpenDialogOptions = {};
  if (options.directory !== undefined) {
    nativeOptions.directory = options.directory;
  }
  if (options.multiple !== undefined) {
    nativeOptions.multiple = options.multiple;
  }

  return nativeOptions;
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
  if (isElectronRuntime() && !options?.allowSshClone) {
    const nativeOptions = getNativeOpenDialogOptions(options);
    return nativeOptions ? invoke(IPC.DialogOpen, nativeOptions) : invoke(IPC.DialogOpen);
  }

  if (!pathInputNotify) {
    const entered = window.prompt(getOpenDialogPromptMessage(options));
    if (!entered) return null;
    const trimmed = entered.trim();
    if (!trimmed) return null;
    if (options?.multiple) return splitPathList(trimmed);
    return trimmed;
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
