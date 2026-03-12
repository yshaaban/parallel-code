import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { StorageEnv } from './storage.js';
import type { RemoteAccessController } from './remote-access-workflows.js';

export type HandlerArgs = Record<string, unknown> | undefined;
export type IpcHandler = (args?: HandlerArgs) => Promise<unknown> | unknown;

const VALID_PAUSE_REASONS = new Set<string>(['manual', 'flow-control', 'restore']);

export interface WindowController {
  isFocused: () => boolean;
  isMaximized: () => boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  forceClose: () => void;
  hide: () => void;
  maximize: () => void;
  unmaximize: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  getPosition: () => { x: number; y: number };
  getSize: () => { width: number; height: number };
}

export interface DialogController {
  confirm: (args: {
    message: string;
    title?: string;
    kind?: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  open: (args?: { directory?: boolean; multiple?: boolean }) => Promise<string | string[] | null>;
}

export interface ShellController {
  reveal: (filePath: string) => void;
  openFile: (worktreePath: string, filePath: string) => Promise<string | undefined>;
  openInEditor: (editorCommand: string, worktreePath: string) => Promise<void>;
}

export interface HandlerContext extends StorageEnv {
  sendToChannel: (channelId: string, msg: unknown) => void;
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  remoteAccess?: RemoteAccessController;
  window?: WindowController;
  dialog?: DialogController;
  shell?: ShellController;
}

function requireContextFeature<K extends keyof HandlerContext>(
  context: HandlerContext,
  key: K,
  description: string,
): NonNullable<HandlerContext[K]> {
  const feature = context[key];
  if (!feature) {
    throw new Error(`${description} is unavailable in this mode`);
  }
  return feature as NonNullable<HandlerContext[K]>;
}

export function requireWindow(context: HandlerContext): WindowController {
  return requireContextFeature(context, 'window', 'Window management');
}

export function requireDialog(context: HandlerContext): DialogController {
  return requireContextFeature(context, 'dialog', 'Dialog operations');
}

export function requireShell(context: HandlerContext): ShellController {
  return requireContextFeature(context, 'shell', 'Shell operations');
}

export function requireRemoteAccess(context: HandlerContext): RemoteAccessController {
  return requireContextFeature(context, 'remoteAccess', 'Remote access');
}

export function assertOptionalPauseReason(
  value: unknown,
): asserts value is 'manual' | 'flow-control' | 'restore' | undefined {
  if (value !== undefined && (typeof value !== 'string' || !VALID_PAUSE_REASONS.has(value))) {
    throw new BadRequestError('reason must be a valid pause reason');
  }
}
