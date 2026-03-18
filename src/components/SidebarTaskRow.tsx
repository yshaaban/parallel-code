import { Show, type JSX } from 'solid-js';
import { getTaskAttentionEntry } from '../app/task-presentation-status';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { isTaskRemoving } from '../domain/task-closing';
import { getTaskReviewStateLabel, type TaskReviewState } from '../domain/task-convergence';
import type { AgentDef } from '../ipc/types';
import {
  focusSidebar,
  getTaskDotStatus,
  setActiveTask,
  store,
  uncollapseTask,
} from '../store/store';
import { AgentGlyph } from './AgentGlyph';
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
  color: string;
  duration: string | null;
  icon: string | null;
  title: string | null;
}

interface InlineAttentionIndicatorProps {
  attention: InlineAttentionState;
}

interface TaskReviewBadgeState {
  color: string;
  label: string;
}

type AttentionReason = NonNullable<ReturnType<typeof getTaskAttentionEntry>>['reason'];

const TASK_REVIEW_BADGE_COLORS: Record<TaskReviewState, string> = {
  'review-ready': theme.success,
  'needs-refresh': theme.warning,
  'merge-blocked': theme.error,
  'dirty-uncommitted': theme.accent,
  'no-changes': theme.fgMuted,
  unavailable: theme.fgMuted,
};

const TASK_REVIEW_BADGE_LABELS: Record<TaskReviewState, string | null> = {
  'review-ready': getTaskReviewStateLabel('review-ready'),
  'needs-refresh': getTaskReviewStateLabel('needs-refresh'),
  'merge-blocked': getTaskReviewStateLabel('merge-blocked'),
  'dirty-uncommitted': getTaskReviewStateLabel('dirty-uncommitted'),
  'no-changes': null,
  unavailable: null,
};

const ATTENTION_COLORS: Record<AttentionReason, string> = {
  failed: theme.error,
  'flow-controlled': theme.accent,
  paused: theme.warning,
  'quiet-too-long': theme.fgSubtle,
  'ready-for-next-step': theme.success,
  restoring: theme.accent,
  'waiting-input': theme.warning,
};

const ATTENTION_ICONS: Record<AttentionReason, string> = {
  failed: '!',
  'flow-controlled': '⇣',
  paused: '⏸',
  'quiet-too-long': '◦',
  'ready-for-next-step': '↩',
  restoring: '↻',
  'waiting-input': '⌨',
};

function formatElapsedTime(timestamp: number | null): string | null {
  if (!timestamp) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  return `${Math.floor(elapsedMinutes / 60)}h`;
}

function getAttentionTimestamp(
  attention: NonNullable<ReturnType<typeof getTaskAttentionEntry>>,
): number | null {
  if (attention.reason === 'quiet-too-long') {
    return attention.lastOutputAt;
  }

  return attention.updatedAt;
}

function getInlineAttentionState(
  attention: ReturnType<typeof getTaskAttentionEntry>,
): InlineAttentionState {
  if (!attention) {
    return {
      color: theme.fgMuted,
      duration: null,
      icon: null,
      title: null,
    };
  }

  return {
    color: ATTENTION_COLORS[attention.reason],
    duration: formatElapsedTime(getAttentionTimestamp(attention)),
    icon: ATTENTION_ICONS[attention.reason],
    title: attention.label,
  };
}

function getPrimaryTaskAgentDef(taskId: string): AgentDef | null {
  const task = store.tasks[taskId];
  if (!task) {
    return null;
  }

  const primaryAgentId = task.agentIds[0];
  if (primaryAgentId) {
    const primaryAgent = store.agents[primaryAgentId];
    if (primaryAgent?.def) {
      return primaryAgent.def;
    }
  }

  return task.savedAgentDef ?? null;
}

function getActiveTaskBorderColor(): string {
  return `color-mix(in srgb, ${theme.accent} 52%, ${theme.border})`;
}

function getActiveTaskBackground(isFocused: boolean): string {
  if (isFocused) {
    return `color-mix(in srgb, ${theme.bgSelected} 82%, ${theme.accent} 18%)`;
  }

  return theme.bgSelected;
}

function getFocusedTaskBackground(): string {
  return `color-mix(in srgb, ${theme.borderFocus} 10%, transparent)`;
}

function getTaskReviewBadgeState(taskId: string): TaskReviewBadgeState | null {
  const snapshot = getTaskConvergenceSnapshot(taskId);
  if (!snapshot) {
    return null;
  }

  const label = TASK_REVIEW_BADGE_LABELS[snapshot.state];
  if (!label) {
    return null;
  }

  return {
    color: TASK_REVIEW_BADGE_COLORS[snapshot.state],
    label,
  };
}

