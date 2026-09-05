import { Show, createMemo, createSignal, type JSX } from 'solid-js';
import { runCoordinatorOperatorAction } from '../app/coordinator-operator-actions';
import { EditableText, type EditableTextHandle } from './EditableText';
import { IconButton } from './IconButton';
import { TaskActivityBadge, TaskActivityIndicator } from './TaskActivityIndicator';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import {
  isCurrentBranchTask,
  isExistingWorktreeTask,
  normalizeTaskBaseBranch,
} from '../store/task-git-isolation';
import { getCoordinatorRunForTask } from '../store/coordinator';
import { showNotification } from '../store/notification';
import { isNonGitProject } from '../store/project-mode';
import { isTerminalTask } from '../domain/task-mode';
import type { Task } from '../store/types';
import type { TaskActivityStatus } from '../store/taskStatus';
import {
  getProject,
  getPeerViewerCountForTask,
  getTaskCommandOwnerStatus,
  listPeerSessions,
} from '../store/store';
import { ProjectRootBadge, TerminalTaskBadge } from './TaskContextBadges';

interface TaskTitleBarProps {
  task: Task;
  mergeAvailable: boolean;
  pushAvailable: boolean;
  isActive: boolean;
  taskActivityStatus: TaskActivityStatus;
  hasPreviewPorts: boolean;
  isPreviewVisible: boolean;
  pushing: boolean;
  pushSuccess: boolean;
  onMouseDown: (event: MouseEvent) => void;
  onPreviewButtonClick: () => void;
  onUpdateTaskName: (value: string) => void;
  onSetTitleEditHandle: (handle: EditableTextHandle | undefined) => void;
  onOpenMerge: () => void;
  onOpenPush: () => void;
  onCollapse: () => void;
  onClose: () => void;
}

function getPreviewButtonTitle(hasPreviewPorts: boolean, isPreviewVisible: boolean): string {
  if (isPreviewVisible) {
    return 'Hide preview';
  }

  if (!hasPreviewPorts) {
    return 'Open preview and ports';
  }

  return 'Show preview';
}

