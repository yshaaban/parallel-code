import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  getGitStatusSyncEventBufferKey,
  type GitStatusSyncEvent,
} from '../src/domain/server-state.js';
import { registerAllHandlers } from './ipc/register.js';
import { emitRendererEvent } from './ipc/renderer-events.js';
import { releaseBackendBackgroundWork } from './ipc/backend-work-queue.js';
import {
  loadPersistedDerivedState,
  startDerivedStatePersistence,
} from './ipc/derived-state-persistence.js';
import { stopAllTaskAgentWorkflows } from './ipc/task-workflows.js';
import { stopAllAskAboutCodeRequests } from './ipc/ask-about-code.js';
import { stopAllPlanWatchers } from './ipc/plans.js';
import { restoreSavedTaskPorts } from './ipc/task-ports.js';
import { restoreBackendDerivedState } from './ipc/saved-state-restore.js';
import { stopAllGitWatchers } from './ipc/git-watcher.js';
import { loadAppStateDocumentForEnv } from './ipc/storage.js';
import { IPC } from './ipc/channels.js';
import { diffPreloadAllowedChannels } from './ipc/preload-allowlist.js';
import { installStdioEpipeGuard } from './stdio.js';
import { applyLoginShellEnvironment } from './user-shell.js';
import { warn as logWarn } from './log.js';
import {
  getDevelopmentIconPath,
  getElectronPreloadPath,
  getFrontendIndexPath,
} from './main-paths.js';
import {
  finishDesktopRuntimeShutdown,
  settleDesktopRuntimeCleanupOwners,
} from './runtime-cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

installStdioEpipeGuard();
applyLoginShellEnvironment();

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = getElectronPreloadPath(__dirname);
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
  return getDevelopmentIconPath(__dirname);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    resizable: true,
    webPreferences: {
      preload: getElectronPreloadPath(__dirname),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);
  let mainWindowLoaded = false;
  const pendingGitStatusPayloads = new Map<string, GitStatusSyncEvent>();

  function sendGitStatusPayload(payload: GitStatusSyncEvent): void {
    if (!mainWindow) {
      return;
    }

    if (mainWindowLoaded) {
      emitRendererEvent(mainWindow.webContents, IPC.GitStatusChanged, payload);
      return;
    }

    pendingGitStatusPayloads.set(getGitStatusSyncEventBufferKey(payload), payload);
  }

  function flushPendingGitStatusPayloads(): void {
    if (!mainWindowLoaded) {
      return;
    }

    for (const payload of pendingGitStatusPayloads.values()) {
      if (mainWindow) {
        emitRendererEvent(mainWindow.webContents, IPC.GitStatusChanged, payload);
      }
    }
    pendingGitStatusPayloads.clear();
  }

  // Restore git watchers for all existing tasks so inactive tasks have
  // immediate fs.watch coverage (instead of relying solely on polling).
  // Derived snapshots hydrate from derived-state.json; recomputation stays
  // demand-driven through the backend work queue.
  const userDataPath = app.getPath('userData');
  const storageEnv = { userDataPath, isPackaged: app.isPackaged } as const;
  const savedState = loadAppStateDocumentForEnv(storageEnv);
  if (savedState) {
    restoreBackendDerivedState({
      context: {
        emitGitStatusChanged: sendGitStatusPayload,
      },
      derivedState: loadPersistedDerivedState(storageEnv),
      document: savedState,
    });
    restoreSavedTaskPorts(savedState.json);
  }
  startDerivedStatePersistence(storageEnv);

  // Open links in external browser instead of inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch((error) => {
        logWarn('window.externalUrl', 'failed to open external URL', { error: String(error) });
      });
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
      shell.openExternal(url).catch((error) => {
        logWarn('window.externalUrl', 'failed to open external URL', { error: String(error) });
      });
    }
  });

  // Inject CSS to make data-tauri-drag-region work in Electron
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindowLoaded = true;
    flushPendingGitStatusPayloads();
    releaseBackendBackgroundWork();
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
    mainWindow.loadFile(getFrontendIndexPath(__dirname));
  }

  mainWindow.on('closed', () => {
    mainWindowLoaded = false;
    pendingGitStatusPayloads.clear();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

let quitAfterRuntimeCleanup = false;
let runtimeCleanupStarted = false;

app.on('before-quit', (event) => {
  if (quitAfterRuntimeCleanup) {
    return;
  }
  event.preventDefault();
  stopAllPlanWatchers();
  stopAllGitWatchers();
  if (runtimeCleanupStarted) {
    return;
  }
  runtimeCleanupStarted = true;
  const runtimeCleanup = settleDesktopRuntimeCleanupOwners([
    { cleanup: stopAllTaskAgentWorkflows(), label: 'agent runner' },
    { cleanup: stopAllAskAboutCodeRequests(), label: 'ask about code' },
    {
      cleanup: import('./coordinator/tool-gateway.js').then((module) =>
        module.cleanupCoordinatorProducersForShutdown(),
      ),
      label: 'coordinator',
    },
  ]);
  void finishDesktopRuntimeShutdown(runtimeCleanup, {
    quit: () => {
      quitAfterRuntimeCleanup = true;
      app.quit();
    },
    exit: (code, error) => {
      logWarn('app.shutdown', 'failed to finish runtime cleanup before quit', {
        error: String(error),
      });
      quitAfterRuntimeCleanup = true;
      app.exit(code);
    },
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
