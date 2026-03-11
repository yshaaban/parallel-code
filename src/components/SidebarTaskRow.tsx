import { Show, type JSX } from 'solid-js';
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

export function SidebarTaskRow(props: SidebarTaskRowProps): JSX.Element {
  const task = () => store.tasks[props.taskId];
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
              'align-items': 'center',
              gap: '6px',
              border: border(),
            }}
          >
            <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
            <Show when={currentTask().directMode}>
              <TaskBranchBadge branchName={currentTask().branchName} />
            </Show>
            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
              {currentTask().name}
            </span>
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
          <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
            {currentTask().name}
          </span>
        </div>
      )}
    </Show>
  );
}
