import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import type {
  TaskExposedPort,
  TaskPortExposureCandidate,
  TaskPortSnapshot,
  TaskPreviewAvailability,
} from '../domain/server-state';
import { buildTaskPreviewUrl } from '../app/task-ports';
import { theme } from '../lib/theme';

interface PreviewPanelProps {
  availableCandidates: ReadonlyArray<TaskPortExposureCandidate>;
  availableScanError: string | null;
  availableScanning: boolean;
  onExposePort: (port: number, label?: string) => Promise<void> | void;
  onHide: () => void;
  onRefreshAvailablePorts: () => Promise<void> | void;
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

interface AvailablePreviewPort {
  badges: string[];
  port: number;
  suggestion: string;
}

interface PreviewMessageCardProps {
  children: JSX.Element | string;
  color?: string;
  role?: 'status';
}

const TASK_PREVIEW_AVAILABILITY_COLORS: Record<TaskPreviewAvailability, string> = {
  available: theme.success,
  unavailable: theme.error,
  unknown: theme.fgMuted,
};

const TASK_PREVIEW_AVAILABILITY_LABELS: Record<TaskPreviewAvailability, string> = {
  available: 'Live',
  unavailable: 'Unavailable',
  unknown: 'Checking',
};

function normalizeDialogLabel(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function updatePortText(
  setPortText: (value: string) => void,
  event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement },
): void {
  setPortText(event.currentTarget.value.replace(/[^\d]/g, ''));
}

function getExposedPortLabel(port: TaskExposedPort): string {
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
  return TASK_PREVIEW_AVAILABILITY_COLORS[port.availability];
}

function getPreviewAvailabilityLabel(port: TaskExposedPort): string {
  return TASK_PREVIEW_AVAILABILITY_LABELS[port.availability];
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

function getAvailablePreviewPorts(
  candidates: ReadonlyArray<TaskPortExposureCandidate>,
  snapshot: TaskPortSnapshot,
  exposedPortSet: ReadonlySet<number>,
): AvailablePreviewPort[] {
  const portsByNumber = new Map<number, AvailablePreviewPort>();

  for (const candidate of candidates) {
    if (exposedPortSet.has(candidate.port)) {
      continue;
    }

    portsByNumber.set(candidate.port, {
      badges: [candidate.source === 'task' ? 'Task' : 'Local'],
      port: candidate.port,
      suggestion: candidate.suggestion,
    });
  }

  for (const observedPort of snapshot.observed) {
    if (exposedPortSet.has(observedPort.port)) {
      continue;
    }

    const sourceLabel = getObservedPortSourceLabel(observedPort.source);
    const existingPort = portsByNumber.get(observedPort.port);
    if (existingPort) {
      if (!existingPort.badges.includes(sourceLabel)) {
        existingPort.badges.push(sourceLabel);
      }
      continue;
    }

    portsByNumber.set(observedPort.port, {
      badges: [sourceLabel],
      port: observedPort.port,
      suggestion: observedPort.suggestion,
    });
  }

  return [...portsByNumber.values()].sort((left, right) => left.port - right.port);
}

function getAvailablePortBadgeColor(badge: string): string {
  switch (badge) {
    case 'Task':
      return theme.accent;
    case 'Local':
      return theme.fgMuted;
    case 'Detected':
    case 'Rediscovered':
      return theme.warning;
    default:
      return theme.fgMuted;
  }
}

function getAvailablePortsFallbackMessage(
  availableScanError: string | null,
  availableScanning: boolean,
): string {
  if (availableScanError) {
    return availableScanError;
  }

  if (availableScanning) {
    return 'Scanning for active local ports...';
  }

  return 'No active local ports were found yet.';
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

function PreviewMessageCard(props: PreviewMessageCardProps): JSX.Element {
  return (
    <div
      role={props.role}
      style={{
        background: theme.taskContainerBg,
        color: props.color ?? theme.fgMuted,
        border: `1px solid ${theme.border}`,
        'border-radius': '6px',
        padding: '8px 9px',
        'font-size': '11px',
        'line-height': '1.45',
      }}
    >
      {props.children}
    </div>
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

function RescanIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.75 8a5.25 5.25 0 0 1 8.96-3.71V2.75h1.5v4.5h-4.5v-1.5h2A3.75 3.75 0 1 0 11.75 8h1.5a5.25 5.25 0 1 1-10.5 0Z" />
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
  const [customPortText, setCustomPortText] = createSignal('');
  const [customLabelText, setCustomLabelText] = createSignal('');
  const [exposeErrorMessage, setExposeErrorMessage] = createSignal<string | null>(null);
  const exposedPortSet = createMemo(() => new Set(props.snapshot.exposed.map((port) => port.port)));
  const availablePorts = createMemo(() =>
    getAvailablePreviewPorts(props.availableCandidates, props.snapshot, exposedPortSet()),
  );
  const hasDetectedOnlyPorts = createMemo(
    () => props.availableCandidates.length === 0 && availablePorts().length > 0,
  );

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

  async function handleExposePort(port: number, label?: string): Promise<boolean> {
    setBusyPort(port);
    setExposeErrorMessage(null);

    try {
      await props.onExposePort(port, label);
      setSelectedPort(port);
      return true;
    } catch (error) {
      setExposeErrorMessage(error instanceof Error ? error.message : 'Failed to expose port');
      return false;
    } finally {
      setBusyPort(null);
    }
  }

  function clearCustomExposeDrafts(): void {
    setCustomPortText('');
    setCustomLabelText('');
  }

  function handleRefreshAvailablePorts(): void {
    void props.onRefreshAvailablePorts();
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

  function handleCustomPortInput(
    event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement },
  ): void {
    setExposeErrorMessage(null);
    updatePortText(setCustomPortText, event);
  }

  async function handleAvailablePortExpose(port: number): Promise<void> {
    const didExpose = await handleExposePort(port, normalizeDialogLabel(customLabelText()));
    if (!didExpose) {
      return;
    }

    clearCustomExposeDrafts();
  }

  async function handleCustomExpose(): Promise<void> {
    const port = Number.parseInt(customPortText(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setExposeErrorMessage('Enter a valid port between 1 and 65535.');
      return;
    }

    const didExpose = await handleExposePort(port, normalizeDialogLabel(customLabelText()));
    if (!didExpose) {
      return;
    }

    clearCustomExposeDrafts();
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
            label={props.availableScanning ? 'Scanning ports' : 'Rescan ports'}
            disabled={props.availableScanning}
            onClick={handleRefreshAvailablePorts}
          >
            <RescanIcon />
          </PreviewActionButton>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          'grid-template-columns': '240px 1fr',
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
              Live preview ports
            </div>
            <Show
              when={props.snapshot.exposed.length > 0}
              fallback={
                <div
                  style={{
                    color: theme.fgMuted,
                    'font-size': '12px',
                    padding: '2px 0',
                    'line-height': '1.45',
                  }}
                >
                  No exposed ports yet. Expose one below to open a preview here.
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

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                gap: '8px',
              }}
            >
              <div
                style={{ color: theme.fgMuted, 'font-size': '10px', 'text-transform': 'uppercase' }}
              >
                Available to expose
              </div>
              <button
                type="button"
                disabled={props.availableScanning}
                onClick={handleRefreshAvailablePorts}
                style={{
                  background: 'transparent',
                  color: theme.fgMuted,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '999px',
                  padding: '2px 8px',
                  cursor: props.availableScanning ? 'wait' : 'pointer',
                  'font-size': '10px',
                  'font-weight': '600',
                }}
              >
                {props.availableScanning ? 'Scanning' : 'Rescan'}
              </button>
            </div>
            <Show
              when={availablePorts().length > 0}
              fallback={
                <PreviewMessageCard color={props.availableScanError ? theme.error : theme.fgMuted}>
                  {getAvailablePortsFallbackMessage(
                    props.availableScanError,
                    props.availableScanning,
                  )}
                </PreviewMessageCard>
              }
            >
              <Show when={props.availableScanError}>
                {(scanError) => (
                  <PreviewMessageCard role="status" color={theme.error}>
                    {scanError()}
                  </PreviewMessageCard>
                )}
              </Show>
              <Show
                when={
                  !props.availableScanError && !props.availableScanning && hasDetectedOnlyPorts()
                }
              >
                <PreviewMessageCard role="status">
                  No active local listeners were found in the latest scan. Ports below were detected
                  from task output and may be stale.
                </PreviewMessageCard>
              </Show>
              <For each={availablePorts()}>
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
                        'min-width': '0',
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
                        <span
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'flex-end',
                            'flex-wrap': 'wrap',
                            gap: '4px',
                          }}
                        >
                          <For each={port.badges}>
                            {(badge) => (
                              <span
                                style={{
                                  color: getAvailablePortBadgeColor(badge),
                                  'font-size': '10px',
                                  'font-weight': '600',
                                  'text-transform': 'uppercase',
                                  'letter-spacing': '0.03em',
                                }}
                              >
                                {badge}
                              </span>
                            )}
                          </For>
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
                    <PreviewActionButton
                      label={`Expose port ${port.port}`}
                      disabled={busyPort() === port.port}
                      onClick={() => {
                        void handleAvailablePortExpose(port.port);
                      }}
                    >
                      <ExposePortIcon />
                    </PreviewActionButton>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div
              style={{ color: theme.fgMuted, 'font-size': '10px', 'text-transform': 'uppercase' }}
            >
              Custom port
            </div>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
                padding: '8px 9px',
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                background: theme.taskContainerBg,
              }}
            >
              <label style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>Port</span>
                <input
                  value={customPortText()}
                  onInput={handleCustomPortInput}
                  placeholder="5173"
                  inputmode="numeric"
                  style={{
                    background: theme.bgInput,
                    color: theme.fg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 8px',
                    'font-size': '12px',
                    outline: 'none',
                  }}
                />
              </label>
              <label style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>Label (optional)</span>
                <input
                  value={customLabelText()}
                  onInput={(event) => {
                    setExposeErrorMessage(null);
                    setCustomLabelText(event.currentTarget.value);
                  }}
                  placeholder="Frontend dev server"
                  style={{
                    background: theme.bgInput,
                    color: theme.fg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 8px',
                    'font-size': '12px',
                    outline: 'none',
                  }}
                />
              </label>
              <Show when={exposeErrorMessage()}>
                {(message) => (
                  <div style={{ color: theme.error, 'font-size': '10px' }}>{message()}</div>
                )}
              </Show>
              <button
                type="button"
                disabled={busyPort() !== null}
                onClick={() => {
                  void handleCustomExpose();
                }}
                style={{
                  background: theme.bgElevated,
                  color: theme.fg,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  padding: '6px 10px',
                  cursor: busyPort() !== null ? 'wait' : 'pointer',
                  'font-size': '12px',
                  'font-weight': '600',
                }}
              >
                Expose custom port
              </button>
            </div>
          </div>
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
                Expose a port from the left to open an embedded preview here.
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
