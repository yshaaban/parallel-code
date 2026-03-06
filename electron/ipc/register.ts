import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { IPC } from './channels.js';
import {
  createIpcHandlers,
  type DialogController,
  type IpcHandler,
  type RemoteAccessController,
  type ShellController,
  type WindowController,
} from './handlers.js';
import { startRemoteServer } from '../remote/server.js';

function sendToWindow(win: BrowserWindow, channelId: string, msg: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(`channel:${channelId}`, msg);
  }
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
      const [x, y] = win.getPosition();
      return { x, y };
    },
    getSize: () => {
      const [width, height] = win.getSize();
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

function createRemoteAccessController(): RemoteAccessController {
  let remoteServer: Awaited<ReturnType<typeof startRemoteServer>> | null = null;

  return {
    start: async ({ port, getTaskName, getAgentStatus }) => {
      if (remoteServer) {
        return {
          url: remoteServer.url,
          wifiUrl: remoteServer.wifiUrl,
          tailscaleUrl: remoteServer.tailscaleUrl,
          token: remoteServer.token,
          port: remoteServer.port,
        };
      }

      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const distRemote = path.join(thisDir, '..', '..', 'dist-remote');
      remoteServer = await startRemoteServer({
        port: port ?? 7777,
        staticDir: distRemote,
        getTaskName,
        getAgentStatus,
      });

      return {
        url: remoteServer.url,
        wifiUrl: remoteServer.wifiUrl,
        tailscaleUrl: remoteServer.tailscaleUrl,
        token: remoteServer.token,
        port: remoteServer.port,
      };
    },

    stop: async () => {
      if (remoteServer) {
        await remoteServer.stop();
        remoteServer = null;
      }
    },

    status: () => {
      if (!remoteServer) return { enabled: false, connectedClients: 0 };
      return {
        enabled: true,
        connectedClients: remoteServer.connectedClients(),
        url: remoteServer.url,
        wifiUrl: remoteServer.wifiUrl,
        tailscaleUrl: remoteServer.tailscaleUrl,
        token: remoteServer.token,
        port: remoteServer.port,
      };
    },
  };
}

export function registerAllHandlers(win: BrowserWindow): void {
  const handlers = createIpcHandlers({
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    sendToChannel: (channelId, msg) => sendToWindow(win, channelId, msg),
    emitIpcEvent: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
    window: createWindowController(win),
    dialog: createDialogController(win),
    shell: createShellController(),
    remoteAccess: createRemoteAccessController(),
  });

  for (const [channel, handler] of Object.entries(handlers) as Array<[IPC, IpcHandler]>) {
    ipcMain.handle(channel, (_event, args) => handler(args));
  }

  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowFocus);
  });
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowBlur);
  });

  let resizeThrottled = false;
  let resizePending = false;
  win.on('resize', () => {
    if (win.isDestroyed()) return;
    if (resizeThrottled) {
      resizePending = true;
      return;
    }
    resizeThrottled = true;
    win.webContents.send(IPC.WindowResized);
    setTimeout(() => {
      resizeThrottled = false;
      if (resizePending) {
        resizePending = false;
        if (!win.isDestroyed()) win.webContents.send(IPC.WindowResized);
      }
    }, 100);
  });

  let moveThrottled = false;
  let movePending = false;
  win.on('move', () => {
    if (win.isDestroyed()) return;
    if (moveThrottled) {
      movePending = true;
      return;
    }
    moveThrottled = true;
    win.webContents.send(IPC.WindowMoved);
    setTimeout(() => {
      moveThrottled = false;
      if (movePending) {
        movePending = false;
        if (!win.isDestroyed()) win.webContents.send(IPC.WindowMoved);
      }
    }, 100);
  });

  win.on('close', (event) => {
    event.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.WindowCloseRequested);
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 5_000);
    }
  });
}
