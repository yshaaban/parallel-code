import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
  untrack,
} from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { isElectronRuntime } from '../lib/ipc';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { store } from '../store/store';
import { startRemoteAccess, stopRemoteAccess } from '../app/remote-access';

type NetworkMode = 'wifi' | 'tailscale';

interface ConnectPhoneModalProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectPhoneModal(props: ConnectPhoneModalProps): JSX.Element {
  const titleId = createUniqueId();
  const electronRuntime = isElectronRuntime();
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [qrError, setQrError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [mode, setMode] = createSignal<NetworkMode>('wifi');
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let qrGeneration = 0;
  onCleanup(() => {
    clearCopiedTimer();
    invalidateQrGeneration();
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

  function getQrPlaceholderBorder(): string {
    return qrError() ? theme.error : theme.border;
  }

  function getQrPlaceholderText(): string {
    return qrError() ?? 'Generating QR code...';
  }

  function getQrPlaceholderTone(): string {
    return qrError() ? theme.error : theme.fgMuted;
  }

  function nextQrGeneration(): number {
    qrGeneration += 1;
    return qrGeneration;
  }

  function invalidateQrGeneration(): void {
    qrGeneration += 1;
  }

  function clearCopiedTimer(): void {
    if (copiedTimer === undefined) {
      return;
    }

    clearTimeout(copiedTimer);
    copiedTimer = undefined;
  }

  async function generateQr(url: string): Promise<void> {
    const generation = nextQrGeneration();
    try {
      const mod = await import('qrcode');
      const QRCode = mod.default ?? mod;
      // QR codes must stay true black-on-white for reliable scanning, so these are intentionally
      // not theme tokens.
      const dataUrl = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      if (generation !== qrGeneration) {
        return;
      }

      setQrDataUrl(dataUrl);
      setQrError(null);
    } catch (error) {
      if (generation !== qrGeneration) {
        return;
      }

      console.error('[ConnectPhoneModal] QR generation failed:', error);
      setQrDataUrl(null);
      setQrError('QR code unavailable');
    }
  }

  createEffect(() => {
    const url = activeUrl();
    if (!props.open || !url) {
      invalidateQrGeneration();
      setQrDataUrl(null);
      setQrError(null);
      return;
    }

    setQrDataUrl(null);
    setQrError(null);
    void generateQr(url);
  });

  // Start the server when the modal opens. Focus/Esc/stacking are handled by the Dialog base.
  createEffect(() => {
    if (!props.open) {
      return;
    }

    if (!store.remoteAccess.enabled && !untrack(starting)) {
      setStarting(true);
      setError(null);
      startRemoteAccess()
        .then((result) => {
          setStarting(false);
          setMode(result.tailscaleUrl && !result.wifiUrl ? 'tailscale' : 'wifi');
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
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearCopiedTimer();
      copiedTimer = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  }

  function getPillStyle(active: boolean): JSX.CSSProperties {
    return {
      padding: '6px 14px',
      'border-radius': '6px',
      border: 'none',
      cursor: 'pointer',
      background: active ? theme.accent : 'transparent',
      color: active ? theme.accentText : theme.fgMuted,
      ...(active ? typography.metaStrong : typography.meta),
    };
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="380px"
      labelledBy={titleId}
      panelStyle={{ gap: '20px', 'align-items': 'center' }}
    >
      <DialogHeader
        align="center"
        description={electronRuntime ? 'Experimental' : 'Current browser server'}
        title={electronRuntime ? 'Connect Phone' : 'Server Access'}
        titleId={titleId}
      />

      <Show when={starting()}>
        <div style={{ ...typography.ui, color: theme.fgMuted }}>
          {electronRuntime ? 'Starting server...' : 'Loading server info...'}
        </div>
      </Show>

      <Show when={error()}>
        <div style={{ ...typography.ui, color: theme.error, 'text-align': 'center' }}>
          {error()}
        </div>
      </Show>

      <Show when={!starting() && store.remoteAccess.enabled}>
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
              type="button"
              onClick={() => setMode('wifi')}
              disabled={!store.remoteAccess.wifiUrl}
              style={{
                ...getPillStyle(mode() === 'wifi' && !!store.remoteAccess.wifiUrl),
                ...(!store.remoteAccess.wifiUrl ? { opacity: '0.35', cursor: 'default' } : {}),
              }}
            >
              WiFi
            </button>
            <Show when={!store.remoteAccess.wifiUrl}>
              <span style={{ ...typography.label, color: theme.fgSubtle }}>Not detected</span>
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
              type="button"
              onClick={() => setMode('tailscale')}
              disabled={!store.remoteAccess.tailscaleUrl}
              style={{
                ...getPillStyle(mode() === 'tailscale' && !!store.remoteAccess.tailscaleUrl),
                ...(!store.remoteAccess.tailscaleUrl ? { opacity: '0.35', cursor: 'default' } : {}),
              }}
            >
              Tailscale
            </button>
            <Show when={!store.remoteAccess.tailscaleUrl}>
              <span style={{ ...typography.label, color: theme.fgSubtle }}>Not detected</span>
            </Show>
          </div>
        </div>

        <Show when={qrDataUrl()}>
          {(url) => (
            <img
              src={url()}
              alt="Connection QR code"
              style={{ width: '200px', height: '200px', 'border-radius': '8px' }}
            />
          )}
        </Show>
        <Show when={!qrDataUrl()}>
          <div
            role="status"
            aria-live="polite"
            aria-label={qrError() ?? 'Generating connection QR code'}
            style={{
              width: '200px',
              height: '200px',
              'border-radius': '8px',
              border: `1px solid ${getQrPlaceholderBorder()}`,
              background: theme.bgInput,
              color: getQrPlaceholderTone(),
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              'text-align': 'center',
              padding: '16px',
              ...typography.meta,
            }}
          >
            {getQrPlaceholderText()}
          </div>
        </Show>

        <button
          type="button"
          style={{
            display: 'block',
            width: '100%',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            padding: '10px 12px',
            ...typography.monoMeta,
            color: theme.fg,
            'word-break': 'break-all',
            'text-align': 'center',
            cursor: 'pointer',
          }}
          onClick={handleCopyUrl}
          title="Click to copy"
        >
          {activeUrl() ?? store.remoteAccess.url}
        </button>

        <Show when={copied()}>
          <span style={{ ...typography.meta, color: theme.success }}>Copied!</span>
        </Show>

        <p
          style={{
            ...typography.meta,
            color: theme.fgMuted,
            'text-align': 'center',
            margin: '0',
          }}
        >
          <Show
            when={electronRuntime}
            fallback={
              <>
                This browser session is already served by Parallel Code. Scan the QR code or copy a
                URL to open the same server from another device.
              </>
            }
          >
            <>
              Scan the QR code or copy the URL to monitor and interact with your agent terminals
              from your phone.
            </>
          </Show>
          <Show
            when={mode() === 'tailscale'}
            fallback={<> Your phone and this computer must be on the same WiFi network.</>}
          >
            <> Your phone and this computer must be on the same Tailscale network.</>
          </Show>
        </p>

        <Show
          when={connectedClientCount() > 0}
          fallback={
            <div
              style={{
                ...typography.meta,
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
            <span style={{ ...typography.uiStrong, color: theme.success }}>
              {connectedClientCount()} {electronRuntime ? 'client' : 'peer client'}
              {connectedClientCount() === 1 ? '' : 's'} connected
            </span>
          </div>
        </Show>

        <button
          type="button"
          onClick={handleDisconnect}
          style={{
            padding: '7px 16px',
            background: 'transparent',
            border: 'none',
            'border-radius': '8px',
            color: theme.fgSubtle,
            cursor: 'pointer',
            ...typography.meta,
          }}
        >
          {electronRuntime ? 'Disconnect' : 'Close'}
        </button>
      </Show>
    </Dialog>
  );
}
