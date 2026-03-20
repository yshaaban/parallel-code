import '@xterm/xterm/css/xterm.css';
import './styles.css';
import {
  ErrorBoundary,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import {
  clearConfirmNotifier,
  getPendingConfirm,
  registerConfirmNotifier,
  resolvePendingConfirm,
  resolvePendingPathInput,
} from './lib/dialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DisplayNameDialog } from './components/DisplayNameDialog';
import { Sidebar } from './components/Sidebar';
import { TilingLayout } from './components/TilingLayout';
import { NewTaskDialog } from './components/NewTaskDialog';
import { HelpDialog } from './components/HelpDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { TerminalStartupChip } from './components/TerminalStartupChip';
import { WindowTitleBar } from './components/WindowTitleBar';
import { WindowResizeHandles } from './components/WindowResizeHandles';
import { AppConnectionBanner } from './components/app-shell/AppConnectionBanner';
import { openNewTaskDialog } from './app/new-task-dialog-workflows';
import { AppErrorFallback } from './components/app-shell/AppErrorFallback';
import { AppNotificationToast } from './components/app-shell/AppNotificationToast';
import { AppTakeoverRequestStack } from './components/app-shell/AppTakeoverRequestStack';
import { SidebarRevealRail } from './components/app-shell/SidebarRevealRail';
import { getAppStartupSummary } from './app/app-startup-status';
import { getStoredDisplayName, setStoredDisplayName } from './lib/display-name';
import { isElectronRuntime } from './lib/ipc';
import { theme } from './lib/theme';
import { OPEN_DISPLAY_NAME_DIALOG_ACTION } from './app/app-action-keys';
import {
  clearNotification,
  getGlobalScale,
  listIncomingTaskTakeoverRequests,
  registerAction,
  setNewTaskDropUrl,
  store,
  toggleArena,
  toggleHelpDialog,
  toggleNewTaskDialog,
  toggleSettingsDialog,
  toggleSidebar,
  unregisterAction,
} from './store/store';
import { setStore } from './store/state';
import { isMac, mod } from './lib/platform';
import { ArenaOverlay } from './arena/ArenaOverlay';
import { PathInputDialog } from './components/PathInputDialog';
import {
  expireIncomingTaskCommandTakeoverRequest,
  respondToIncomingTaskCommandTakeover,
} from './app/task-command-lease';
import {
  clearBusyTaskCommandTakeoverRequest,
  markBusyTaskCommandTakeoverRequest,
  syncBusyTaskCommandTakeoverRequests,
} from './domain/task-command-takeover-busy-state';
import { createBrowserPresenceRuntime } from './runtime/browser-presence';
import { type ConnectionBanner } from './runtime/browser-session';
import { createGitHubDragDropRuntime } from './runtime/drag-drop';
import { getConnectionBannerText, startDesktopAppSession } from './app/desktop-session';

function DropOverlay(): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: '0',
        background: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '16px',
        'z-index': '9999',
        'pointer-events': 'none',
        'backdrop-filter': 'blur(4px)',
      }}
    >
      <svg
        width="48"
        height="48"
        viewBox="0 0 16 16"
        fill={theme.accent}
        style={{ opacity: '0.9' }}
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span
        style={{
          color: theme.fg,
          'font-size': '16px',
          'font-weight': '600',
          'font-family': 'var(--font-ui)',
        }}
      >
        Drop GitHub link to create task
      </span>
      <span
        style={{
          color: theme.fgMuted,
          'font-size': '12px',
          'font-family': 'var(--font-ui)',
        }}
      >
        A new task will be created with the link in the prompt
      </span>
    </div>
  );
}

