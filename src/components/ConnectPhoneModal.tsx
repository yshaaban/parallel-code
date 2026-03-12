import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
  untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { createFocusRestore } from '../lib/focus-restore';
import { isElectronRuntime } from '../lib/ipc';
import { theme } from '../lib/theme';
import { store } from '../store/core';
import { startRemoteAccess, stopRemoteAccess } from '../store/remote';

type NetworkMode = 'wifi' | 'tailscale';

interface ConnectPhoneModalProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectPhoneModal(props: ConnectPhoneModalProps): JSX.Element {
  const electronRuntime = isElectronRuntime();
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [mode, setMode] = createSignal<NetworkMode>('wifi');
  let dialogRef: HTMLDivElement | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
  });

  const activeUrl = createMemo(() => {
    if (!store.remoteAccess.enabled) return null;
    if (mode() === 'tailscale') {
      return store.remoteAccess.tailscaleUrl ?? store.remoteAccess.url;
    }
    return store.remoteAccess.wifiUrl ?? store.remoteAccess.url;
  });
  const connectedClientCount = createMemo(() =>
    electronRuntime ? store.remoteAccess.connectedClients : store.remoteAccess.peerClients,
  );

  createFocusRestore(() => props.open);

  async function generateQr(url: string): Promise<void> {
    try {
      const QRCode = await import('qrcode');
      const dataUrl = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch {
      setQrDataUrl(null);
    }
  }

  // Regenerate QR when mode changes
  createEffect(() => {
    const url = activeUrl();
    if (url) {
      setQrDataUrl(null); // clear stale QR immediately
      generateQr(url);
    }
  });

  // Start server when modal opens
  createEffect(() => {
    if (!props.open) return;

    requestAnimationFrame(() => dialogRef?.focus());

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));

    if (!store.remoteAccess.enabled && !untrack(starting)) {
      setStarting(true);
      setError(null);
      startRemoteAccess()
        .then((result) => {
          setStarting(false);
          setMode(result.tailscaleUrl && !result.wifiUrl ? 'tailscale' : 'wifi');
          const url = result.wifiUrl ?? result.tailscaleUrl ?? result.url;
          generateQr(url);
        })
        .catch((err: unknown) => {
          setStarting(false);
          setError(err instanceof Error ? err.message : 'Failed to start server');
        });
    } else {
      // Re-derive mode if network changed since last open
      if (mode() === 'wifi' && !store.remoteAccess.wifiUrl && store.remoteAccess.tailscaleUrl) {
        setMode('tailscale');
      } else if (
        mode() === 'tailscale' &&
        !store.remoteAccess.tailscaleUrl &&
        store.remoteAccess.wifiUrl
      ) {
        setMode('wifi');
      }
      const url = activeUrl();
      if (url) generateQr(url);
    }
  });

  async function handleDisconnect(): Promise<void> {
    if (electronRuntime) {
      await stopRemoteAccess();
    }
    setQrDataUrl(null);
    props.onClose();
  }

  async function handleCopyUrl(): Promise<void> {
    const url = activeUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimer !== undefined) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  }

  const pillStyle = (active: boolean) => ({
    padding: '6px 14px',
    'border-radius': '6px',
    border: 'none',
    'font-size': '12px',
    cursor: 'pointer',
    background: active ? theme.accent : 'transparent',
    color: active ? '#fff' : theme.fgMuted,
    'font-weight': active ? '600' : '400',
  });

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="dialog-overlay"
          style={{
            position: 'fixed',
            inset: '0',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            background: 'rgba(0,0,0,0.55)',
            'z-index': '1000',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            ref={dialogRef}
            tabIndex={0}
            class="dialog-panel"
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': '14px',
              padding: '28px',
              width: '380px',
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '20px',
              outline: 'none',
              'box-shadow': '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ 'text-align': 'center' }}>
              <h2
                style={{ margin: '0', 'font-size': '16px', color: theme.fg, 'font-weight': '600' }}
              >
                {electronRuntime ? 'Connect Phone' : 'Server Access'}
              </h2>
              <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
                {electronRuntime ? 'Experimental' : 'Current browser server'}
              </span>
            </div>

            <Show when={starting()}>
              <div style={{ color: theme.fgMuted, 'font-size': '13px' }}>
                {electronRuntime ? 'Starting server...' : 'Loading server info...'}
              </div>
            </Show>

            <Show when={error()}>
              <div style={{ color: theme.error, 'font-size': '13px', 'text-align': 'center' }}>
                {error()}
              </div>
            </Show>

            <Show when={!starting() && store.remoteAccess.enabled}>
              {/* Network mode toggle */}
              <div
                style={{
                  display: 'flex',
                  gap: '4px',
                  background: theme.bgInput,
                  'border-radius': '8px',
                  padding: '3px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    'align-items': 'center',
                    gap: '2px',
                  }}
                >
                  <button
                    onClick={() => setMode('wifi')}
                    disabled={!store.remoteAccess.wifiUrl}
                    style={{
                      ...pillStyle(mode() === 'wifi' && !!store.remoteAccess.wifiUrl),
                      ...(!store.remoteAccess.wifiUrl
                        ? { opacity: '0.35', cursor: 'default' }
                        : {}),
                    }}
                  >
                    WiFi
                  </button>
                  <Show when={!store.remoteAccess.wifiUrl}>
                    <span style={{ 'font-size': '9px', color: theme.fgSubtle }}>Not detected</span>
                  </Show>
                </div>
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    'align-items': 'center',
                    gap: '2px',
                  }}
                >
                  <button
                    onClick={() => setMode('tailscale')}
                    disabled={!store.remoteAccess.tailscaleUrl}
                    style={{
                      ...pillStyle(mode() === 'tailscale' && !!store.remoteAccess.tailscaleUrl),
                      ...(!store.remoteAccess.tailscaleUrl
                        ? { opacity: '0.35', cursor: 'default' }
                        : {}),
                    }}
                  >
                    Tailscale
                  </button>
                  <Show when={!store.remoteAccess.tailscaleUrl}>
                    <span style={{ 'font-size': '9px', color: theme.fgSubtle }}>Not detected</span>
                  </Show>
                </div>
              </div>

              {/* QR Code */}
              <Show when={qrDataUrl()}>
                {(url) => (
                  <img
                    src={url()}
                    alt="Connection QR code"
                    style={{ width: '200px', height: '200px', 'border-radius': '8px' }}
                  />
                )}
              </Show>

              {/* URL */}
              <div
                style={{
                  width: '100%',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  padding: '10px 12px',
                  'font-size': '12px',
                  'font-family': "'JetBrains Mono', monospace",
                  color: theme.fg,
                  'word-break': 'break-all',
                  'text-align': 'center',
                  cursor: 'pointer',
                }}
                onClick={handleCopyUrl}
                title="Click to copy"
              >
                {activeUrl() ?? store.remoteAccess.url}
              </div>

              <Show when={copied()}>
                <span style={{ 'font-size': '12px', color: theme.success }}>Copied!</span>
              </Show>

              {/* Instructions */}
              <p
                style={{
                  'font-size': '12px',
                  color: theme.fgMuted,
                  'text-align': 'center',
                  margin: '0',
                  'line-height': '1.5',
                }}
              >
                <Show
                  when={electronRuntime}
                  fallback={
                    <>
                      This browser session is already served by Parallel Code. Scan the QR code or
                      copy a URL to open the same server from another device.
                    </>
                  }
                >
                  <>
                    Scan the QR code or copy the URL to monitor and interact with your agent
                    terminals from your phone.
                  </>
                </Show>
                <Show
                  when={mode() === 'tailscale'}
                  fallback={<> Your phone and this computer must be on the same WiFi network.</>}
                >
                  <> Your phone and this computer must be on the same Tailscale network.</>
                </Show>
              </p>

              {/* Connected clients */}
              <Show
                when={connectedClientCount() > 0}
                fallback={
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.fgSubtle,
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                    }}
                  >
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        'border-radius': '50%',
                        background: theme.fgSubtle,
                      }}
                    />
                    Waiting for connection...
                  </div>
                }
              >
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    'align-items': 'center',
                    gap: '8px',
                  }}
                >
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={theme.success}
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span style={{ 'font-size': '14px', color: theme.success, 'font-weight': '500' }}>
                    {connectedClientCount()} {electronRuntime ? 'client' : 'peer client'}
                    {connectedClientCount() === 1 ? '' : 's'} connected
                  </span>
                </div>
              </Show>

              <button
                onClick={handleDisconnect}
                style={{
                  padding: '7px 16px',
                  background: 'transparent',
                  border: 'none',
                  'border-radius': '8px',
                  color: theme.fgSubtle,
                  cursor: 'pointer',
                  'font-size': '12px',
                  'font-weight': '400',
                }}
              >
                {electronRuntime ? 'Disconnect' : 'Close'}
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </Portal>
  );
}
