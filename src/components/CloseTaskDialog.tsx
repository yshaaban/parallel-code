import { Show, createEffect, createSignal } from 'solid-js';
import { closeTask } from '../app/task-workflows';
import { getProject } from '../store/projects';
import { getTaskGitStatus, refreshTaskGitStatusForTask } from '../store/task-git-status';
import { ConfirmDialog } from './ConfirmDialog';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

interface CloseTaskDialogProps {
  open: boolean;
  task: Task;
  onDone: () => void;
}

export function CloseTaskDialog(props: CloseTaskDialogProps) {
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false);
  const [gitStatusReady, setGitStatusReady] = createSignal(false);

  createEffect(() => {
    if (!props.open || props.task.directMode) {
      return;
    }

    setGitStatusReady(false);
    setGitStatusLoading(true);
    void refreshTaskGitStatusForTask(props.task.id)
      .then((refreshed) => {
        setGitStatusReady(refreshed);
      })
      .finally(() => {
        setGitStatusLoading(false);
      });
  });

  const worktreeStatus = () => getTaskGitStatus(props.task.id);
  const targetBranchLabel = () => getProject(props.task.projectId)?.baseBranch ?? 'base branch';
  const isGitStatusVerified = () => !gitStatusLoading() && gitStatusReady();
  const gitStatusUnavailable = () =>
    !props.task.directMode && !gitStatusLoading() && !gitStatusReady();
  const hasRiskyGitStatus = () =>
    Boolean(worktreeStatus()?.has_uncommitted_changes || worktreeStatus()?.has_committed_changes);
  const closeConfirmDisabled = () => !props.task.directMode && gitStatusLoading();

  return (
    <ConfirmDialog
      open={props.open}
      title="Close Task"
      message={
        <div>
          <Show when={props.task.directMode}>
            <p style={{ margin: '0' }}>
              This will stop all running agents and shells for this task. No git operations will be
              performed.
            </p>
          </Show>
          <Show when={!props.task.directMode}>
            <Show when={gitStatusUnavailable()}>
              <div
                style={{
                  'margin-bottom': '12px',
                  'font-size': '12px',
                  color: theme.warning,
                  background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                  padding: '8px 12px',
                  'border-radius': '8px',
                  border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                  'font-weight': '600',
                }}
              >
                Warning: Unable to verify current git status. Closing may remove uncommitted changes
                or unmerged commits.
              </div>
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
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.warning,
                      background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                      padding: '8px 12px',
                      'border-radius': '8px',
                      border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                      'font-weight': '600',
                    }}
                  >
                    Warning: There are uncommitted changes that will be permanently lost.
                  </div>
                </Show>
                <Show when={worktreeStatus()?.has_committed_changes}>
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.warning,
                      background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                      padding: '8px 12px',
                      'border-radius': '8px',
                      border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                      'font-weight': '600',
                    }}
                  >
                    Warning: This branch has commits that have not been merged into{' '}
                    {targetBranchLabel()}.
                  </div>
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
      confirmLabel={props.task.directMode ? 'Close' : 'Delete'}
      danger={!props.task.directMode}
      confirmDisabled={closeConfirmDisabled()}
      onConfirm={() => {
        props.onDone();
        closeTask(props.task.id);
      }}
      onCancel={() => props.onDone()}
    />
  );
}
