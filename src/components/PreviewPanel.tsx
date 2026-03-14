import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import type { TaskExposedPort, TaskPortSnapshot } from '../domain/server-state';
import { buildTaskPreviewUrl } from '../app/task-ports';
import { theme } from '../lib/theme';

interface PreviewPanelProps {
  onExposeObservedPort: (port: number) => Promise<void> | void;
  onHide: () => void;
  onOpenExposeDialog: () => void;
  onRefreshPort: (port: number) => Promise<void> | void;
  onUnexposePort: (port: number) => Promise<void> | void;
  snapshot: TaskPortSnapshot;
  taskId: string;
}

interface UnavailablePreviewStateProps {
  message: string;
  onRetry: () => void;
}

interface PreviewActionButtonProps {
  children: JSX.Element;
  color?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}

function getExposedPortLabel(port: TaskPortSnapshot['exposed'][number]): string {
  return port.label ?? `Port ${port.port}`;
}

function getExposedPortCardBackground(
  isSelected: boolean,
  taskContainerBg: string,
  accent: string,
): string {
  if (isSelected) {
    return `color-mix(in srgb, ${accent} 12%, ${taskContainerBg})`;
  }

  return taskContainerBg;
}

function getPreviewAvailabilityColor(port: TaskExposedPort): string {
  switch (port.availability) {
    case 'available':
      return theme.success;
    case 'unavailable':
      return theme.error;
    default:
      return theme.fgMuted;
  }
}

function getPreviewAvailabilityLabel(port: TaskExposedPort): string {
  switch (port.availability) {
    case 'available':
      return 'Live';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Checking';
  }
}

function getObservedPortSourceLabel(
  source: TaskPortSnapshot['observed'][number]['source'],
): string {
  return source === 'rediscovery' ? 'Rediscovered' : 'Detected';
}

function getRetryPreviewLabel(port: number, isRefreshing: boolean): string {
  if (isRefreshing) {
    return `Checking preview for port ${port}`;
  }

  return `Retry preview for port ${port}`;
}

function PreviewActionButton(props: PreviewActionButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => {
        props.onClick();
      }}
      style={{
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        padding: '0',
        background: 'transparent',
        color: props.color ?? theme.fgMuted,
        border: `1px solid ${theme.border}`,
        'border-radius': '6px',
        cursor: props.disabled ? 'wait' : 'pointer',
        'flex-shrink': '0',
      }}
    >
      {props.children}
    </button>
  );
}

function HidePreviewIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 8h10v1H3zm3-4h1v8H6zm3 0h1v8H9z" />
    </svg>
  );
}

function ExposePortIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.5 2h1v4h4v1h-4v4h-1V7h-4V6h4z" />
    </svg>
  );
}

function OpenTabIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9 2h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9z" />
      <path d="M4 4h4v1H5v6h6v-3h1v4H4z" />
    </svg>
  );
}

function RetryIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 3a5 5 0 1 1-4.58 7H2.35A6 6 0 1 0 4.4 3.4L3 4.8V2h2.8L4.98 2.82A5.95 5.95 0 0 1 8 3z" />
    </svg>
  );
}

function UnexposeIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 4.7 4.7 4 8 7.3 11.3 4l.7.7L8.7 8l3.3 3.3-.7.7L8 8.7 4.7 12l-.7-.7L7.3 8z" />
    </svg>
  );
}

