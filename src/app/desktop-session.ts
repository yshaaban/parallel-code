import { createSignal } from 'solid-js';

import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
import { isGitHubUrl } from '../lib/github-url';
import { isMac } from '../lib/platform';
import { createCtrlWheelZoomHandler } from '../lib/wheelZoom';
import { createBrowserStateSync } from '../runtime/server-sync';
import { createWindowSessionRuntime } from '../runtime/window-session';
import { saveClientSessionState } from '../store/client-session';
import { saveBrowserWorkspaceState, saveState } from '../store/persistence-save';
import { store } from '../store/state';
import { setNewTaskDropUrl } from '../store/tasks';
import { adjustGlobalScale } from '../store/ui';
import { toggleNewTaskDialog } from '../store/navigation';
import {
  getTaskNotificationCapability,
  initializeTaskNotificationCapabilityRuntime,
} from './task-notification-capabilities';
import { startTaskNotificationRuntime } from './task-notification-runtime';
import {
  createElectronTaskNotificationSink,
  createWebTaskNotificationSink,
} from './task-notification-sinks';
import { createSessionBootstrapController } from './session-bootstrap-controller';
import {
  createDesktopSessionResources,
  disposeDesktopSessionResources,
} from './desktop-session-resources';
import { runDesktopSessionStartup } from './desktop-session-startup';
import type { BrowserStateSyncApi, StartDesktopAppSessionOptions } from './desktop-session-types';
import { getConnectionBannerText } from './desktop-browser-runtime';

function openNewTaskDialogFromGitHubUrl(text: string): void {
  setNewTaskDropUrl(text);
  toggleNewTaskDialog(true);
}

export function startDesktopAppSession(options: StartDesktopAppSessionOptions): () => void {
  const {
    cleanupBrowserStateSyncTimer,
    scheduleBrowserStateSync,
    syncBrowserStateFromReconnectSnapshot,
  } = createBrowserStateSync(options.electronRuntime);

  const {
    captureWindowState,
    cleanupWindowEventListeners,
    registerCloseRequestedHandler,
    registerWindowEventListeners,
    restoreWindowState,
    setupWindowChrome,
    syncWindowFocused,
    syncWindowMaximized,
  } = createWindowSessionRuntime({
    electronRuntime: options.electronRuntime,
    isMac,
    setWindowFocused: options.setWindowFocused,
    setWindowMaximized: options.setWindowMaximized,
  });

  let disposed = false;
  const bootstrapController = createSessionBootstrapController(options.electronRuntime);
  const resources = createDesktopSessionResources();
  const [taskNotificationsArmed, setTaskNotificationsArmed] = createSignal(false);
  void initializeTaskNotificationCapabilityRuntime(options.electronRuntime);
  const stopTaskNotificationRuntime = startTaskNotificationRuntime({
    capability: getTaskNotificationCapability,
    isNotificationsArmed: taskNotificationsArmed,
    isWindowFocused: options.windowFocused ?? (() => true),
    sink: options.electronRuntime
      ? createElectronTaskNotificationSink()
      : createWebTaskNotificationSink(),
  });

  function armTaskNotifications(): void {
    setTaskNotificationsArmed(true);
  }

  function disarmTaskNotifications(): void {
    setTaskNotificationsArmed(false);
  }

  if (!options.electronRuntime) {
    registerPathInputNotifier(() => {
      const pending = getPendingPathInput();
      if (!pending) return;
      options.setPathInputDialog({
        open: true,
        directory: pending.options.directory ?? false,
      });
    });
  }

  const handlePaste = (event: ClipboardEvent) => {
    if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      (activeElement instanceof HTMLElement && activeElement.isContentEditable) ||
      activeElement?.closest?.('.xterm')
    ) {
      return;
    }

    const text = event.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;
    if (!isGitHubUrl(text)) return;

    event.preventDefault();
    openNewTaskDialogFromGitHubUrl(text);
  };
  document.addEventListener('paste', handlePaste);

  const handleWheel = createCtrlWheelZoomHandler((delta) => {
    adjustGlobalScale(delta);
  });
  options.mainElement.addEventListener('wheel', handleWheel, { passive: false });

  const handlePageHide = () => {
    if (options.electronRuntime) {
      void saveState();
      return;
    }

    void saveBrowserWorkspaceState();
    saveClientSessionState();
  };
  window.addEventListener('pagehide', handlePageHide);

  void (async () => {
    await runDesktopSessionStartup(
      options,
      resources,
      bootstrapController,
      {
        scheduleBrowserStateSync,
        syncBrowserStateFromReconnectSnapshot,
      } satisfies BrowserStateSyncApi,
      {
        captureWindowState,
        cleanupWindowEventListeners,
        registerCloseRequestedHandler,
        registerWindowEventListeners,
        restoreWindowState,
        setupWindowChrome,
        syncWindowFocused,
        syncWindowMaximized,
      },
      {
        arm: armTaskNotifications,
        disarm: disarmTaskNotifications,
      },
      () => disposed,
    );
  })();

  return () => {
    disposed = true;
    disarmTaskNotifications();
    bootstrapController.dispose();
    cleanupBrowserStateSyncTimer();
    if (!options.electronRuntime) {
      clearPathInputNotifier();
    }
    document.removeEventListener('paste', handlePaste);
    options.mainElement.removeEventListener('wheel', handleWheel);
    window.removeEventListener('pagehide', handlePageHide);
    disposeDesktopSessionResources(resources);
    cleanupWindowEventListeners();
    stopTaskNotificationRuntime();
  };
}

export { getConnectionBannerText };
