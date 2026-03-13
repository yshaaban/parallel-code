import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { IPC } from './channels.js';
import { subscribeAgentSupervision } from './agent-supervision.js';
import {
  createIpcHandlers,
  type DialogController,
  type ShellController,
  type WindowController,
} from './handlers.js';
import { emitRendererEvent } from './renderer-events.js';
import { createRemoteAccessController } from './remote-access-workflows.js';
import { subscribeTaskConvergence } from './task-convergence-state.js';
import { subscribeTaskPorts } from './task-ports.js';

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
    minimize: () => win.minimize(),
    toggleMaximize: () => {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    close: () => win.close(),
    forceClose: () => win.destroy(),
    hide: () => win.hide(),
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
      return args?.multiple ? result.filePaths : (result.filePaths[0] ?? null);
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
    stopTaskPortsSubscription();
  });
}