function InlineAttentionIndicator(props: InlineAttentionIndicatorProps): JSX.Element {
  return (
    <Show when={props.attention.icon}>
      <span
        aria-label={props.attention.title ?? undefined}
        title={props.attention.title ?? undefined}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '4px',
          color: props.attention.color,
          'font-size': sf(10),
          'flex-shrink': '0',
          'font-variant-numeric': 'tabular-nums',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            'font-size': sf(9),
            'line-height': '1',
          }}
        >
          {props.attention.icon}
        </span>
        <Show when={props.attention.duration}>
          {(currentDuration) => <span>{currentDuration()}</span>}
        </Show>
      </span>
    </Show>
  );
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
  const badge = () => getTaskReviewBadgeState(props.taskId);

  return (
    <Show when={badge()}>
      {(currentBadge) => (
        <div
          role="img"
          aria-label={currentBadge().label}
          title={currentBadge().label}
          style={{
            width: '7px',
            height: '7px',
            'border-radius': '50%',
            background: currentBadge().color,
            border: `1px solid color-mix(in srgb, ${currentBadge().color} 42%, ${theme.border})`,
            'box-shadow': `0 0 0 1px color-mix(in srgb, ${currentBadge().color} 14%, transparent)`,
            'flex-shrink': '0',
          }}
        />
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
    if (isTaskRemoving(currentTask)) {
      return 'task-item task-item-removing';
    }
    return 'task-item task-item-appearing';
  };
  const border = () => {
    if (isFocused()) {
      return '1.5px solid var(--border-focus)';
    }
    if (isActive()) {
      return `1.5px solid ${getActiveTaskBorderColor()}`;
    }
    return '1.5px solid transparent';
  };
  const background = () => {
    if (isActive()) {
      return getActiveTaskBackground(isFocused());
    }
    if (isFocused()) {
      return getFocusedTaskBackground();
    }
    return 'transparent';
  };
  const color = () => {
    if (isActive() || isFocused()) {
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
    if (isActive() || isFocused()) {
      return '500';
    }
    return '400';
  };
  const boxShadow = () => {
    if (isFocused()) {
      if (!isActive()) {
        return [
          `inset 2px 0 0 ${theme.borderFocus}`,
          `0 0 0 1px color-mix(in srgb, ${theme.borderFocus} 28%, transparent)`,
        ].join(', ');
      }
      return [
        `inset 3px 0 0 ${theme.borderFocus}`,
        `0 0 0 1px color-mix(in srgb, ${theme.borderFocus} 36%, transparent)`,
        `0 8px 18px color-mix(in srgb, ${theme.borderFocus} 10%, transparent)`,
      ].join(', ');
    }
    if (isActive()) {
      return [
        `inset 3px 0 0 ${theme.accent}`,
        `0 0 0 1px color-mix(in srgb, ${theme.accent} 24%, transparent)`,
        `0 6px 16px color-mix(in srgb, ${theme.accent} 8%, transparent)`,
      ].join(', ');
    }
    return 'none';
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
              background: background(),
              color: color(),
              'font-size': sf(12),
              'font-weight': fontWeight(),
              cursor: cursor(),
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              opacity: opacity(),
              display: 'flex',
              'align-items': 'center',
              border: border(),
              'box-shadow': boxShadow(),
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
              <AgentGlyph agentDef={getPrimaryTaskAgentDef(props.taskId)} />
              <Show when={currentTask().directMode}>
                <TaskBranchBadge branchName={currentTask().branchName} />
              </Show>
              <TaskReviewBadge taskId={props.taskId} />
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
              <InlineAttentionIndicator attention={inlineAttention()} />
            </div>
          </div>
        </>
      )}
    </Show>
  );
}

export function CollapsedSidebarTaskRow(props: CollapsedSidebarTaskRowProps): JSX.Element {
  const task = () => store.tasks[props.taskId];
  const isActive = () => store.activeTaskId === props.taskId;

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
            background: isActive() ? theme.bgSelected : 'transparent',
            color: isActive() ? theme.fg : theme.fgSubtle,
            'font-size': sf(12),
            'font-weight': isActive() ? '500' : '400',
            cursor: 'pointer',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            opacity: '0.6',
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            border: isActive()
              ? `1.5px solid ${getActiveTaskBorderColor()}`
              : '1.5px solid transparent',
            'box-shadow': isActive()
              ? [
                  `inset 3px 0 0 ${theme.accent}`,
                  `0 0 0 1px color-mix(in srgb, ${theme.accent} 24%, transparent)`,
                ].join(', ')
              : 'none',
          }}
        >
          <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
          <AgentGlyph agentDef={getPrimaryTaskAgentDef(props.taskId)} />
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
