import {
  app,
  BrowserWindow,
  clipboard as electronClipboard,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { IPC } from './channels.js';
import { subscribeAgentSupervision } from './agent-supervision.js';
import {
  createIpcHandlers,
  type ClipboardController,
  type DialogController,
  type ShellController,
  type WindowController,
} from './handlers.js';
import { emitRendererEvent } from './renderer-events.js';
import { createRemoteAccessController } from './remote-access-workflows.js';
import { subscribeTaskConvergence } from './task-convergence-state.js';
import { subscribeTaskReview } from './task-review-state.js';
import { subscribeTaskReviewSignals } from './task-review-signals.js';
import { subscribeTaskSteps } from './task-steps.js';
import { subscribeTaskPorts } from './task-ports.js';
import { decodeBase64ToUint8Array, getBase64DecodedByteLength } from '../../src/lib/base64.js';

function sendToWindow(win: BrowserWindow, channelId: string, msg: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(`channel:${channelId}`, msg);
  }
}

function emitWindowEvent(win: BrowserWindow, channel: IPC): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel);
  }
}

function addThrottledWindowEvent(
  win: BrowserWindow,
  eventName: 'move' | 'resize',
  channel: IPC.WindowMoved | IPC.WindowResized,
): void {
  let throttled = false;
  let pending = false;

  const listener = () => {
    if (win.isDestroyed()) {
      return;
    }
    if (throttled) {
      pending = true;
      return;
    }

    throttled = true;
    emitWindowEvent(win, channel);

    setTimeout(() => {
      throttled = false;
      if (!pending) {
        return;
      }

      pending = false;
      emitWindowEvent(win, channel);
    }, 100);
  };

  if (eventName === 'move') {
    win.on('move', listener);
    return;
  }

  win.on('resize', listener);
}

function createWindowController(win: BrowserWindow): WindowController {
  return {
    isFocused: () => win.isFocused(),
    isMaximized: () => win.isMaximized(),
    focus: () => win.focus(),
    minimize: () => win.minimize(),
    toggleMaximize: () => {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    close: () => win.close(),
    forceClose: () => win.destroy(),
    hide: () => win.hide(),
    show: () => win.show(),
    maximize: () => win.maximize(),
    unmaximize: () => win.unmaximize(),
    setSize: (width, height) => win.setSize(width, height),
    setPosition: (x, y) => win.setPosition(x, y),
    getPosition: () => {
      const [x = 0, y = 0] = win.getPosition();
      return { x, y };
    },
    getSize: () => {
      const [width = 0, height = 0] = win.getSize();
      return { width, height };
    },
  };
}

function createDialogController(win: BrowserWindow): DialogController {
  return {
    confirm: async (args) => {
      const result = await dialog.showMessageBox(win, {
        type: args.kind === 'warning' ? 'warning' : 'question',
        title: args.title || 'Confirm',
        message: args.message,
        buttons: [args.okLabel || 'OK', args.cancelLabel || 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    open: async (args) => {
      const properties: Array<'openDirectory' | 'openFile' | 'multiSelections'> = [];
      if (args?.directory) properties.push('openDirectory');
      else properties.push('openFile');
      if (args?.multiple) properties.push('multiSelections');
      const result = await dialog.showOpenDialog(win, { properties });
      if (result.canceled) return null;
      if (args?.multiple) {
        return result.filePaths;
      }

      return result.filePaths[0] ?? null;
    },
  };
}

function createShellController(): ShellController {
  return {
    reveal: (filePath) => {
      shell.showItemInFolder(filePath);
    },
    openFile: (worktreePath, filePath) => shell.openPath(path.join(worktreePath, filePath)),
    openInEditor: (editorCommand, worktreePath) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const child = spawn(editorCommand, [worktreePath], {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', (error) => {
          if (!settled) {
            settled = true;
            reject(new Error(`Failed to launch "${editorCommand}": ${error.message}`));
          }
        });
        child.on('spawn', () => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve();
          }
        });
      }),
  };
}

const MAX_DROPPED_IMAGE_BYTES = 50 * 1024 * 1024;

function readClipboardFileUrl(): string | null {
  const formats = electronClipboard.availableFormats();

  if (formats.includes('public.file-url')) {
    const url = electronClipboard.read('public.file-url').trim();
    if (url) {
      return url;
    }
  }

  if (formats.includes('x-special/gnome-copied-files')) {
    const payload = electronClipboard.read('x-special/gnome-copied-files');
    const lines = payload.split('\n');
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }

      const url = line.trim();
      if (url.startsWith('file://')) {
        return url;
      }
    }
  }

  if (formats.includes('text/uri-list')) {
    const payload = electronClipboard.read('text/uri-list');
    for (const line of payload.split('\n')) {
      const url = line.trim();
      if (url && !url.startsWith('#') && url.startsWith('file://')) {
        return url;
      }
    }
  }

  return null;
}

