import { For, Show, createMemo, type Accessor, type JSX } from 'solid-js';

import {
  type TaskReviewQueueEntry,
  getTaskReviewQueueGroupLabel,
} from '../../domain/task-convergence';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';
import { setReviewPanelOpen } from '../../store/review';
import {
  setActiveTask,
  setTaskFocusedPanel,
  store,
  uncollapseTask,
  unfocusSidebar,
} from '../../store/store';

interface SidebarReviewQueueProps {
  entries: Accessor<TaskReviewQueueEntry[]>;
}

function getReviewGroupColor(group: TaskReviewQueueEntry['group']): string {
  switch (group) {
    case 'needs-refresh':
      return theme.warning;
    case 'overlap-risk':
      return theme.error;
    case 'ready-to-review':
      return theme.success;
    default:
      return theme.fgMuted;
  }
}

function groupEntries(
  entries: TaskReviewQueueEntry[],
): Record<TaskReviewQueueEntry['group'], TaskReviewQueueEntry[]> {
  return {
    'needs-refresh': entries.filter((entry) => entry.group === 'needs-refresh'),
    'overlap-risk': entries.filter((entry) => entry.group === 'overlap-risk'),
    'ready-to-review': entries.filter((entry) => entry.group === 'ready-to-review'),
  };
}

export function SidebarReviewQueue(props: SidebarReviewQueueProps): JSX.Element {
  const groupedEntries = createMemo(() => groupEntries(props.entries()));

  function openEntry(entry: TaskReviewQueueEntry): void {
    if (store.tasks[entry.taskId]?.collapsed) {
      uncollapseTask(entry.taskId);
    } else {
      setActiveTask(entry.taskId);
    }
    setReviewPanelOpen(entry.taskId, true);
    unfocusSidebar();
    setTaskFocusedPanel(entry.taskId, 'changed-files');
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
            Review Queue
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
          each={(['needs-refresh', 'overlap-risk', 'ready-to-review'] as const).filter(
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
                {getTaskReviewQueueGroupLabel(group)}
              </div>
              <For each={groupedEntries()[group]}>
                {(entry) => (
                  <button
                    type="button"
                    onClick={() => openEntry(entry)}
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
                        background: getReviewGroupColor(entry.group),
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
                          'justify-content': 'space-between',
                          gap: '6px',
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
                          {store.tasks[entry.taskId]?.name ?? entry.taskName}
                        </span>
                        <span
                          style={{
                            color: getReviewGroupColor(entry.group),
                            'font-size': sf(10),
                          }}
                        >
                          {entry.label}
                        </span>
                      </div>
                      <span style={{ color: theme.fgMuted, 'font-size': sf(11) }}>
                        {entry.snapshot.summary}
                      </span>
                      <Show when={entry.snapshot.overlapWarnings[0]}>
                        {(warning) => (
                          <span style={{ color: theme.fgSubtle, 'font-size': sf(10) }}>
                            Overlaps with {warning().otherTaskName}
                          </span>
                        )}
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
