import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { subscribeDesktopTaskNotesUnsaved } from '../app/task-notes-recovery-channel';
import { closeTask } from '../app/task-workflows';
import { getProject } from '../store/projects';
import {
  getTaskGitStatus,
  isTaskGitStatusFresh,
  refreshTaskGitStatusForTask,
} from '../store/task-git-status';
import { normalizeTaskBaseBranch } from '../store/task-git-isolation';
import { ConfirmDialog } from './ConfirmDialog';
import { InlineNotice } from './InlineNotice';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';
import { getTaskClosePolicy } from './task-close-policy';

interface CloseTaskDialogProps {
  open: boolean;
  task: Task;
  unsavedInitialPrompt?: boolean;
  onDone: () => void;
}

export function CloseTaskDialog(props: CloseTaskDialogProps): JSX.Element {
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false);
  const [unsavedTaskNotes, setUnsavedTaskNotes] = createSignal(false);
  const closePolicy = () => getTaskClosePolicy(props.task, getProject(props.task.projectId));
  const isManagedWorktree = () => closePolicy().location === 'managed-worktree';
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
    setGitStatusLoading(false);
  }

  function refreshDialogGitStatus(taskId: string): void {
    const generation = nextGitStatusRefreshGeneration();
    setGitStatusLoading(true);

    void refreshTaskGitStatusForTask(taskId).finally(() => {
      if (generation !== gitStatusRefreshGeneration) {
        return;
      }

      setGitStatusLoading(false);
    });
  }

  createEffect(() => {
    if (!props.open || !isManagedWorktree()) {
      invalidateGitStatusRefresh();
      resetGitStatusValidation();
      return;
    }

    refreshDialogGitStatus(props.task.id);
  });

  createEffect(() => {
    if (!props.open) {
      setUnsavedTaskNotes(false);
      return;
    }
    const unsubscribe = subscribeDesktopTaskNotesUnsaved(props.task.id, setUnsavedTaskNotes);
    onCleanup(unsubscribe);
  });

  const worktreeStatus = () => getTaskGitStatus(props.task.id);
  const targetBranchLabel = () =>
    normalizeTaskBaseBranch(props.task) ??
    getProject(props.task.projectId)?.baseBranch ??
    'base branch';
  const isGitStatusVerified = () => !gitStatusLoading() && isTaskGitStatusFresh(worktreeStatus());
  const gitStatusUnavailable = () =>
    isManagedWorktree() && !gitStatusLoading() && !isTaskGitStatusFresh(worktreeStatus());
  const hasRiskyGitStatus = () =>
    Boolean(worktreeStatus()?.has_uncommitted_changes || worktreeStatus()?.has_committed_changes);
  const gitStatusErrorMessage = () => worktreeStatus()?.errorMessage ?? '';
  const closeConfirmDisabled = () => isManagedWorktree() && gitStatusLoading();

  return (
    <ConfirmDialog
      open={props.open}
      title="Close Task"
      message={
        <div>
          <Show when={props.unsavedInitialPrompt}>
            <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
              The latest initial prompt edit has not been saved. Closing now will discard that local
              text.
            </InlineNotice>
          </Show>
          <Show when={unsavedTaskNotes()}>
            <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
              Unsaved task notes will also be discarded.
            </InlineNotice>
          </Show>
          <Show when={closePolicy().location === 'non-git'}>
            <p style={{ margin: '0' }}>
              This will stop all running {closePolicy().runningProcessesLabel} for this non-git
              task. No git operations will be performed.
            </p>
          </Show>
          <Show when={closePolicy().location === 'project-root'}>
            <p style={{ margin: '0' }}>
              This will stop all running {closePolicy().runningProcessesLabel} for this task. No git
              operations will be performed.
            </p>
          </Show>
          <Show when={closePolicy().location === 'existing-worktree'}>
            <p style={{ margin: '0' }}>
              This will stop all running {closePolicy().runningProcessesLabel} for this task. The
              existing worktree and branch will be kept.
            </p>
          </Show>
          <Show when={isManagedWorktree()}>
            <p style={{ margin: '0 0 12px' }}>
              This will stop all running {closePolicy().runningProcessesLabel} for this task.
            </p>
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
              const willDeleteBranch = closePolicy().willDeleteBranch;
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
      confirmLabel={isManagedWorktree() ? 'Delete' : 'Close'}
      danger={isManagedWorktree()}
      confirmDisabled={closeConfirmDisabled()}
      onConfirm={() => {
        const taskNotesDiscardConfirmed = unsavedTaskNotes();
        props.onDone();
        void closeTask(props.task.id, { taskNotesDiscardConfirmed });
      }}
      onCancel={() => props.onDone()}
    />
  );
}