function clipboardFileUrlToPath(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

function sanitizeDroppedImageName(name: string | undefined): string {
  const base = (name ?? '')
    // eslint-disable-next-line no-control-regex -- NUL cannot be allowed inside filesystem names.
    .replace(/[\\/\x00]/g, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 200);
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  if (base) {
    return `parallel-code-drop-${suffix}-${base}`;
  }

  return `parallel-code-drop-${suffix}.png`;
}

function createClipboardController(): ClipboardController {
  const clipboardImagePath = path.join(os.tmpdir(), 'parallel-code-clipboard.png');

  async function saveClipboardImage(): Promise<string | null> {
    try {
      const image = electronClipboard.readImage();
      if (image.isEmpty()) {
        return null;
      }

      await fs.promises.writeFile(clipboardImagePath, image.toPNG());
      return clipboardImagePath;
    } catch {
      return null;
    }
  }

  return {
    async resolveClipboardPaste() {
      try {
        const fileUrl = readClipboardFileUrl();
        if (fileUrl) {
          const filePath = clipboardFileUrlToPath(fileUrl);
          if (filePath) {
            return { kind: 'file', path: filePath };
          }
        }

        const text = electronClipboard.readText();
        if (text) {
          return { kind: 'text', text };
        }

        const imagePath = await saveClipboardImage();
        if (imagePath) {
          return { kind: 'image', path: imagePath };
        }
      } catch {
        return { kind: 'empty' };
      }

      return { kind: 'empty' };
    },

    saveClipboardImage,

    async saveDroppedImage(args: { data: string; name?: string }): Promise<string | null> {
      const decodedBytes = getBase64DecodedByteLength(args.data);
      if (decodedBytes === null || decodedBytes > MAX_DROPPED_IMAGE_BYTES) {
        return null;
      }

      const imagePath = path.join(os.tmpdir(), sanitizeDroppedImageName(args.name));
      await fs.promises.writeFile(imagePath, decodeBase64ToUint8Array(args.data));
      return imagePath;
    },
  };
}

export function registerAllHandlers(win: BrowserWindow): void {
  const remoteAccess = createRemoteAccessController();
  const stopAgentSupervisionSubscription = subscribeAgentSupervision((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.AgentSupervisionChanged, event);
    }
  });
  const stopRemoteStatusSubscription = remoteAccess.subscribe((status) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.RemoteStatusChanged, status);
    }
  });
  const stopTaskPortsSubscription = subscribeTaskPorts((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.TaskPortsChanged, event);
    }
  });
  const stopTaskConvergenceSubscription = subscribeTaskConvergence((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.TaskConvergenceChanged, event);
    }
  });
  const stopTaskReviewSubscription = subscribeTaskReview((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.TaskReviewChanged, event);
    }
  });
  const stopTaskReviewSignalsSubscription = subscribeTaskReviewSignals((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.TaskReviewSignalsChanged, event);
    }
  });
  const stopTaskStepsSubscription = subscribeTaskSteps((event) => {
    if (!win.isDestroyed()) {
      emitRendererEvent(win.webContents, IPC.TaskStepsChanged, event);
    }
  });
  const handlers = createIpcHandlers({
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    sendToChannel: (channelId, msg) => sendToWindow(win, channelId, msg),
    emitIpcEvent: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
    emitGitStatusChanged: (payload) => {
      if (!win.isDestroyed()) {
        emitRendererEvent(win.webContents, IPC.GitStatusChanged, payload);
      }
    },
    window: createWindowController(win),
    dialog: createDialogController(win),
    shell: createShellController(),
    clipboard: createClipboardController(),
    remoteAccess,
  });

  for (const channel of Object.values(IPC)) {
    const handler = handlers[channel];
    if (!handler) {
      continue;
    }

    ipcMain.handle(channel, (_event, args) => handler(args));
  }

  win.on('focus', () => emitWindowEvent(win, IPC.WindowFocus));
  win.on('blur', () => emitWindowEvent(win, IPC.WindowBlur));
  addThrottledWindowEvent(win, 'resize', IPC.WindowResized);
  addThrottledWindowEvent(win, 'move', IPC.WindowMoved);

  win.on('close', (event) => {
    event.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.WindowCloseRequested);
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 5_000);
    }
  });

  win.on('closed', () => {
    stopAgentSupervisionSubscription();
    stopRemoteStatusSubscription();
    stopTaskConvergenceSubscription();
    stopTaskReviewSubscription();
    stopTaskReviewSignalsSubscription();
    stopTaskStepsSubscription();
    stopTaskPortsSubscription();
  });
}
