import { IPC } from '../../electron/ipc/channels';
import { confirm } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { appWindow } from '../lib/window';
import { saveState, setWindowState, store } from '../store/store';
import type { PersistedWindowState } from '../store/types';

const MIN_WINDOW_DIMENSION = 100;
const WINDOW_EVENT_SETTLE_MS = 200;

interface WindowSessionRuntimeOptions {
  electronRuntime: boolean;
  isMac: boolean;
  setWindowFocused: (focused: boolean) => void;
  setWindowMaximized: (maximized: boolean) => void;
}

export function createWindowSessionRuntime(options: WindowSessionRuntimeOptions): {
  captureWindowState: () => Promise<void>;
  cleanupWindowEventListeners: () => void;
  registerCloseRequestedHandler: () => Promise<() => void>;
  registerWindowEventListeners: () => void;
  restoreWindowState: () => Promise<void>;
  setupWindowChrome: () => Promise<void>;
  syncWindowFocused: () => Promise<void>;
  syncWindowMaximized: () => Promise<void>;
} {
  let unlistenFocusChanged: (() => void) | null = null;
  let unlistenResized: (() => void) | null = null;
  let unlistenMoved: (() => void) | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  let listenersDisposed = false;

  function assignWindowListener(kind: 'focus' | 'resize' | 'move', unlisten: () => void): void {
    if (listenersDisposed) {
      unlisten();
      return;
    }

    switch (kind) {
      case 'focus':
        unlistenFocusChanged = unlisten;
        return;
      case 'resize':
        unlistenResized = unlisten;
        return;
      case 'move':
        unlistenMoved = unlisten;
        return;
    }
  }

  async function syncWindowFocused(): Promise<void> {
    const focused = await appWindow.isFocused().catch(() => true);
    options.setWindowFocused(focused);
  }

  async function syncWindowMaximized(): Promise<void> {
    const maximized = await appWindow.isMaximized().catch(() => false);
    options.setWindowMaximized(maximized);
  }

  async function readWindowGeometry(): Promise<Omit<PersistedWindowState, 'maximized'> | null> {
    const [position, size] = await Promise.all([
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
    ]);

    if (!position || !size) return null;
    if (size.width < MIN_WINDOW_DIMENSION || size.height < MIN_WINDOW_DIMENSION) return null;

    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: Math.round(size.width),
      height: Math.round(size.height),
    };
  }

  async function captureWindowState(): Promise<void> {
    const maximized = await appWindow.isMaximized().catch(() => false);
    const current = store.windowState;

    if (maximized && current) {
      if (!current.maximized) {
        setWindowState({ ...current, maximized: true });
      }
      return;
    }

    const geometry = await readWindowGeometry();
    if (!geometry) return;

    setWindowState({ ...geometry, maximized });
  }

  async function restoreWindowState(): Promise<void> {
    const saved = store.windowState;
    if (!saved) return;
    if (saved.width < MIN_WINDOW_DIMENSION || saved.height < MIN_WINDOW_DIMENSION) return;

    await appWindow.unmaximize().catch(() => {});
    await appWindow.setSize({ width: saved.width, height: saved.height }).catch(() => {});
    await appWindow.setPosition({ x: saved.x, y: saved.y }).catch(() => {});

    if (saved.maximized) {
      await appWindow.maximize().catch(() => {});
    }

    void syncWindowMaximized();
  }

  async function setupWindowChrome(): Promise<void> {
    if (options.electronRuntime && options.isMac) {
      await appWindow.setTitleBarStyle('overlay').catch((error) => {
        console.warn('Failed to enable macOS overlay titlebar', error);
      });
      return;
    }

    if (options.electronRuntime) {
      await appWindow.setDecorations(false).catch((error) => {
        console.warn('Failed to disable native decorations', error);
      });
    }
  }

  function registerWindowEventListeners(): void {
    listenersDisposed = false;
    void (async () => {
      try {
        const unlisten = await appWindow.onFocusChanged((event) => {
          options.setWindowFocused(Boolean(event.payload));
        });
        assignWindowListener('focus', unlisten);
      } catch {
        unlistenFocusChanged = null;
      }

      try {
        const unlisten = await appWindow.onResized(() => {
          if (resizeTimer !== undefined) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            void syncWindowMaximized();
            void captureWindowState();
          }, WINDOW_EVENT_SETTLE_MS);
        });
        assignWindowListener('resize', unlisten);
      } catch {
        unlistenResized = null;
      }

      try {
        const unlisten = await appWindow.onMoved(() => {
          if (moveTimer !== undefined) clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            moveTimer = undefined;
            void captureWindowState();
          }, WINDOW_EVENT_SETTLE_MS);
        });
        assignWindowListener('move', unlisten);
      } catch {
        unlistenMoved = null;
      }
    })();
  }

  function cleanupWindowEventListeners(): void {
    listenersDisposed = true;
    if (resizeTimer !== undefined) {
      clearTimeout(resizeTimer);
      resizeTimer = undefined;
    }

    if (moveTimer !== undefined) {
      clearTimeout(moveTimer);
      moveTimer = undefined;
    }

    unlistenFocusChanged?.();
    unlistenResized?.();
    unlistenMoved?.();
    unlistenFocusChanged = null;
    unlistenResized = null;
    unlistenMoved = null;
  }

  async function registerCloseRequestedHandler(): Promise<() => void> {
    let allowClose = false;
    let handlingClose = false;

    return appWindow.onCloseRequested(async (event) => {
      await captureWindowState();
      await saveState();

      if (allowClose) return;
      if (handlingClose) {
        event.preventDefault();
        return;
      }

      const runningCount = await invoke<number>(IPC.CountRunningAgents).catch(() => 0);
      if (runningCount <= 0) return;

      event.preventDefault();
      handlingClose = true;
      try {
        const countLabel =
          runningCount === 1
            ? '1 running terminal session'
            : `${runningCount} running terminal sessions`;
        const shouldKill = await confirm(
          `You have ${countLabel}. They can be restored on app restart. Kill them and quit, or keep them alive in the background?`,
          {
            title: 'Running Terminals',
            kind: 'warning',
            okLabel: 'Kill & Quit',
            cancelLabel: 'Keep in Background',
          },
        ).catch(() => false);

        if (shouldKill) {
          await invoke(IPC.KillAllAgents).catch(console.error);
          allowClose = true;
          await appWindow.close().catch(console.error);
          return;
        }

        await appWindow.hide().catch(console.error);
      } finally {
        handlingClose = false;
      }
    });
  }

  return {
    captureWindowState,
    cleanupWindowEventListeners,
    registerCloseRequestedHandler,
    registerWindowEventListeners,
    restoreWindowState,
    setupWindowChrome,
    syncWindowFocused,
    syncWindowMaximized,
  };
}
