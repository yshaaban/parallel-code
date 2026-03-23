import { For, Show, createMemo, type Accessor, type JSX } from 'solid-js';
import { getTaskAttentionFocusPanel, type TaskAttentionEntry } from '../app/task-attention';
import {
  getTaskAttentionGroupTitle,
  getTaskAttentionTone,
  type TaskAttentionTone,
} from '../app/task-presentation-status';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
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

const TASK_ATTENTION_TONE_COLORS: Record<TaskAttentionTone, string> = {
  accent: theme.accent,
  error: theme.error,
  muted: theme.fgSubtle,
  success: theme.success,
  warning: theme.warning,
};

const TASK_ATTENTION_GROUP_ORDER = ['needs-action', 'ready', 'quiet'] as const;

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

function getReasonColor(reason: TaskAttentionEntry['reason']): string {
  return TASK_ATTENTION_TONE_COLORS[getTaskAttentionTone(reason)];
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
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-md)' }}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: `0 var(--space-2xs)`,
          }}
        >
          <span
            style={{
              color: theme.fgSubtle,
              ...typography.label,
            }}
          >
            Attention
          </span>
          <span
            style={{
              color: theme.fgMuted,
              padding: '2px var(--space-xs)',
              'border-radius': '999px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              ...typography.meta,
            }}
          >
            {props.entries().length}
          </span>
        </div>

        <For
          each={TASK_ATTENTION_GROUP_ORDER.filter((group) => groupedEntries()[group].length > 0)}
        >
          {(group) => (
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-xs)' }}>
              <div
                style={{
                  color: theme.fgSubtle,
                  padding: `0 var(--space-2xs)`,
                  ...typography.label,
                }}
              >
                {getTaskAttentionGroupTitle(group)}
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
                        gap: 'var(--space-sm)',
                        padding: 'var(--space-sm) var(--space-md)',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '10px',
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
                          gap: 'var(--space-3xs)',
                          'min-width': '0',
                          flex: '1',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: 'var(--space-xs)',
                            'justify-content': 'space-between',
                          }}
                        >
                          <span
                            style={{
                              color: theme.fg,
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                              ...typography.uiStrong,
                            }}
                          >
                            {task()?.name ?? entry.taskId}
                          </span>
                          <span
                            style={{
                              color: getReasonColor(entry.reason),
                              ...typography.metaStrong,
                            }}
                          >
                            {entry.label}
                          </span>
                        </div>
                        <Show when={entry.preview}>
                          <span
                            style={{
                              color: theme.fgMuted,
                              overflow: 'hidden',
                              'text-overflow': 'ellipsis',
                              'white-space': 'nowrap',
                              ...typography.meta,
                            }}
                          >
                            {entry.preview}
                          </span>
                        </Show>
                        <Show when={formatAttentionAge(entry.lastOutputAt)}>
                          {(age) => (
                            <span style={{ color: theme.fgSubtle, ...typography.meta }}>
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
