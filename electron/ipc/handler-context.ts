import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import {
  isPauseReason,
  type GitStatusSyncEvent,
  type PauseReason,
} from '../../src/domain/server-state.js';
import type { StorageEnv } from './storage.js';
import type { RemoteAccessController } from './remote-access-workflows.js';
import type { AppUpdateStatus } from '../../src/domain/app-update.js';

export type HandlerArgs = Record<string, unknown> | undefined;
export type IpcHandler = (args?: HandlerArgs) => Promise<unknown> | unknown;

export interface WindowController {
  isFocused: () => boolean;
  isMaximized: () => boolean;
  focus: () => void;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  closeHandled: () => void;
  forceClose: () => void;
  hide: () => void;
  show: () => void;
  maximize: () => void;
  unmaximize: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  getPosition: () => { x: number; y: number };
  getSize: () => { width: number; height: number };
}

export interface DialogController {
  choose: (args: {
    cancelIndex?: number;
    choices: string[];
    defaultIndex?: number;
    kind?: string;
    message: string;
    title?: string;
  }) => Promise<number>;
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

export type ClipboardPasteResult =
  | { kind: 'empty' }
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string };

export interface ClipboardController {
  resolveClipboardPaste?: () => Promise<ClipboardPasteResult>;
  saveClipboardImage: () => Promise<string | null>;
  saveDroppedImage?: (args: { data: string; name?: string }) => Promise<string | null>;
}

export interface UpdateController {
  checkForUpdates: () => Promise<AppUpdateStatus>;
  getStatus: () => AppUpdateStatus;
  installUpdate: () => Promise<AppUpdateStatus>;
}

export interface HandlerContext extends StorageEnv {
  sendToChannel: (channelId: string, msg: unknown) => void;
  coordinatorToolCallUrl?: string | (() => string);
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  emitGitStatusChanged?: (payload: GitStatusSyncEvent) => void;
  isChannelActive?: (channelId: string) => boolean;
  remoteAccess?: RemoteAccessController;
  window?: WindowController;
  dialog?: DialogController;
  shell?: ShellController;
  clipboard?: ClipboardController;
  update?: UpdateController;
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
): asserts value is PauseReason | undefined {
  if (value !== undefined && (typeof value !== 'string' || !isPauseReason(value))) {
    throw new BadRequestError('reason must be a valid pause reason');
  }
}