export function TaskTitleBar(props: TaskTitleBarProps): JSX.Element {
  const [resumingCoordinatorRun, setResumingCoordinatorRun] = createSignal(false);
  // An accepted resume keeps the button disabled until a newer run snapshot
  // lands (which normally removes the button), so a fast double-click cannot
  // send a duplicate resume_run that surfaces a spurious failure toast.
  const [acceptedResume, setAcceptedResume] = createSignal<{ updatedAt: number } | null>(null);
  const mergeTargetLabel = createMemo(
    () => normalizeTaskBaseBranch(props.task) ?? getProject(props.task.projectId)?.baseBranch,
  );
  // Stale-after-restore is operator-actionable from outside the rail: the
  // title bar offers the same one-click resume through the shared
  // operator-action workflow as the coordinator rail.
  const hasStaleCoordinatorRun = createMemo(() => {
    if (props.task.coordinatorRole !== 'coordinator') {
      return false;
    }

    return getCoordinatorRunForTask(props.task.id)?.status === 'stale-after-restore';
  });
  const resumeAwaitingSnapshot = createMemo(() => {
    const ack = acceptedResume();
    if (!ack) {
      return false;
    }

    const run = getCoordinatorRunForTask(props.task.id);
    return run !== null && run !== undefined && run.updatedAt === ack.updatedAt;
  });
  const resumeDisabled = createMemo(() => resumingCoordinatorRun() || resumeAwaitingSnapshot());

  async function resumeStaleCoordinatorRun(): Promise<void> {
    if (resumeDisabled()) {
      return;
    }

    const runAtRequest = getCoordinatorRunForTask(props.task.id);
    setResumingCoordinatorRun(true);
    try {
      const result = await runCoordinatorOperatorAction({
        request: { toolName: 'resume_run' },
        taskId: props.task.id,
      });
      if (!result.accepted) {
        showNotification(`Failed to resume coordinator run: ${result.message}`, {
          kind: 'error',
        });
        return;
      }

      if (runAtRequest) {
        setAcceptedResume({ updatedAt: runAtRequest.updatedAt });
      }
    } finally {
      setResumingCoordinatorRun(false);
    }
  }
  const mergeButtonTitle = createMemo(() => {
    const target = mergeTargetLabel();
    return target ? `Merge into ${target}` : 'Merge';
  });
  const ownerStatus = createMemo(() => getTaskCommandOwnerStatus(props.task.id));
  const peerViewerCount = createMemo(() => getPeerViewerCountForTask(props.task.id));
  const hasPeerSessions = createMemo(() => listPeerSessions().length > 0);
  const shouldShowOwnerStatus = createMemo(() => {
    const status = ownerStatus();
    if (!status) {
      return false;
    }

    if (!status.isSelf) {
      return true;
    }

    return hasPeerSessions();
  });

  return (
    <div
      class={props.isActive ? 'island-header-active' : ''}
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        padding: '0 10px',
        height: '100%',
        background: 'transparent',
        'border-bottom': `1px solid ${theme.border}`,
        'user-select': 'none',
        cursor: 'grab',
      }}
      onMouseDown={(event) => props.onMouseDown(event)}
    >
      <div
        style={{
          overflow: 'hidden',
          flex: '1',
          'min-width': '0',
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <TaskActivityIndicator status={props.taskActivityStatus} size="md" />
        <TaskActivityBadge status={props.taskActivityStatus} showIcon={false} />
        <Show when={hasStaleCoordinatorRun()}>
          <button
            aria-label="Resume coordinator run"
            data-coordinator-title-resume="true"
            disabled={resumeDisabled()}
            title={
              resumeAwaitingSnapshot()
                ? 'Resume accepted — syncing with the coordinator…'
                : 'The coordinator run is stale after a restart. Resume to respawn unfinished work.'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void resumeStaleCoordinatorRun();
            }}
            style={{
              ...typography.metaStrong,
              display: 'inline-flex',
              'align-items': 'center',
              gap: '5px',
              padding: '2px 8px',
              'border-radius': '999px',
              background: `color-mix(in srgb, ${theme.accent} 14%, transparent)`,
              color: resumeDisabled() ? theme.fgSubtle : theme.accent,
              border: `1px solid color-mix(in srgb, ${theme.accent} 24%, transparent)`,
              cursor: resumeDisabled() ? 'not-allowed' : 'pointer',
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
          >
            <Show when={resumingCoordinatorRun()}>
              <span
                class="inline-spinner"
                aria-hidden="true"
                style={{ width: '10px', height: '10px' }}
              />
            </Show>
            Resume
          </button>
        </Show>
        <Show when={isCurrentBranchTask(props.task)}>
          <ProjectRootBadge branchName={props.task.branchName} />
        </Show>
        <Show when={isTerminalTask(props.task)}>
          <TerminalTaskBadge />
        </Show>
        <Show when={isExistingWorktreeTask(props.task)}>
          <span
            style={{
              ...typography.metaStrong,
              padding: '2px 8px',
              'border-radius': '4px',
              background: `color-mix(in srgb, ${theme.accent} 14%, transparent)`,
              color: theme.accent,
              border: `1px solid color-mix(in srgb, ${theme.accent} 24%, transparent)`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
          >
            external
          </span>
        </Show>
        <Show when={isNonGitProject(props.task)}>
          <span
            style={{
              ...typography.metaStrong,
              padding: '2px 8px',
              'border-radius': '4px',
              background: `color-mix(in srgb, ${theme.fgMuted} 14%, transparent)`,
              color: theme.fgMuted,
              border: `1px solid color-mix(in srgb, ${theme.fgMuted} 22%, transparent)`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
          >
            non-git
          </span>
        </Show>
        <Show when={peerViewerCount() > 0}>
          <span
            style={{
              ...typography.metaStrong,
              padding: '2px 8px',
              'border-radius': '999px',
              background: `color-mix(in srgb, ${theme.fgSubtle} 12%, transparent)`,
              color: theme.fgMuted,
              border: `1px solid color-mix(in srgb, ${theme.fgSubtle} 18%, transparent)`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
            title={`${peerViewerCount()} other session${peerViewerCount() === 1 ? '' : 's'} viewing this task`}
          >
            {peerViewerCount()} viewing
          </span>
        </Show>
        <Show when={shouldShowOwnerStatus() && ownerStatus()}>
          {(status) => (
            <span
              aria-label={status().label}
              title={status().label}
              style={{
                ...typography.metaStrong,
                padding: status().isSelf ? '2px 6px' : '2px 8px',
                'border-radius': '999px',
                background: `color-mix(in srgb, ${status().isSelf ? theme.success : theme.warning} 14%, transparent)`,
                color: status().isSelf ? theme.success : theme.warning,
                border: `1px solid color-mix(in srgb, ${status().isSelf ? theme.success : theme.warning} 20%, transparent)`,
                'flex-shrink': '0',
                'white-space': 'nowrap',
                display: 'inline-flex',
                'align-items': 'center',
                gap: '6px',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '7px',
                  height: '7px',
                  'border-radius': '999px',
                  background: status().isSelf ? theme.success : theme.warning,
                  'box-shadow': `0 0 8px color-mix(in srgb, ${status().isSelf ? theme.success : theme.warning} 55%, transparent)`,
                  'flex-shrink': '0',
                }}
              />
              <span>{status().label}</span>
            </span>
          )}
        </Show>
        <h2
          aria-label={props.task.name}
          style={{
            margin: '0',
            'min-width': '0',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'font-size': 'inherit',
            'font-weight': 'inherit',
            'line-height': 'inherit',
          }}
        >
          <EditableText
            value={props.task.name}
            onCommit={(value) => props.onUpdateTaskName(value)}
            class="editable-text"
            title={props.task.savedInitialPrompt}
            onHandle={(handle) => props.onSetTitleEditHandle(handle)}
          />
        </h2>
      </div>
      <div style={{ display: 'flex', gap: '4px', 'margin-left': '8px', 'flex-shrink': '0' }}>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2.75 3.5A1.75 1.75 0 0 1 4.5 1.75h7A1.75 1.75 0 0 1 13.25 3.5v6A1.75 1.75 0 0 1 11.5 11.25h-2v1h1.75a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5H6.5v-1h-2A1.75 1.75 0 0 1 2.75 9.5v-6Zm1.75-.25a.25.25 0 0 0-.25.25v6c0 .138.112.25.25.25h7a.25.25 0 0 0 .25-.25v-6a.25.25 0 0 0-.25-.25h-7Z" />
              </svg>
            }
            onClick={() => props.onPreviewButtonClick()}
            title={getPreviewButtonTitle(props.hasPreviewPorts, props.isPreviewVisible)}
          />
          <Show when={props.hasPreviewPorts}>
            <span
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background: theme.accent,
                'pointer-events': 'none',
              }}
            />
          </Show>
        </div>
        <Show when={props.mergeAvailable}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
              </svg>
            }
            onClick={() => props.onOpenMerge()}
            title={mergeButtonTitle()}
          />
        </Show>
        <Show when={props.pushAvailable}>
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <Show
              when={!props.pushing}
              fallback={
                <div
                  role="status"
                  aria-live="polite"
                  aria-label="Pushing changes"
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    padding: '4px',
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                  }}
                >
                  <span
                    class="inline-spinner"
                    aria-hidden="true"
                    style={{ width: '14px', height: '14px' }}
                  />
                </div>
              }
            >
              <IconButton
                icon={
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path
                      d="M4.75 8a.75.75 0 0 1 .75-.75h5.19L8.22 4.78a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06l2.47-2.47H5.5A.75.75 0 0 1 4.75 8Z"
                      transform="rotate(-90 8 8)"
                    />
                  </svg>
                }
                onClick={() => props.onOpenPush()}
                title="Push to remote"
              />
            </Show>
            <Show when={props.pushSuccess}>
              <div
                style={{
                  position: 'absolute',
                  bottom: '-4px',
                  right: '-4px',
                  width: '12px',
                  height: '12px',
                  'border-radius': '50%',
                  background: theme.success,
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  'pointer-events': 'none',
                }}
              >
                <svg width="8" height="8" viewBox="0 0 16 16" fill="white">
                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                </svg>
              </div>
            </Show>
          </div>
        </Show>
        <IconButton
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Z" />
            </svg>
          }
          onClick={() => props.onCollapse()}
          title="Collapse task"
        />
        <IconButton
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          }
          onClick={() => props.onClose()}
          title="Close task"
        />
      </div>
    </div>
  );
}
