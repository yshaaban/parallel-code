import { For, Show, createMemo, type Accessor, type JSX } from 'solid-js';
import { getTaskAttentionFocusPanel, type TaskAttentionEntry } from '../app/task-attention';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import {
  setActiveAgent,
  setActiveTask,
  setTaskFocusedPanel,
  store,
  unfocusSidebar,
} from '../store/store';

interface AttentionInboxProps {
  entries: Accessor<TaskAttentionEntry[]>;
}

function formatAttentionAge(lastOutputAt: number | null): string | null {
  if (!lastOutputAt) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - lastOutputAt) / 1_000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }

  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

function getGroupTitle(group: TaskAttentionEntry['group']): string {
  switch (group) {
    case 'needs-action':
      return 'Needs Action';
    case 'ready':
      return 'Ready';
    case 'quiet':
      return 'Quiet';
    default:
      return 'Attention';
  }
}

function getReasonColor(reason: TaskAttentionEntry['reason']): string {
  switch (reason) {
    case 'failed':
      return theme.error;
    case 'waiting-input':
      return theme.warning;
    case 'ready-for-next-step':
      return theme.success;
    case 'flow-controlled':
    case 'restoring':
      return theme.accent;
    case 'paused':
      return theme.warning;
    case 'quiet-too-long':
      return theme.fgSubtle;
    default:
      return theme.fgMuted;
  }
}

function groupEntries(
  entries: TaskAttentionEntry[],
): Record<TaskAttentionEntry['group'], TaskAttentionEntry[]> {
  return {
    'needs-action': entries.filter((entry) => entry.group === 'needs-action'),
    ready: entries.filter((entry) => entry.group === 'ready'),
    quiet: entries.filter((entry) => entry.group === 'quiet'),
  };
}

export function AttentionInbox(props: AttentionInboxProps): JSX.Element {
  const groupedEntries = createMemo(() => groupEntries(props.entries()));

  function activateEntry(entry: TaskAttentionEntry): void {
    setActiveTask(entry.taskId);
    setActiveAgent(entry.agentId);
    unfocusSidebar();
    setTaskFocusedPanel(entry.taskId, getTaskAttentionFocusPanel(entry));
  }

  return (
    <Show when={props.entries().length > 0}>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: '0 2px',
          }}
        >
          <span
            style={{
              'font-size': sf(10),
              color: theme.fgSubtle,
              'font-weight': '600',
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Attention
          </span>
          <span
            style={{
              'font-size': sf(10),
              color: theme.fgMuted,
              padding: '1px 6px',
              'border-radius': '999px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            {props.entries().length}
          </span>
        </div>

        <For
          each={(['needs-action', 'ready', 'quiet'] as const).filter(
            (group) => groupedEntries()[group].length > 0,
          )}
        >
          {(group) => (
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <div
                style={{
                  'font-size': sf(10),
                  color: theme.fgSubtle,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                  padding: '0 2px',
                }}
              >
                {getGroupTitle(group)}
              </div>
              <For each={groupedEntries()[group]}>
                {(entry) => {
                  const task = () => store.tasks[entry.taskId];
                  return (
                    <button
                      type="button"
                      onClick={() => activateEntry(entry)}
                      style={{
                        display: 'flex',
                        'align-items': 'flex-start',
                        gap: '8px',
                        padding: '8px 10px',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '8px',
                        cursor: 'pointer',
                        'text-align': 'left',
                      }}
                    >
                      <span
                        style={{
                          width: '7px',
                          height: '7px',
                          'border-radius': '50%',
                          background: getReasonColor(entry.reason),
                          'margin-top': '6px',
                          'flex-shrink': '0',
                        }}
                      />
                      <div
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '2px',
                          'min-width': '0',
                          flex: '1',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '6px',
                            'justify-content': 'space-between',
                          }}
                        >
                          <span
                            style={{
                              color: theme.fg,
                              'font-size': sf(12),
                              'font-weight': '500',
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                            }}
                          >
                            {task()?.name ?? entry.taskId}
                          </span>
                          <span
                            style={{ color: getReasonColor(entry.reason), 'font-size': sf(10) }}
                          >
                            {entry.label}
                          </span>
                        </div>
                        <Show when={entry.preview}>
                          <span
                            style={{
                              color: theme.fgMuted,
                              'font-size': sf(11),
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                            }}
                          >
                            {entry.preview}
                          </span>
                        </Show>
                        <Show when={formatAttentionAge(entry.lastOutputAt)}>
                          {(age) => (
                            <span style={{ color: theme.fgSubtle, 'font-size': sf(10) }}>
                              Last output {age()}
                            </span>
                          )}
                        </Show>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
