import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import type { TaskExposedPort, TaskPortSnapshot } from '../domain/server-state';
import { buildTaskPreviewUrl } from '../app/task-ports';
import { theme } from '../lib/theme';

interface PreviewPanelProps {
  onExposeObservedPort: (port: number) => Promise<void> | void;
  onOpenExposeDialog: () => void;
  onRefreshPort: (port: number) => Promise<void> | void;
  onUnexposePort: (port: number) => Promise<void> | void;
  snapshot: TaskPortSnapshot;
  taskId: string;
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

export function PreviewPanel(props: PreviewPanelProps): JSX.Element {
  const [selectedPort, setSelectedPort] = createSignal<number | null>(null);
  const [busyPort, setBusyPort] = createSignal<number | null>(null);
  const [refreshingPort, setRefreshingPort] = createSignal<number | null>(null);

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
          padding: '5px 8px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '8px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <div style={{ color: theme.fg, 'font-size': '12px', 'font-weight': '700' }}>Preview</div>
        <button
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenExposeDialog();
          }}
          style={{
            background: theme.bgElevated,
            color: theme.fg,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '4px 8px',
            cursor: 'pointer',
            'font-size': '11px',
            'font-weight': '600',
          }}
        >
          Expose
        </button>
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
            padding: '8px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
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
                      gap: '6px',
                      padding: '7px 8px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      background: getExposedPortCardBackground(
                        selectedPort() === port.port,
                        theme.taskContainerBg,
                        theme.accent,
                      ),
                    }}
                  >
                    <button
                      onClick={() => setSelectedPort(port.port)}
                      style={{
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
                    <Show when={port.statusMessage}>
                      <div style={{ color: theme.fgMuted, 'font-size': '10px' }}>
                        {port.statusMessage}
                      </div>
                    </Show>
                    <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
                      <button
                        onClick={() => openPreviewInNewTab(port.port)}
                        style={{
                          background: theme.bgElevated,
                          color: theme.fg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          padding: '3px 7px',
                          cursor: 'pointer',
                          'font-size': '10px',
                        }}
                      >
                        Open tab
                      </button>
                      <button
                        disabled={refreshingPort() === port.port}
                        onClick={() => {
                          void handleRefreshPort(port.port);
                        }}
                        style={{
                          background: 'transparent',
                          color: theme.fgMuted,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          padding: '3px 7px',
                          cursor: refreshingPort() === port.port ? 'wait' : 'pointer',
                          'font-size': '10px',
                        }}
                      >
                        {refreshingPort() === port.port ? 'Checking' : 'Retry'}
                      </button>
                      <button
                        disabled={busyPort() === port.port}
                        onClick={() => {
                          void handleUnexposePort(port.port);
                        }}
                        style={{
                          background: 'transparent',
                          color: theme.error,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          padding: '3px 7px',
                          cursor: busyPort() === port.port ? 'wait' : 'pointer',
                          'font-size': '10px',
                        }}
                      >
                        Unexpose
                      </button>
                    </div>
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
                      'flex-direction': 'column',
                      gap: '4px',
                      padding: '7px 8px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      background: theme.taskContainerBg,
                    }}
                  >
                    <div
                      style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}
                    >
                      <span style={{ color: theme.fg, 'font-size': '12px', 'font-weight': '600' }}>
                        Port {port.port}
                      </span>
                      <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>
                        {port.source === 'rediscovery' ? 'Rediscovered' : 'Detected'}
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
                    <Show
                      when={!props.snapshot.exposed.some((exposed) => exposed.port === port.port)}
                    >
                      <button
                        disabled={busyPort() === port.port}
                        onClick={() => {
                          void handleExposeObservedPort(port.port);
                        }}
                        style={{
                          width: 'fit-content',
                          background: theme.bgElevated,
                          color: theme.fg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          padding: '3px 7px',
                          cursor: busyPort() === port.port ? 'wait' : 'pointer',
                          'font-size': '10px',
                        }}
                      >
                        Expose
                      </button>
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
                      <div>{port().statusMessage ?? 'Preview unavailable.'}</div>
                      <button
                        onClick={() => {
                          void handleRefreshPort(port().port);
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