function UnavailablePreviewState(props: UnavailablePreviewStateProps): JSX.Element {
  return (
    <div
      style={{
        flex: '1',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        color: theme.fgMuted,
        'font-size': '11px',
        padding: '16px',
        'text-align': 'center',
      }}
    >
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <div>{props.message}</div>
        <button
          type="button"
          onClick={() => {
            props.onRetry();
          }}
          style={{
            'align-self': 'center',
            background: theme.bgElevated,
            color: theme.fg,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '5px 9px',
            cursor: 'pointer',
            'font-size': '11px',
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export function PreviewPanel(props: PreviewPanelProps): JSX.Element {
  const [selectedPort, setSelectedPort] = createSignal<number | null>(null);
  const [busyPort, setBusyPort] = createSignal<number | null>(null);
  const [refreshingPort, setRefreshingPort] = createSignal<number | null>(null);
  const exposedPortSet = createMemo(() => new Set(props.snapshot.exposed.map((port) => port.port)));

  const selectedPreviewUrl = createMemo(() => {
    const port = selectedPort();
    return port === null ? null : buildTaskPreviewUrl(props.taskId, port);
  });
  const selectedExposedPort = createMemo(
    () => props.snapshot.exposed.find((port) => port.port === selectedPort()) ?? null,
  );

  createEffect(() => {
    const currentSelectedPort = selectedPort();
    const firstExposedPort = props.snapshot.exposed[0]?.port ?? null;
    if (
      currentSelectedPort !== null &&
      props.snapshot.exposed.some((port) => port.port === currentSelectedPort)
    ) {
      return;
    }

    setSelectedPort(firstExposedPort);
  });

  createEffect(() => {
    const port = selectedExposedPort();
    if (!port || port.availability !== 'unknown' || refreshingPort() === port.port) {
      return;
    }

    void handleRefreshPort(port.port);
  });

  async function handleExposeObservedPort(port: number): Promise<void> {
    setBusyPort(port);
    try {
      await props.onExposeObservedPort(port);
      setSelectedPort(port);
    } finally {
      setBusyPort(null);
    }
  }

  async function handleRefreshPort(port: number): Promise<void> {
    setRefreshingPort(port);
    try {
      await props.onRefreshPort(port);
    } finally {
      if (refreshingPort() === port) {
        setRefreshingPort(null);
      }
    }
  }

  async function handleUnexposePort(port: number): Promise<void> {
    setBusyPort(port);
    try {
      await props.onUnexposePort(port);
    } finally {
      setBusyPort(null);
    }
  }

  function openPreviewInNewTab(port: number): void {
    const previewUrl = buildTaskPreviewUrl(props.taskId, port);
    if (!previewUrl) {
      return;
    }

    window.open(previewUrl, '_blank', 'noopener');
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskPanelBg,
      }}
    >
      <div
        style={{
          padding: '4px 6px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '6px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <div style={{ color: theme.fg, 'font-size': '12px', 'font-weight': '700' }}>Preview</div>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <PreviewActionButton
            label="Hide preview"
            onClick={() => {
              props.onHide();
            }}
          >
            <HidePreviewIcon />
          </PreviewActionButton>
          <PreviewActionButton
            label="Expose a port"
            onClick={() => {
              props.onOpenExposeDialog();
            }}
          >
            <ExposePortIcon />
          </PreviewActionButton>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          'grid-template-columns': '220px 1fr',
          flex: '1',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '6px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            overflow: 'auto',
            'border-right': `1px solid ${theme.border}`,
          }}
        >
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div
              style={{ color: theme.fgMuted, 'font-size': '10px', 'text-transform': 'uppercase' }}
            >
              Exposed
            </div>
            <Show
              when={props.snapshot.exposed.length > 0}
              fallback={
                <div style={{ color: theme.fgMuted, 'font-size': '12px' }}>
                  No exposed ports yet.
                </div>
              }
            >
              <For each={props.snapshot.exposed}>
                {(port) => (
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '4px',
                      padding: '6px 7px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      background: getExposedPortCardBackground(
                        selectedPort() === port.port,
                        theme.taskContainerBg,
                        theme.accent,
                      ),
                    }}
                  >
                    <div style={{ display: 'flex', 'align-items': 'flex-start', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => setSelectedPort(port.port)}
                        style={{
                          flex: '1',
                          background: 'transparent',
                          border: 'none',
                          color: theme.fg,
                          padding: '0',
                          cursor: 'pointer',
                          display: 'flex',
                          'justify-content': 'space-between',
                          'align-items': 'center',
                          'font-size': '12px',
                          'font-weight': '600',
                          gap: '8px',
                          'text-align': 'left',
                        }}
                      >
                        <span>{getExposedPortLabel(port)}</span>
                        <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                          <span
                            style={{
                              color: getPreviewAvailabilityColor(port),
                              'font-size': '10px',
                              'font-weight': '600',
                            }}
                          >
                            {getPreviewAvailabilityLabel(port)}
                          </span>
                          <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>
                            :{port.port}
                          </span>
                        </span>
                      </button>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <PreviewActionButton
                          label={`Open preview in new tab for port ${port.port}`}
                          onClick={() => openPreviewInNewTab(port.port)}
                        >
                          <OpenTabIcon />
                        </PreviewActionButton>
                        <PreviewActionButton
                          label={getRetryPreviewLabel(port.port, refreshingPort() === port.port)}
                          disabled={refreshingPort() === port.port}
                          onClick={() => {
                            void handleRefreshPort(port.port);
                          }}
                        >
                          <RetryIcon />
                        </PreviewActionButton>
                        <PreviewActionButton
                          label={`Unexpose port ${port.port}`}
                          color={theme.error}
                          disabled={busyPort() === port.port}
                          onClick={() => {
                            void handleUnexposePort(port.port);
                          }}
                        >
                          <UnexposeIcon />
                        </PreviewActionButton>
                      </div>
                    </div>
                    <Show when={port.statusMessage}>
                      <div style={{ color: theme.fgMuted, 'font-size': '10px' }}>
                        {port.statusMessage}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={props.snapshot.observed.length > 0}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div
                style={{ color: theme.fgMuted, 'font-size': '10px', 'text-transform': 'uppercase' }}
              >
                Detected
              </div>
              <For each={props.snapshot.observed}>
                {(port) => (
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'flex-start',
                      gap: '6px',
                      padding: '6px 7px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      background: theme.taskContainerBg,
                    }}
                  >
                    <div
                      style={{
                        flex: '1',
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '4px',
                      }}
                    >
                      <div
                        style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}
                      >
                        <span
                          style={{ color: theme.fg, 'font-size': '12px', 'font-weight': '600' }}
                        >
                          Port {port.port}
                        </span>
                        <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>
                          {getObservedPortSourceLabel(port.source)}
                        </span>
                      </div>
                      <div
                        style={{
                          color: theme.fgMuted,
                          'font-size': '10px',
                          'word-break': 'break-word',
                        }}
                      >
                        {port.suggestion}
                      </div>
                    </div>
                    <Show when={!exposedPortSet().has(port.port)}>
                      <PreviewActionButton
                        label={`Expose port ${port.port}`}
                        disabled={busyPort() === port.port}
                        onClick={() => {
                          void handleExposeObservedPort(port.port);
                        }}
                      >
                        <ExposePortIcon />
                      </PreviewActionButton>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div style={{ height: '100%', display: 'flex', 'flex-direction': 'column' }}>
          <Show
            when={selectedExposedPort()}
            fallback={
              <div
                style={{
                  flex: '1',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  color: theme.fgMuted,
                  'font-size': '11px',
                  padding: '16px',
                  'text-align': 'center',
                }}
              >
                Select an exposed port to open a preview.
              </div>
            }
          >
            {(port) => (
              <Show
                when={port().availability !== 'unavailable' && selectedPreviewUrl()}
                fallback={
                  <UnavailablePreviewState
                    message={port().statusMessage ?? 'Preview unavailable.'}
                    onRetry={() => {
                      void handleRefreshPort(port().port);
                    }}
                  />
                }
              >
                {(previewUrl) => (
                  <iframe
                    title={`Task preview ${selectedPort() ?? ''}`}
                    src={previewUrl()}
                    style={{
                      border: 'none',
                      width: '100%',
                      height: '100%',
                      background: 'white',
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
