import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import { TaskContainersPanel } from './TaskContainersPanel';
import type {
  TaskExposedPort,
  TaskPortExposureCandidate,
  TaskPortSnapshot,
  TaskPreviewAvailability,
} from '../domain/server-state';
import type {
  TaskContainerInspectResult,
  TaskContainerLogsResult,
} from '../domain/task-containers';
import { buildTaskPreviewUrl } from '../app/task-ports';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { isTcpPortNumber } from '../lib/type-guards';

export interface PreviewPanelProps {
  availableCandidates: ReadonlyArray<TaskPortExposureCandidate>;
  availableScanError: string | null;
  availableScanning: boolean;
  containerInspect: TaskContainerInspectResult | null;
  containerInspectError: string | null;
  containerInspectLoading: boolean;
  containerLogs: TaskContainerLogsResult | null;
  containerLogsError: string | null;
  containerLogsLoading: boolean;
  containerActionError: string | null;
  onDestroyContainers: () => Promise<void> | void;
  onExposePort: (port: number, label?: string) => Promise<void> | void;
  onHide: () => void;
  onRefreshContainerInspect: () => Promise<void> | void;
  onRefreshContainerLogs: () => Promise<void> | void;
  onRefreshAvailablePorts: () => Promise<void> | void;
  onRefreshPort: (port: number) => Promise<void> | void;
  onStartContainers: () => Promise<void> | void;
  onStopContainers: () => Promise<void> | void;
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

type AvailablePreviewPortBadge = 'Detected' | 'Local' | 'Rediscovered' | 'Task';

interface AvailablePreviewPort {
  badges: AvailablePreviewPortBadge[];
  port: number;
  suggestion: string;
}

interface PreviewMessageCardProps {
  children: JSX.Element | string;
  color?: string;
  role?: 'status';
}

type PreviewPortKey = string;

interface PreviewPortRevisionRef {
  key: PreviewPortKey;
  port: number;
}

interface PreviewPortError extends PreviewPortRevisionRef {
  message: string;
}

interface PreviewExposeError {
  message: string;
  port: number | null;
}

type PreviewBusyAction =
  | {
      id: number;
      kind: 'expose';
      port: number;
    }
  | ({
      id: number;
      kind: 'unexpose';
    } & PreviewPortRevisionRef);

interface PreviewExposureIndex {
  exposedPortNumbers: ReadonlySet<number>;
  firstExposedPortNumber: number | null;
  portsByNumber: ReadonlyMap<number, TaskExposedPort>;
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

const AVAILABLE_PREVIEW_PORT_BADGE_COLORS = {
  Detected: theme.warning,
  Local: theme.fgMuted,
  Rediscovered: theme.warning,
  Task: theme.accent,
} satisfies Record<AvailablePreviewPortBadge, string>;

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
): Extract<AvailablePreviewPortBadge, 'Detected' | 'Rediscovered'> {
  return source === 'rediscovery' ? 'Rediscovered' : 'Detected';
}

function getRetryPreviewLabel(port: number, isRefreshing: boolean): string {
  if (isRefreshing) {
    return `Checking preview for port ${port}`;
  }

  return `Retry preview for port ${port}`;
}

function getPreviewRefreshErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Failed to refresh preview.';
}

function getPreviewAutoRefreshKey(taskId: string, port: TaskExposedPort): string {
  return `${taskId}:${port.port}:${port.updatedAt}`;
}

function getPreviewPortKey(taskId: string, port: TaskExposedPort): string {
  return getPreviewAutoRefreshKey(taskId, port);
}

function getPreviewPortRevisionRef(taskId: string, port: TaskExposedPort): PreviewPortRevisionRef {
  return {
    key: getPreviewPortKey(taskId, port),
    port: port.port,
  };
}

function getPreviewExposureIndex(
  exposedPorts: ReadonlyArray<TaskExposedPort>,
): PreviewExposureIndex {
  const exposedPortNumbers = new Set<number>();
  const portsByNumber = new Map<number, TaskExposedPort>();

  for (const port of exposedPorts) {
    exposedPortNumbers.add(port.port);
    if (!portsByNumber.has(port.port)) {
      portsByNumber.set(port.port, port);
    }
  }

  return {
    exposedPortNumbers,
    firstExposedPortNumber: exposedPorts[0]?.port ?? null,
    portsByNumber,
  };
}

function getPortErrorMessage(
  portError: PreviewPortError | null,
  port: TaskExposedPort,
  taskId: string,
): string | null {
  return portError?.key === getPreviewPortRevisionRef(taskId, port).key ? portError.message : null;
}