function App(): JSX.Element {
  type DisplayNameDialogMode = 'edit' | 'required';

  let mainRef!: HTMLDivElement;
  const electronRuntime = isElectronRuntime();
  const initialDisplayName = electronRuntime ? '' : (getStoredDisplayName() ?? '');
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [windowMaximized, setWindowMaximized] = createSignal(false);
  const [showDropOverlay, setShowDropOverlay] = createSignal(false);
  const [showPathInput, setShowPathInput] = createSignal(false);
  const [pathInputIsDir, setPathInputIsDir] = createSignal(false);
  const [showConfirm, setShowConfirm] = createSignal(false);
  const [connectionBanner, setConnectionBanner] = createSignal<ConnectionBanner | null>(null);
  const [busyTakeoverRequestIds, setBusyTakeoverRequestIds] = createSignal<Set<string>>(new Set());
  const [displayName, setDisplayName] = createSignal(initialDisplayName);
  const [displayNameDialogMode, setDisplayNameDialogMode] =
    createSignal<DisplayNameDialogMode>('required');
  const [showDisplayNameDialog, setShowDisplayNameDialog] = createSignal(
    !electronRuntime && initialDisplayName.trim().length === 0,
  );
  const appStartupSummary = createMemo(() => getAppStartupSummary());
  const displayNameDialogStartupSummary = createMemo(() =>
    displayNameDialogMode() === 'required' ? appStartupSummary() : null,
  );
  const incomingTakeoverRequests = createMemo(() => listIncomingTaskTakeoverRequests());

  function clearBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      clearBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  function markBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      markBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  createEffect(() => {
    const currentRequestIds = new Set(
      incomingTakeoverRequests().map((request) => request.requestId),
    );
    setBusyTakeoverRequestIds((currentBusyRequestIds) =>
      syncBusyTaskCommandTakeoverRequests(currentBusyRequestIds, currentRequestIds),
    );
  });

  function handleGitHubUrl(url: string): void {
    setNewTaskDropUrl(url);
    openNewTaskDialog();
  }

  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop } =
    createGitHubDragDropRuntime({
      isDropOverlayVisible: showDropOverlay,
      onGitHubUrl: handleGitHubUrl,
      setDropOverlayVisible(visible) {
        setShowDropOverlay(visible);
      },
    });

  // Sync theme preset to <html> so Portal content inherits CSS variables
  createEffect(() => {
    document.documentElement.dataset.look = store.themePreset;
  });

  createEffect(() => {
    if (electronRuntime) {
      return;
    }

    if (displayName().trim().length > 0) {
      return;
    }

    setDisplayNameDialogMode('required');
    setShowDisplayNameDialog(true);
  });

  function openDisplayNameDialog(): void {
    setDisplayNameDialogMode('edit');
    setShowDisplayNameDialog(true);
  }

  function closeDisplayNameDialog(): void {
    if (displayNameDialogMode() !== 'edit') {
      return;
    }

    setShowDisplayNameDialog(false);
  }

  async function handleTaskTakeoverResponse(requestId: string, approved: boolean): Promise<void> {
    markBusyTakeoverRequest(requestId);
    const handled = await respondToIncomingTaskCommandTakeover(requestId, approved).catch(
      () => false,
    );
    if (!handled) {
      clearBusyTakeoverRequest(requestId);
    }
  }

  onMount(() => {
    registerConfirmNotifier(() => {
      setShowConfirm(Boolean(getPendingConfirm()));
    });
    if (!electronRuntime) {
      createBrowserPresenceRuntime({
        getDisplayName: displayName,
      });
      registerAction(OPEN_DISPLAY_NAME_DIALOG_ACTION, openDisplayNameDialog);
    }
    if (electronRuntime && !store.hasSeenDesktopIntro) {
      setStore('hasSeenDesktopIntro', true);
      toggleHelpDialog(true);
    }
    const cleanupSession = startDesktopAppSession({
      electronRuntime,
      mainElement: mainRef,
      setConnectionBanner,
      setPathInputDialog(next) {
        setPathInputIsDir(next.directory);
        setShowPathInput(next.open);
      },
      windowFocused,
      setWindowFocused,
      setWindowMaximized,
    });
    onCleanup(() => {
      clearConfirmNotifier();
      if (!electronRuntime) {
        unregisterAction(OPEN_DISPLAY_NAME_DIALOG_ACTION);
      }
      cleanupSession();
    });
  });

  return (
    <ErrorBoundary fallback={(err, reset) => <AppErrorFallback error={err} onReset={reset} />}>
      <div
        ref={mainRef}
        class="app-shell"
        data-look={store.themePreset}
        data-window-border={electronRuntime && !isMac ? 'true' : 'false'}
        data-window-focused={windowFocused() ? 'true' : 'false'}
        data-window-maximized={windowMaximized() ? 'true' : 'false'}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          '--inactive-column-opacity': store.inactiveColumnOpacity,
          width: `${100 / getGlobalScale()}vw`,
          height: `${100 / getGlobalScale()}vh`,
          transform: `scale(${getGlobalScale()})`,
          'transform-origin': '0 0',
          display: 'flex',
          'flex-direction': 'column',
          position: 'relative',
          background: theme.bg,
          color: theme.fg,
          'font-family': "var(--font-ui, 'Sora', sans-serif)",
          'font-size': '13px',
          overflow: 'hidden',
        }}
      >
        <Show when={electronRuntime && !isMac}>
          <WindowTitleBar />
        </Show>
        <Show when={electronRuntime && isMac}>
          <div class="mac-titlebar-spacer" data-tauri-drag-region />
        </Show>
        <Show when={!electronRuntime && connectionBanner()}>
          {(banner) => (
            <AppConnectionBanner
              message={getConnectionBannerText(banner())}
              state={banner().state}
            />
          )}
        </Show>
        <main style={{ flex: '1', display: 'flex', overflow: 'hidden' }}>
          <Show when={store.sidebarVisible}>
            <Sidebar />
          </Show>
          <Show when={!store.sidebarVisible}>
            <SidebarRevealRail onClick={toggleSidebar} shortcutLabel={`${mod}+B`} />
          </Show>
          <TilingLayout />
          <NewTaskDialog
            open={store.showNewTaskDialog}
            onClose={() => toggleNewTaskDialog(false)}
          />
        </main>
        <Show when={electronRuntime && !isMac}>
          <WindowResizeHandles />
        </Show>
        <Show when={showPathInput()}>
          <PathInputDialog
            open={showPathInput()}
            directory={pathInputIsDir()}
            onSubmit={(path) => {
              setShowPathInput(false);
              resolvePendingPathInput(path);
            }}
            onCancel={() => {
              setShowPathInput(false);
              resolvePendingPathInput(null);
            }}
          />
        </Show>
        <Show when={showConfirm() && getPendingConfirm()}>
          {(request) => (
            <ConfirmDialog
              open={showConfirm()}
              title={request().options.title ?? 'Confirm'}
              message={request().message}
              confirmLabel={request().options.okLabel}
              cancelLabel={request().options.cancelLabel}
              danger={request().options.kind === 'warning'}
              onConfirm={() => {
                setShowConfirm(false);
                resolvePendingConfirm(true);
              }}
              onCancel={() => {
                setShowConfirm(false);
                resolvePendingConfirm(false);
              }}
            />
          )}
        </Show>
        <DisplayNameDialog
          open={showDisplayNameDialog()}
          allowClose={displayNameDialogMode() === 'edit'}
          confirmLabel={displayNameDialogMode() === 'edit' ? 'Save name' : 'Continue'}
          initialValue={displayName()}
          onClose={closeDisplayNameDialog}
          onSave={(value) => {
            const nextDisplayName = setStoredDisplayName(value);
            setDisplayName(nextDisplayName);
            setShowDisplayNameDialog(false);
          }}
          startupSummary={displayNameDialogStartupSummary()}
          title={displayNameDialogMode() === 'edit' ? 'Edit session name' : undefined}
        />
        <AppTakeoverRequestStack
          busyRequestIds={busyTakeoverRequestIds()}
          onApprove={(requestId) => {
            void handleTaskTakeoverResponse(requestId, true);
          }}
          onDeny={(requestId) => {
            void handleTaskTakeoverResponse(requestId, false);
          }}
          onExpire={(requestId) => {
            expireIncomingTaskCommandTakeoverRequest(requestId);
            clearBusyTakeoverRequest(requestId);
          }}
          requests={incomingTakeoverRequests()}
        />
        <HelpDialog
          open={store.showHelpDialog}
          onClose={() => toggleHelpDialog(false)}
          showIntro={electronRuntime}
        />
        <SettingsDialog
          open={store.showSettingsDialog}
          onClose={() => toggleSettingsDialog(false)}
        />
        <Show when={store.showArena}>
          <ArenaOverlay onClose={() => toggleArena(false)} />
        </Show>
        <Show when={showDropOverlay()}>
          <DropOverlay />
        </Show>
        <Show when={store.notification}>
          {(message) => <AppNotificationToast message={message()} onDismiss={clearNotification} />}
        </Show>
        <TerminalStartupChip />
      </div>
    </ErrorBoundary>
  );
}

export default App;
