import '@xterm/xterm/css/xterm.css';
import './styles.css';
import {
  ErrorBoundary,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { resolvePendingPathInput } from './lib/dialog';
import { isElectronRuntime } from './lib/ipc';
import { Sidebar } from './components/Sidebar';
import { TilingLayout } from './components/TilingLayout';
import { NewTaskDialog } from './components/NewTaskDialog';
import { HelpDialog } from './components/HelpDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { WindowTitleBar } from './components/WindowTitleBar';
import { WindowResizeHandles } from './components/WindowResizeHandles';
import { theme } from './lib/theme';
import {
  store,
  toggleNewTaskDialog,
  toggleSidebar,
  toggleArena,
  getGlobalScale,
  toggleHelpDialog,
  toggleSettingsDialog,
  clearNotification,
  setNewTaskDropUrl,
} from './store/store';
import { isMac, mod } from './lib/platform';
import { ArenaOverlay } from './arena/ArenaOverlay';
import { PathInputDialog } from './components/PathInputDialog';
import { type ConnectionBanner, type ConnectionBannerState } from './runtime/browser-session';
import { createGitHubDragDropRuntime } from './runtime/drag-drop';
import { getConnectionBannerText, startDesktopAppSession } from './app/desktop-session';

function getConnectionBannerBackground(state: ConnectionBannerState): string {
  switch (state) {
    case 'auth-expired':
      return theme.error;
    case 'disconnected':
      return `${theme.error}20`;
    default:
      return `${theme.warning}20`;
  }
}

function getConnectionBannerAccent(state: ConnectionBannerState): string {
  switch (state) {
    case 'auth-expired':
    case 'disconnected':
      return theme.error;
    default:
      return theme.warning;
  }
}

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
  let mainRef!: HTMLDivElement;
  const electronRuntime = isElectronRuntime();
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [windowMaximized, setWindowMaximized] = createSignal(false);
  const [showDropOverlay, setShowDropOverlay] = createSignal(false);
  const [showPathInput, setShowPathInput] = createSignal(false);
  const [pathInputIsDir, setPathInputIsDir] = createSignal(false);
  const [connectionBanner, setConnectionBanner] = createSignal<ConnectionBanner | null>(null);

  function handleGitHubUrl(url: string): void {
    setNewTaskDropUrl(url);
    toggleNewTaskDialog(true);
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

  onMount(() => {
    const cleanupSession = startDesktopAppSession({
      electronRuntime,
      mainElement: mainRef,
      setConnectionBanner,
      setPathInputDialog(next) {
        setPathInputIsDir(next.directory);
        setShowPathInput(next.open);
      },
      setWindowFocused,
      setWindowMaximized,
    });
    onCleanup(cleanupSession);
  });

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div
          style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            'flex-direction': 'column',
            'align-items': 'center',
            'justify-content': 'center',
            gap: '16px',
            background: theme.bg,
            color: theme.fg,
            'font-family': "var(--font-ui, 'Sora', sans-serif)",
          }}
        >
          <div style={{ 'font-size': '18px', 'font-weight': '600', color: theme.error }}>
            Something went wrong
          </div>
          <div
            style={{
              'max-width': '500px',
              'text-align': 'center',
              color: theme.fgMuted,
              'word-break': 'break-word',
            }}
          >
            {String(err)}
          </div>
          <button
            onClick={reset}
            style={{
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '8px 24px',
              'border-radius': '8px',
              cursor: 'pointer',
              'font-size': '14px',
            }}
          >
            Reload
          </button>
        </div>
      )}
    >
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
            <div
              style={{
                padding: '8px 12px',
                'border-bottom': `1px solid ${theme.border}`,
                background: getConnectionBannerBackground(banner().state),
                color: getConnectionBannerAccent(banner().state),
                'font-size': '12px',
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  'border-radius': '50%',
                  background: getConnectionBannerAccent(banner().state),
                }}
              />
              <span>{getConnectionBannerText(banner())}</span>
            </div>
          )}
        </Show>
        <main style={{ flex: '1', display: 'flex', overflow: 'hidden' }}>
          <Show when={store.sidebarVisible}>
            <Sidebar />
          </Show>
          <Show when={!store.sidebarVisible}>
            <button
              class="icon-btn"
              onClick={() => toggleSidebar()}
              title={`Show sidebar (${mod}+B)`}
              style={{
                width: '24px',
                'min-width': '24px',
                height: 'calc(100% - 12px)',
                margin: '6px 4px 6px 0',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                cursor: 'pointer',
                color: theme.fgSubtle,
                background: 'transparent',
                'border-top': `2px dashed ${theme.border}`,
                'border-right': `2px dashed ${theme.border}`,
                'border-bottom': `2px dashed ${theme.border}`,
                'border-left': 'none',
                'border-radius': '0 12px 12px 0',
                'user-select': 'none',
                'flex-shrink': '0',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
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
        <HelpDialog open={store.showHelpDialog} onClose={() => toggleHelpDialog(false)} />
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
          <div
            onClick={() => clearNotification()}
            style={{
              position: 'fixed',
              bottom: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 20px',
              color: theme.fg,
              'font-size': '13px',
              'z-index': '2000',
              'box-shadow': '0 4px 24px rgba(0,0,0,0.4)',
              cursor: 'pointer',
            }}
          >
            {store.notification}
          </div>
        </Show>
      </div>
    </ErrorBoundary>
  );
}

export default App;