function getAvailablePreviewPorts(
  candidates: ReadonlyArray<TaskPortExposureCandidate>,
  snapshot: TaskPortSnapshot,
  exposedPortNumbers: ReadonlySet<number>,
): AvailablePreviewPort[] {
  const portsByNumber = new Map<number, AvailablePreviewPort>();

  for (const candidate of candidates) {
    if (exposedPortNumbers.has(candidate.port)) {
      continue;
    }

    portsByNumber.set(candidate.port, {
      badges: [candidate.source === 'task' ? 'Task' : 'Local'],
      port: candidate.port,
      suggestion: candidate.suggestion,
    });
  }

  for (const observedPort of snapshot.observed) {
    if (exposedPortNumbers.has(observedPort.port)) {
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

function getAvailablePortBadgeColor(badge: AvailablePreviewPortBadge): string {
  return AVAILABLE_PREVIEW_PORT_BADGE_COLORS[badge];
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
        ...typography.meta,
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
        padding: '16px',
        'text-align': 'center',
        ...typography.meta,
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
            ...typography.metaStrong,
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
  const [busyAction, setBusyAction] = createSignal<PreviewBusyAction | null>(null);
  const [refreshingPortKey, setRefreshingPortKey] = createSignal<string | null>(null);
  const [refreshErrorMessage, setRefreshErrorMessage] = createSignal<PreviewPortError | null>(null);
  const [portActionErrorMessage, setPortActionErrorMessage] = createSignal<PreviewPortError | null>(
    null,
  );
  const [customPortText, setCustomPortText] = createSignal('');
  const [customLabelText, setCustomLabelText] = createSignal('');
  const [exposeErrorMessage, setExposeErrorMessage] = createSignal<PreviewExposeError | null>(null);
  const autoRefreshKeys = new Set<string>();
  let nextBusyActionId = 0;
  const exposureIndex = createMemo(() => getPreviewExposureIndex(props.snapshot.exposed));
  const availablePorts = createMemo(() =>
    getAvailablePreviewPorts(
      props.availableCandidates,
      props.snapshot,
      exposureIndex().exposedPortNumbers,
    ),
  );
  const hasDetectedOnlyPorts = createMemo(
    () => props.availableCandidates.length === 0 && availablePorts().length > 0,
  );

  const selectedPreviewUrl = createMemo(() => {
    const port = selectedPort();
    return port === null ? null : buildTaskPreviewUrl(props.taskId, port);
  });
  const selectedExposedPort = createMemo(() => {
    const port = selectedPort();
    if (port === null) {
      return null;
    }

    return exposureIndex().portsByNumber.get(port) ?? null;
  });

  createEffect(() => {
    const currentSelectedPort = selectedPort();
    const currentExposureIndex = exposureIndex();
    if (
      currentSelectedPort !== null &&
      currentExposureIndex.portsByNumber.has(currentSelectedPort)
    ) {
      return;
    }

    setSelectedPort(currentExposureIndex.firstExposedPortNumber);
  });

  createEffect(() => {
    const port = selectedExposedPort();
    if (!port || port.availability !== 'unknown') {
      return;
    }

    const refreshKey = getPreviewAutoRefreshKey(props.taskId, port);
    if (refreshingPortKey() === refreshKey) {
      return;
    }
    if (autoRefreshKeys.has(refreshKey)) {
      return;
    }

    autoRefreshKeys.add(refreshKey);
    void handleRefreshPort(port.port);
  });

  createEffect(() => {
    const refreshError = refreshErrorMessage();
    if (!refreshError) {
      return;
    }

    const port = exposureIndex().portsByNumber.get(refreshError.port);
    if (!port || port.availability !== 'unknown' || !isCurrentPreviewPortRevision(refreshError)) {
      setRefreshErrorMessage(null);
    }
  });

  createEffect(() => {
    const actionError = portActionErrorMessage();
    if (!actionError) {
      return;
    }

    if (!isCurrentPreviewPortRevision(actionError)) {
      setPortActionErrorMessage(null);
    }
  });

  createEffect(() => {
    const exposeError = exposeErrorMessage();
    if (!exposeError) {
      return;
    }

    if (exposeError.port !== null && exposureIndex().portsByNumber.has(exposeError.port)) {
      setExposeErrorMessage(null);
    }
  });

  createEffect(() => {
    const action = busyAction();
    if (!action) {
      return;
    }

    switch (action.kind) {
      case 'expose':
        if (exposureIndex().portsByNumber.has(action.port)) {
          setSelectedPort(action.port);
          clearCustomExposeDrafts();
          setBusyAction(null);
        }
        return;
      case 'unexpose':
        if (!isCurrentPreviewPortRevision(action)) {
          setBusyAction(null);
        }
        return;
    }
  });

  function isPreviewActionBusy(): boolean {
    return busyAction() !== null;
  }

  function isBusyActionCurrent(action: PreviewBusyAction): boolean {
    return busyAction()?.id === action.id;
  }

  function getCurrentPreviewPortRevisionRef(portNumber: number): PreviewPortRevisionRef | null {
    const port = exposureIndex().portsByNumber.get(portNumber);
    return port ? getPreviewPortRevisionRef(props.taskId, port) : null;
  }

  function isCurrentPreviewPortRevision(ref: PreviewPortRevisionRef): boolean {
    return getCurrentPreviewPortRevisionRef(ref.port)?.key === ref.key;
  }

  async function handleExposePort(port: number, label?: string): Promise<boolean> {
    if (isPreviewActionBusy()) {
      return false;
    }

    const action: PreviewBusyAction = {
      id: ++nextBusyActionId,
      kind: 'expose',
      port,
    };
    setBusyAction(action);
    setExposeErrorMessage(null);
    if (portActionErrorMessage()?.port === port) {
      setPortActionErrorMessage(null);
    }

    try {
      await props.onExposePort(port, label);
      if (!isBusyActionCurrent(action)) {
        return false;
      }

      setSelectedPort(port);
      return true;
    } catch (error) {
      if (!isBusyActionCurrent(action)) {
        return false;
      }

      if (!exposureIndex().portsByNumber.has(port)) {
        setExposeErrorMessage({
          message: error instanceof Error ? error.message : 'Failed to expose port',
          port,
        });
      }
      return false;
    } finally {
      if (isBusyActionCurrent(action)) {
        setBusyAction(null);
      }
    }
  }

  function clearCustomExposeDrafts(): void {
    setCustomPortText('');
    setCustomLabelText('');
  }

  function handleRefreshAvailablePorts(): void {
    void props.onRefreshAvailablePorts();
  }

  async function handleRefreshPort(portNumber: number): Promise<void> {
    const port = exposureIndex().portsByNumber.get(portNumber);
    if (!port) {
      return;
    }

    const refreshRef = getPreviewPortRevisionRef(props.taskId, port);
    const refreshKey = refreshRef.key;
    setRefreshingPortKey(refreshKey);
    setRefreshErrorMessage(null);
    if (portActionErrorMessage()?.key === refreshKey) {
      setPortActionErrorMessage(null);
    }
    try {
      await props.onRefreshPort(portNumber);
    } catch (error) {
      if (isCurrentPreviewPortRevision(refreshRef)) {
        setRefreshErrorMessage({
          ...refreshRef,
          message: getPreviewRefreshErrorMessage(error),
        });
      }
    } finally {
      if (refreshingPortKey() === refreshKey) {
        setRefreshingPortKey(null);
      }
    }
  }

  function isRefreshingPreviewPort(port: TaskExposedPort): boolean {
    return refreshingPortKey() === getPreviewPortKey(props.taskId, port);
  }

  async function handleUnexposePort(port: number): Promise<void> {
    if (isPreviewActionBusy()) {
      return;
    }

    const exposedPort = exposureIndex().portsByNumber.get(port);
    if (!exposedPort) {
      return;
    }

    const action: PreviewBusyAction = {
      id: ++nextBusyActionId,
      kind: 'unexpose',
      ...getPreviewPortRevisionRef(props.taskId, exposedPort),
    };
    setBusyAction(action);
    if (refreshErrorMessage()?.key === action.key) {
      setRefreshErrorMessage(null);
    }
    if (portActionErrorMessage()?.key === action.key) {
      setPortActionErrorMessage(null);
    }
    try {
      await props.onUnexposePort(port);
    } catch (error) {
      if (!isBusyActionCurrent(action)) {
        return;
      }

      if (isCurrentPreviewPortRevision(action)) {
        setPortActionErrorMessage({
          key: action.key,
          message: error instanceof Error ? error.message : 'Failed to unexpose port.',
          port,
        });
      }
    } finally {
      if (isBusyActionCurrent(action)) {
        setBusyAction(null);
      }
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
    if (!isTcpPortNumber(port)) {
      setExposeErrorMessage({
        message: 'Enter a valid port between 1 and 65535.',
        port: null,
      });
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
        <div style={{ color: theme.fg, ...typography.uiStrong }}>Preview</div>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <PreviewActionButton
            label="Hide preview manager"
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
          <TaskContainersPanel
            inspect={props.containerInspect}
            inspectError={props.containerInspectError}
            loading={props.containerInspectLoading}
            logs={props.containerLogs}
            logsError={props.containerLogsError}
            logsLoading={props.containerLogsLoading}
            actionError={props.containerActionError}
            onDestroy={props.onDestroyContainers}
            onRefresh={props.onRefreshContainerInspect}
            onRefreshLogs={props.onRefreshContainerLogs}
            onStart={props.onStartContainers}
            onStop={props.onStopContainers}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div style={{ color: theme.fgMuted, ...typography.label }}>Live preview ports</div>
            <Show
              when={props.snapshot.exposed.length > 0}
              fallback={
                <div
                  style={{
                    color: theme.fgMuted,
                    padding: '2px 0',
                    ...typography.meta,
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
                          gap: '8px',
                          'text-align': 'left',
                          ...typography.metaStrong,
                        }}
                      >
                        <span>{getExposedPortLabel(port)}</span>
                        <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                          <span
                            style={{
                              color: getPreviewAvailabilityColor(port),
                              ...typography.metaStrong,
                            }}
                          >
                            {getPreviewAvailabilityLabel(port)}
                          </span>
                          <span style={{ color: theme.fgMuted, ...typography.monoMeta }}>
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
                          label={getRetryPreviewLabel(port.port, isRefreshingPreviewPort(port))}
                          disabled={isRefreshingPreviewPort(port)}
                          onClick={() => {
                            void handleRefreshPort(port.port);
                          }}
                        >
                          <RetryIcon />
                        </PreviewActionButton>
                        <PreviewActionButton
                          label={`Unexpose port ${port.port}`}
                          color={theme.error}
                          disabled={isPreviewActionBusy()}
                          onClick={() => {
                            void handleUnexposePort(port.port);
                          }}
                        >
                          <UnexposeIcon />
                        </PreviewActionButton>
                      </div>
                    </div>
                    <Show when={port.statusMessage}>
                      <div style={{ color: theme.fgMuted, ...typography.meta }}>
                        {port.statusMessage}
                      </div>
                    </Show>
                    <Show when={getPortErrorMessage(refreshErrorMessage(), port, props.taskId)}>
                      {(message) => (
                        <div style={{ color: theme.error, ...typography.meta }}>{message()}</div>
                      )}
                    </Show>
                    <Show when={getPortErrorMessage(portActionErrorMessage(), port, props.taskId)}>
                      {(message) => (
                        <div style={{ color: theme.error, ...typography.meta }}>{message()}</div>
                      )}
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
              <div style={{ color: theme.fgMuted, ...typography.label }}>Available to expose</div>
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
                  ...typography.metaStrong,
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
                        <span style={{ color: theme.fg, ...typography.metaStrong }}>
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
                                  ...typography.label,
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
                          'word-break': 'break-word',
                          ...typography.meta,
                        }}
                      >
                        {port.suggestion}
                      </div>
                    </div>
                    <PreviewActionButton
                      label={`Expose port ${port.port}`}
                      disabled={isPreviewActionBusy()}
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
            <div style={{ color: theme.fgMuted, ...typography.label }}>Custom port</div>
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
                <span style={{ color: theme.fgMuted, ...typography.label }}>Port</span>
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
                    outline: 'none',
                    ...typography.monoUi,
                  }}
                />
              </label>
              <label style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <span style={{ color: theme.fgMuted, ...typography.label }}>Label (optional)</span>
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
                    outline: 'none',
                    ...typography.ui,
                  }}
                />
              </label>
              <Show when={exposeErrorMessage()}>
                {(error) => (
                  <div style={{ color: theme.error, ...typography.meta }}>{error().message}</div>
                )}
              </Show>
              <button
                type="button"
                disabled={isPreviewActionBusy()}
                onClick={() => {
                  void handleCustomExpose();
                }}
                style={{
                  background: theme.bgElevated,
                  color: theme.fg,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  padding: '6px 10px',
                  cursor: isPreviewActionBusy() ? 'wait' : 'pointer',
                  ...typography.uiStrong,
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
                  padding: '16px',
                  'text-align': 'center',
                  ...typography.meta,
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
