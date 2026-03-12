import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { registerAllHandlers } from './ipc/register.js';
import {
  restoreSavedTaskGitStatusMonitoring,
  type GitStatusChangedPayload,
} from './ipc/git-status-workflows.js';
import { killAllAgents } from './ipc/pty.js';
import { stopAllPlanWatchers } from './ipc/plans.js';
import { stopAllGitWatchers } from './ipc/git-watcher.js';
import { loadAppStateForEnv } from './ipc/storage.js';
import { IPC } from './ipc/channels.js';
import { diffPreloadAllowedChannels } from './ipc/preload-allowlist.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When launched from a .desktop file, PATH is minimal (/usr/bin:/bin).
// Resolve the user's full login-interactive shell PATH so spawned PTYs
// can find CLI tools like claude, codex, gemini, etc.
//
// Uses -ilc (interactive + login) to source both .zprofile/.profile AND
// .zshrc/.bashrc, where version managers (nvm, volta, fnm) add to PATH.
// Sentinel markers isolate PATH from noisy shell init output.
//
// Trade-off: -i (interactive) triggers .zshrc side effects (compinit, conda,
// welcome messages). Login-only (-lc) would be quieter but would miss tools
// that are only added to PATH in .bashrc/.zshrc (e.g. nvm). We accept the
// side effects since the sentinel-based parsing discards all other output.
// stderr is piped (not inherited) to suppress "no job control" warnings that
// bash emits when started interactive without a controlling TTY (common in
// Electron on WSL).
function fixPath(): void {
  if (process.platform === 'win32') return;
  try {
    const loginShell = process.env.SHELL || '/bin/sh';
    const sentinel = '__PCODE_PATH__';
    const result = execFileSync(loginShell, ['-ilc', `printf "${sentinel}%s${sentinel}" "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = result.match(new RegExp(`${sentinel}(.+?)${sentinel}`));
    if (match?.[1]) {
      process.env.PATH = match[1];
    }
  } catch (err) {
    console.warn('[fixPath] Failed to resolve login shell PATH:', err);
  }
}

fixPath();

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = path.join(__dirname, '..', 'electron', 'preload.cjs');
    const preloadSrc = fs.readFileSync(preloadPath, 'utf8');
    const { missing, extra } = diffPreloadAllowedChannels(preloadSrc, Object.values(IPC));
    if (missing.length > 0 || extra.length > 0) {
      const details = [
        missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
        extra.length > 0 ? `extra: ${extra.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      console.warn(`[preload-sync] preload.cjs ALLOWED_CHANNELS drift detected (${details})`);
    }
  } catch {
    // Preload file may not be readable in packaged app — skip check
  }
}

if (!app.isPackaged) verifyPreloadAllowlist();

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);
  let mainWindowLoaded = false;
  const pendingGitStatusPayloads = new Map<string, GitStatusChangedPayload>();

  function sendGitStatusPayload(payload: GitStatusChangedPayload): void {
    if (!mainWindow) {
      return;
    }

    if (mainWindowLoaded) {
      mainWindow.webContents.send(IPC.GitStatusChanged, payload);
      return;
    }

    pendingGitStatusPayloads.set(payload.worktreePath, payload);
  }

  function flushPendingGitStatusPayloads(): void {
    if (!mainWindowLoaded) {
      return;
    }

    for (const payload of pendingGitStatusPayloads.values()) {
      mainWindow?.webContents.send(IPC.GitStatusChanged, payload);
    }
    pendingGitStatusPayloads.clear();
  }

  // Restore git watchers for all existing tasks so inactive tasks have
  // immediate fs.watch coverage (instead of relying solely on polling).
  const userDataPath = app.getPath('userData');
  const savedJson = loadAppStateForEnv({ userDataPath, isPackaged: app.isPackaged });
  if (savedJson) {
    restoreSavedTaskGitStatusMonitoring(
      {
        emitGitStatusChanged: sendGitStatusPayload,
      },
      savedJson,
    );
  }

  // Open links in external browser instead of inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  let allowedOrigin: string | undefined;
  try {
    if (devOrigin) allowedOrigin = new URL(devOrigin).origin;
  } catch {
    // Malformed dev URL — skip origin allowlist
  }

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // Inject CSS to make data-tauri-drag-region work in Electron
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindowLoaded = true;
    flushPendingGitStatusPayloads();
    mainWindow?.webContents.insertCSS(`
      [data-tauri-drag-region] { -webkit-app-region: drag; }
      [data-tauri-drag-region] button,
      [data-tauri-drag-region] input,
      [data-tauri-drag-region] select,
      [data-tauri-drag-region] textarea { -webkit-app-region: no-drag; }
    `);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindowLoaded = false;
    pendingGitStatusPayloads.clear();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  killAllAgents();
  stopAllPlanWatchers();
  stopAllGitWatchers();
});

app.on('window-all-closed', () => {
  app.quit();
});
