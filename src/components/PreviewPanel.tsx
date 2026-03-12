import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import type { TaskPortSnapshot } from '../domain/server-state';
import { buildTaskPreviewUrl } from '../app/task-ports';
import { theme } from '../lib/theme';

interface PreviewPanelProps {
  onExposeObservedPort: (port: number) => Promise<void> | void;
  onOpenExposeDialog: () => void;
  onUnexposePort: (port: number) => Promise<void> | void;
  snapshot: TaskPortSnapshot;
  taskId: string;
}

function getExposedPortLabel(port: TaskPortSnapshot['exposed'][number]): string {
  return port.label ?? `Port ${port.port}`;
}

export function PreviewPanel(props: PreviewPanelProps): JSX.Element {
  const [selectedPort, setSelectedPort] = createSignal<number | null>(null);
  const [busyPort, setBusyPort] = createSignal<number | null>(null);

  const selectedPreviewUrl = createMemo(() => {
    const port = selectedPort();
    return port === null ? null : buildTaskPreviewUrl(props.taskId, port);
  });

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

  async function handleExposeObservedPort(port: number): Promise<void> {
    setBusyPort(port);
    try {
      await props.onExposeObservedPort(port);
      setSelectedPort(port);
    } finally {
      setBusyPort(null);
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
          padding: '6px 10px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '10px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <div>
          <div style={{ color: theme.fg, 'font-size': '12px', 'font-weight': '700' }}>Preview</div>
          <div style={{ color: theme.fgMuted, 'font-size': '11px' }}>
            Expose localhost ports for direct links and browser-mode proxy previews.
          </div>
        </div>
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
            padding: '6px 10px',
            cursor: 'pointer',
            'font-size': '12px',
            'font-weight': '600',
          }}
        >
          Expose port
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          'grid-template-columns': '280px 1fr',
          flex: '1',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '12px',
            overflow: 'auto',
            'border-right': `1px solid ${theme.border}`,
          }}
        >
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <div
              style={{ color: theme.fgMuted, 'font-size': '11px', 'text-transform': 'uppercase' }}
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
                      gap: '8px',
                      padding: '10px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                      background:
                        selectedPort() === port.port
                          ? `color-mix(in srgb, ${theme.accent} 12%, ${theme.taskContainerBg})`
                          : theme.taskContainerBg,
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
                        'font-size': '13px',
                        'font-weight': '600',
                      }}
                    >
                      <span>{getExposedPortLabel(port)}</span>
                      <span style={{ color: theme.fgMuted, 'font-size': '11px' }}>
                        :{port.port}
                      </span>
                    </button>
                    <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
                      <button
                        onClick={() => {
                          const previewUrl = buildTaskPreviewUrl(props.taskId, port.port);
                          if (previewUrl) {
                            window.open(previewUrl, '_blank', 'noopener');
                          }
                        }}
                        style={{
                          background: theme.bgElevated,
                          color: theme.fg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          padding: '4px 8px',
                          cursor: 'pointer',
                          'font-size': '11px',
                        }}
                      >
                        Open tab
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
                          padding: '4px 8px',
                          cursor: busyPort() === port.port ? 'wait' : 'pointer',
                          'font-size': '11px',
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
                style={{ color: theme.fgMuted, 'font-size': '11px', 'text-transform': 'uppercase' }}
              >
                Detected
              </div>
              <For each={props.snapshot.observed}>
                {(port) => (
                  <div
                    style={{
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '6px',
                      padding: '10px',
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                      background: theme.taskContainerBg,
                    }}
                  >
                    <div
                      style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}
                    >
                      <span style={{ color: theme.fg, 'font-size': '13px', 'font-weight': '600' }}>
                        Port {port.port}
                      </span>
                      <span style={{ color: theme.fgMuted, 'font-size': '11px' }}>Detected</span>
                    </div>
                    <div
                      style={{
                        color: theme.fgMuted,
                        'font-size': '11px',
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
                          padding: '4px 8px',
                          cursor: busyPort() === port.port ? 'wait' : 'pointer',
                          'font-size': '11px',
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
            when={selectedPreviewUrl()}
            fallback={
              <div
                style={{
                  flex: '1',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  color: theme.fgMuted,
                  'font-size': '13px',
                  padding: '20px',
                  'text-align': 'center',
                }}
              >
                Expose a port to open an embedded preview.
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
        </div>
      </div>
    </div>
  );
}
