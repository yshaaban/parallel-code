import { Show, type JSX } from 'solid-js';
import { getTaskAttentionEntry } from '../app/task-presentation-status';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import {
  focusSidebar,
  getTaskDotStatus,
  setActiveTask,
  store,
  uncollapseTask,
} from '../store/store';
import { StatusDot } from './StatusDot';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface SidebarTaskRowProps {
  taskId: string;
  globalIndex: (taskId: string) => number;
  dragFromIndex: () => number | null;
  dropTargetIndex: () => number | null;
}

interface CollapsedSidebarTaskRowProps {
  taskId: string;
}

interface InlineAttentionState {
  age: string | null;
  color: string;
  label: string | null;
  preview: string | null;
}

function getAttentionColor(
  reason: NonNullable<ReturnType<typeof getTaskAttentionEntry>>['reason'],
): string {
  switch (reason) {
    case 'failed':
      return theme.error;
    case 'waiting-input':
      return theme.warning;
    case 'ready-for-next-step':
      return theme.success;
    case 'paused':
      return theme.warning;
    case 'flow-controlled':
    case 'restoring':
      return theme.accent;
    case 'quiet-too-long':
      return theme.fgSubtle;
    default:
      return theme.fgMuted;
  }
}

function formatAttentionAge(lastOutputAt: number | null): string | null {
  if (!lastOutputAt) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - lastOutputAt) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m`;
  }

  return `${Math.floor(ageMinutes / 60)}h`;
}

function getInlineAttentionState(
  attention: ReturnType<typeof getTaskAttentionEntry>,
): InlineAttentionState {
  if (!attention) {
    return {
      age: null,
      color: theme.fgMuted,
      label: null,
      preview: null,
    };
  }

  return {
    age: attention.reason === 'quiet-too-long' ? formatAttentionAge(attention.lastOutputAt) : null,
    color: getAttentionColor(attention.reason),
    label: attention.reason === 'quiet-too-long' ? null : attention.label,
    preview:
      attention.reason === 'quiet-too-long' || attention.preview.length === 0
        ? null
        : attention.preview,
  };
}

function TaskBranchBadge(props: { branchName: string }): JSX.Element {
  return (
    <span
      style={{
        'font-size': sf(10),
        'font-weight': '600',
        padding: '1px 5px',
        'border-radius': '3px',
        background: `color-mix(in srgb, ${theme.warning} 12%, transparent)`,
        color: theme.warning,
        'flex-shrink': '0',
        'line-height': '1.5',
      }}
    >
      {props.branchName}
    </span>
  );
}

function TaskProjectDot(props: { projectId: string }): JSX.Element {
  const project = () => store.projects.find((item) => item.id === props.projectId);

  return (
    <Show when={project()}>
      {(currentProject) => (
        <div
          style={{
            width: '6px',
            height: '6px',
            'border-radius': '50%',
            background: currentProject().color,
            'flex-shrink': '0',
          }}
          title={currentProject().name}
        />
      )}
    </Show>
  );
}

function TaskReviewBadge(props: { taskId: string }): JSX.Element {
  const snapshot = () => getTaskConvergenceSnapshot(props.taskId);
  const label = () => {
    const currentSnapshot = snapshot();
    if (!currentSnapshot) {
      return null;
    }

    switch (currentSnapshot.state) {
      case 'review-ready':
      case 'needs-refresh':
      case 'merge-blocked':
      case 'dirty-uncommitted':
        return getTaskReviewStateLabel(currentSnapshot.state);
      case 'no-changes':
      case 'unavailable':
        return null;
      default:
        return null;
    }
  };
  const color = () => {
    const currentSnapshot = snapshot();
    switch (currentSnapshot?.state) {
      case 'review-ready':
        return theme.success;
      case 'needs-refresh':
        return theme.warning;
      case 'merge-blocked':
        return theme.error;
      case 'dirty-uncommitted':
        return theme.accent;
      default:
        return theme.fgMuted;
    }
  };

  return (
    <Show when={label()}>
      {(currentLabel) => (
        <span
          style={{
            'font-size': sf(9),
            'font-weight': '600',
            padding: '1px 5px',
            'border-radius': '3px',
            background: `color-mix(in srgb, ${color()} 12%, transparent)`,
            color: color(),
            'flex-shrink': '0',
            'line-height': '1.5',
          }}
        >
          {currentLabel()}
        </span>
      )}
    </Show>
  );
}

export function SidebarTaskRow(props: SidebarTaskRowProps): JSX.Element {
  const task = () => store.tasks[props.taskId];
  const inlineAttention = () => getInlineAttentionState(getTaskAttentionEntry(props.taskId));
  const index = () => props.globalIndex(props.taskId);
  const isActive = () => store.activeTaskId === props.taskId;
  const isFocused = () => store.sidebarFocused && store.sidebarFocusedTaskId === props.taskId;
  const isDragging = () => props.dragFromIndex() !== null;
  const isDraggedTask = () => props.dragFromIndex() === index();
  const className = () => {
    const currentTask = task();
    if (!currentTask) {
      return 'task-item';
    }
    if (currentTask.closingStatus === 'removing') {
      return 'task-item task-item-removing';
    }
    return 'task-item task-item-appearing';
  };
  const border = () => {
    if (isFocused()) {
      return '1.5px solid var(--border-focus)';
    }
    return '1.5px solid transparent';
  };
  const color = () => {
    if (isActive()) {
      return theme.fg;
    }
    return theme.fgMuted;
  };
  const cursor = () => {
    if (isDragging()) {
      return 'grabbing';
    }
    return 'pointer';
  };
  const fontWeight = () => {
    if (isActive()) {
      return '500';
    }
    return '400';
  };
  const opacity = () => {
    if (isDraggedTask()) {
      return '0.4';
    }
    return '1';
  };
  return (
    <Show when={task()}>
      {(currentTask) => (
        <>
          <Show when={props.dropTargetIndex() === index()}>
            <div class="drop-indicator" />
          </Show>
          <div
            class={className()}
            data-task-index={index()}
            onClick={() => {
              setActiveTask(props.taskId);
              focusSidebar();
            }}
            style={{
              padding: '7px 10px',
              'border-radius': '6px',
              background: 'transparent',
              color: color(),
              'font-size': sf(12),
              'font-weight': fontWeight(),
              cursor: cursor(),
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              opacity: opacity(),
              display: 'flex',
              'flex-direction': 'column',
              gap: inlineAttention().preview ? '2px' : '0',
              border: border(),
            }}
          >
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                width: '100%',
                'min-width': '0',
              }}
            >
              <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
              <Show when={currentTask().directMode}>
                <TaskBranchBadge branchName={currentTask().branchName} />
              </Show>
              <TaskReviewBadge taskId={props.taskId} />
              <Show when={inlineAttention().label}>
                {(currentLabel) => (
                  <span
                    style={{
                      'font-size': sf(9),
                      'font-weight': '600',
                      padding: '1px 5px',
                      'border-radius': '3px',
                      background: `color-mix(in srgb, ${inlineAttention().color} 12%, transparent)`,
                      color: inlineAttention().color,
                      'flex-shrink': '0',
                      'line-height': '1.5',
                    }}
                  >
                    {currentLabel()}
                  </span>
                )}
              </Show>
              <span
                style={{
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  flex: '1',
                  'min-width': '0',
                }}
              >
                {currentTask().name}
              </span>
              <Show when={inlineAttention().age}>
                {(age) => (
                  <span
                    style={{
                      color: theme.fgSubtle,
                      'font-size': sf(10),
                      'flex-shrink': '0',
                    }}
                  >
                    {age()}
                  </span>
                )}
              </Show>
            </div>
            <Show when={inlineAttention().preview}>
              {(preview) => (
                <div
                  style={{
                    color: theme.fgMuted,
                    'font-size': sf(10),
                    'line-height': '1.35',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                    'padding-left': '18px',
                    width: '100%',
                    'box-sizing': 'border-box',
                  }}
                >
                  {preview()}
                </div>
              )}
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}

export function CollapsedSidebarTaskRow(props: CollapsedSidebarTaskRowProps): JSX.Element {
  const task = () => store.tasks[props.taskId];

  return (
    <Show when={task()}>
      {(currentTask) => (
        <div
          class="task-item task-item-appearing"
          role="button"
          tabIndex={0}
          onClick={() => uncollapseTask(props.taskId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              uncollapseTask(props.taskId);
            }
          }}
          title="Click to restore"
          style={{
            padding: '7px 10px',
            'border-radius': '6px',
            background: 'transparent',
            color: theme.fgSubtle,
            'font-size': sf(12),
            'font-weight': '400',
            cursor: 'pointer',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            opacity: '0.6',
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            border: '1.5px solid transparent',
          }}
        >
          <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
          <TaskProjectDot projectId={currentTask().projectId} />
          <Show when={currentTask().directMode}>
            <TaskBranchBadge branchName={currentTask().branchName} />
          </Show>
          <TaskReviewBadge taskId={props.taskId} />
          <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
            {currentTask().name}
          </span>
        </div>
      )}
    </Show>
  );
}
