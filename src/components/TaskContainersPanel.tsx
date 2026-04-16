import { For, Show, type JSX } from 'solid-js';

import { buildTaskContainerPreviewUrl } from '../app/task-containers';
import type {
  TaskContainerInspectResult,
  TaskContainerLogsResult,
  TaskContainerPreview,
} from '../domain/task-containers';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface TaskContainersPanelProps {
  inspect: TaskContainerInspectResult | null;
  inspectError: string | null;
  loading: boolean;
  logs: TaskContainerLogsResult | null;
  logsError: string | null;
  logsLoading: boolean;
  actionError: string | null;
  onDestroy: () => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onRefreshLogs: () => Promise<void> | void;
  onStart: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
}

function getStatusLabel(inspect: TaskContainerInspectResult): string {
  switch (inspect.status) {
    case 'not_configured':
      return 'Not configured';
    case 'unsupported':
      return 'Unsupported';
    case 'ready':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
    default:
      return inspect.status;
  }
}

function getStatusColor(inspect: TaskContainerInspectResult): string {
  switch (inspect.status) {
    case 'running':
      return theme.success;
    case 'ready':
      return theme.accent;
    case 'not_configured':
      return theme.fgMuted;
    case 'unsupported':
    case 'error':
      return theme.warning;
    default:
      return theme.fgMuted;
  }
}

function ActionButton(props: {
  disabled?: boolean;
  label: string;
  onClick: () => Promise<void> | void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => void props.onClick()}
      style={{
        padding: '6px 10px',
        border: `1px solid ${theme.border}`,
        'border-radius': '6px',
        background: theme.taskContainerBg,
        color: theme.fg,
        cursor: props.disabled ? 'default' : 'pointer',
        ...typography.metaStrong,
      }}
    >
      {props.label}
    </button>
  );
}

function PreviewLink(props: { preview: TaskContainerPreview; taskId: string }): JSX.Element {
  return (
    <a
      href={buildTaskContainerPreviewUrl(props.taskId, props.preview)}
      target="_blank"
      rel="noreferrer"
      style={{
        color: theme.accent,
        ...typography.metaStrong,
      }}
    >
      {props.preview.label}
    </a>
  );
}

function TaskContainersMessage(props: { children: string; color?: string }): JSX.Element {
  return (
    <div
      role="status"
      style={{
        padding: '8px 10px',
        background: theme.taskContainerBg,
        border: `1px solid ${theme.border}`,
        'border-radius': '6px',
        color: props.color ?? theme.fgMuted,
        'word-break': 'break-word',
        ...typography.meta,
      }}
    >
      {props.children}
    </div>
  );
}

export function TaskContainersPanel(props: TaskContainersPanelProps): JSX.Element {
  const inspect = () => props.inspect;
  const logs = () => props.logs;

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
        padding: '0 0 12px 0',
        'border-bottom': `1px solid ${theme.border}`,
        'margin-bottom': '12px',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span style={{ ...typography.metaStrong, color: theme.fg }}>Containers</span>
          <Show when={inspect()}>
            {(value) => (
              <span
                style={{
                  ...typography.metaStrong,
                  color: getStatusColor(value()),
                }}
              >
                {getStatusLabel(value())}
              </span>
            )}
          </Show>
        </div>
        <ActionButton
          label={props.loading ? 'Refreshing…' : 'Refresh'}
          disabled={props.loading}
          onClick={props.onRefresh}
        />
      </div>

      <Show when={props.actionError}>
        {(message) => (
          <TaskContainersMessage color={theme.error}>{message()}</TaskContainersMessage>
        )}
      </Show>

      <Show when={props.logsError}>
        {(message) => (
          <TaskContainersMessage color={theme.error}>{message()}</TaskContainersMessage>
        )}
      </Show>

      <Show
        when={inspect()}
        fallback={
          props.inspectError ? (
            <TaskContainersMessage color={theme.error}>{props.inspectError}</TaskContainersMessage>
          ) : (
            <div style={{ ...typography.meta, color: theme.fgMuted }}>
              Inspecting task container support…
            </div>
          )
        }
      >
        {(value) => (
          <>
            <Show when={props.inspectError}>
              {(message) => (
                <TaskContainersMessage color={theme.error}>{message()}</TaskContainersMessage>
              )}
            </Show>

            <Show when={value().composeFile}>
              {(composeFile) => (
                <div style={{ ...typography.meta, color: theme.fgMuted }}>
                  Compose file: {composeFile()}
                </div>
              )}
            </Show>

            <Show when={value().issues.length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <For each={value().issues}>
                  {(issue) => (
                    <div
                      style={{
                        padding: '8px 10px',
                        background: theme.taskContainerBg,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '6px',
                        color: issue.severity === 'error' ? theme.warning : theme.fgMuted,
                        ...typography.meta,
                      }}
                    >
                      {issue.message}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <Show when={value().status === 'ready'}>
                <ActionButton label="Start" disabled={props.loading} onClick={props.onStart} />
              </Show>
              <Show when={value().status === 'running'}>
                <>
                  <ActionButton label="Stop" disabled={props.loading} onClick={props.onStop} />
                  <ActionButton
                    label="Destroy"
                    disabled={props.loading}
                    onClick={props.onDestroy}
                  />
                </>
              </Show>
              <Show when={value().status === 'unsupported' || value().status === 'error'}>
                <ActionButton
                  label="Refresh status"
                  disabled={props.loading}
                  onClick={props.onRefresh}
                />
              </Show>
            </div>

            <Show when={value().previews.length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <div style={{ ...typography.metaStrong, color: theme.fg }}>App previews</div>
                <div style={{ display: 'flex', gap: '10px', 'flex-wrap': 'wrap' }}>
                  <For each={value().previews}>
                    {(preview) => <PreviewLink preview={preview} taskId={value().taskId} />}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={value().services.length > 0}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <div style={{ ...typography.metaStrong, color: theme.fg }}>Services</div>
                <For each={value().services}>
                  {(service) => (
                    <div style={{ ...typography.meta, color: theme.fgMuted }}>
                      {service.name}: {service.state}
                      <Show when={service.health}>{(health) => <> ({health()})</>}</Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'space-between',
                }}
              >
                <div style={{ ...typography.metaStrong, color: theme.fg }}>Recent logs</div>
                <ActionButton
                  label={props.logsLoading ? 'Loading…' : 'Load logs'}
                  disabled={props.logsLoading}
                  onClick={props.onRefreshLogs}
                />
              </div>
              <Show
                when={logs()}
                fallback={
                  props.logsError ? null : (
                    <div style={{ ...typography.meta, color: theme.fgMuted }}>
                      No logs loaded yet.
                    </div>
                  )
                }
              >
                {(logsResult) => (
                  <>
                    <Show
                      when={logsResult().text.length > 0}
                      fallback={
                        props.logsError ? null : (
                          <div style={{ ...typography.meta, color: theme.fgMuted }}>
                            No logs loaded yet.
                          </div>
                        )
                      }
                    >
                      <pre
                        style={{
                          margin: '0',
                          padding: '10px',
                          background: theme.taskContainerBg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '6px',
                          color: theme.fgMuted,
                          'max-height': '180px',
                          overflow: 'auto',
                          ...typography.meta,
                        }}
                      >
                        {logsResult().text}
                      </pre>
                      <Show when={logsResult().truncated}>
                        <div style={{ ...typography.meta, color: theme.fgMuted }}>
                          Showing the most recent container log tail.
                        </div>
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
