import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { closeTask } from '../app/task-workflows';
import { getProject } from '../store/projects';
import {
  getTaskGitStatus,
  isTaskGitStatusFresh,
  refreshTaskGitStatusForTask,
} from '../store/task-git-status';
import {
  isCurrentBranchTask,
  isExistingWorktreeTask,
  isManagedWorktreeTask,
  normalizeTaskBaseBranch,
} from '../store/task-git-isolation';
import { ConfirmDialog } from './ConfirmDialog';
import { InlineNotice } from './InlineNotice';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

interface CloseTaskDialogProps {
  open: boolean;
  task: Task;
  onDone: () => void;
}

export function CloseTaskDialog(props: CloseTaskDialogProps): JSX.Element {
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false);
  const [gitStatusReady, setGitStatusReady] = createSignal(false);
  let gitStatusRefreshGeneration = 0;

  onCleanup(invalidateGitStatusRefresh);

  function nextGitStatusRefreshGeneration(): number {
    gitStatusRefreshGeneration += 1;
    return gitStatusRefreshGeneration;
  }

  function invalidateGitStatusRefresh(): void {
    gitStatusRefreshGeneration += 1;
  }

  function resetGitStatusValidation(): void {
    setGitStatusReady(false);
    setGitStatusLoading(false);
  }

  function refreshDialogGitStatus(taskId: string): void {
    const generation = nextGitStatusRefreshGeneration();
    setGitStatusReady(false);
    setGitStatusLoading(true);

    void refreshTaskGitStatusForTask(taskId)
      .then((refreshed) => {
        if (generation !== gitStatusRefreshGeneration) {
          return;
        }

        setGitStatusReady(refreshed);
      })
      .finally(() => {
        if (generation !== gitStatusRefreshGeneration) {
          return;
        }

        setGitStatusLoading(false);
      });
  }

  createEffect(() => {
    if (!props.open || !isManagedWorktreeTask(props.task)) {
      invalidateGitStatusRefresh();
      resetGitStatusValidation();
      return;
    }

    refreshDialogGitStatus(props.task.id);
  });

  const worktreeStatus = () => getTaskGitStatus(props.task.id);
  const targetBranchLabel = () =>
    normalizeTaskBaseBranch(props.task) ??
    getProject(props.task.projectId)?.baseBranch ??
    'base branch';
  const isGitStatusVerified = () =>
    !gitStatusLoading() && gitStatusReady() && isTaskGitStatusFresh(worktreeStatus());
  const gitStatusUnavailable = () =>
    isManagedWorktreeTask(props.task) &&
    !gitStatusLoading() &&
    (!gitStatusReady() || !isTaskGitStatusFresh(worktreeStatus()));
  const hasRiskyGitStatus = () =>
    Boolean(worktreeStatus()?.has_uncommitted_changes || worktreeStatus()?.has_committed_changes);
  const gitStatusErrorMessage = () => worktreeStatus()?.errorMessage ?? '';
  const closeConfirmDisabled = () => isManagedWorktreeTask(props.task) && gitStatusLoading();

  return (
    <ConfirmDialog
      open={props.open}
      title="Close Task"
      message={
        <div>
          <Show when={isCurrentBranchTask(props.task)}>
            <p style={{ margin: '0' }}>
              This will stop all running agents and shells for this task. No git operations will be
              performed.
            </p>
          </Show>
          <Show when={isExistingWorktreeTask(props.task)}>
            <p style={{ margin: '0' }}>
              This will stop all running agents and shells for this task. The existing worktree and
              branch will be kept.
            </p>
          </Show>
          <Show when={isManagedWorktreeTask(props.task)}>
            <Show when={gitStatusUnavailable()}>
              <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
                Warning: Unable to verify current git status. Closing may remove uncommitted changes
                or unmerged commits.
                <Show when={gitStatusErrorMessage()}> Details: {gitStatusErrorMessage()}</Show>
              </InlineNotice>
            </Show>
            <Show when={isGitStatusVerified() && hasRiskyGitStatus()}>
              <div
                style={{
                  'margin-bottom': '12px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '8px',
                }}
              >
                <Show when={worktreeStatus()?.has_uncommitted_changes}>
                  <InlineNotice tone="warning" weight="semibold">
                    Warning: There are uncommitted changes that will be permanently lost.
                  </InlineNotice>
                </Show>
                <Show when={worktreeStatus()?.has_committed_changes}>
                  <InlineNotice tone="warning" weight="semibold">
                    Warning: This branch has commits that have not been merged into{' '}
                    {targetBranchLabel()}.
                  </InlineNotice>
                </Show>
              </div>
            </Show>
            {(() => {
              const project = getProject(props.task.projectId);
              const willDeleteBranch = project?.deleteBranchOnClose ?? true;
              return (
                <>
                  <p style={{ margin: '0 0 8px' }}>
                    {willDeleteBranch
                      ? 'This action cannot be undone. The following will be permanently deleted:'
                      : 'The worktree will be removed but the branch will be kept:'}
                  </p>
                  <ul
                    style={{
                      margin: '0',
                      'padding-left': '20px',
                      display: 'flex',
                      'flex-direction': 'column',
                      gap: '4px',
                    }}
                  >
                    <Show when={willDeleteBranch}>
                      <li>
                        Local feature branch <strong>{props.task.branchName}</strong>
                      </li>
                    </Show>
                    <li>
                      Worktree at <strong>{props.task.worktreePath}</strong>
                    </li>
                    <Show when={!willDeleteBranch}>
                      <li style={{ color: theme.fgMuted }}>
                        Branch <strong>{props.task.branchName}</strong> will be kept
                      </li>
                    </Show>
                  </ul>
                </>
              );
            })()}
          </Show>
        </div>
      }
      confirmLabel={isManagedWorktreeTask(props.task) ? 'Delete' : 'Close'}
      danger={isManagedWorktreeTask(props.task)}
      confirmDisabled={closeConfirmDisabled()}
      onConfirm={() => {
        props.onDone();
        closeTask(props.task.id);
      }}
      onCancel={() => props.onDone()}
    />
  );
}
