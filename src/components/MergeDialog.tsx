import { Show, For, createSignal, createResource, createEffect } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { mergeTask, sendPrompt } from '../app/task-workflows';
import { getProject } from '../store/projects';
import { getTaskGitStatus, refreshTaskGitStatusForTask } from '../store/task-git-status';
import { store } from '../store/state';
import { ConfirmDialog } from './ConfirmDialog';
import { ChangedFilesList } from './ChangedFilesList';
import { InlineNotice } from './InlineNotice';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';

interface MergeDialogProps {
  open: boolean;
  task: Task;
  initialCleanup: boolean;
  onDone: () => void;
  onDiffFileClick: (file: ChangedFile) => void;
}

export function MergeDialog(props: MergeDialogProps) {
  const [mergeError, setMergeError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal('');
  const [rebasing, setRebasing] = createSignal(false);
  const [rebaseError, setRebaseError] = createSignal('');
  const [rebaseSuccess, setRebaseSuccess] = createSignal(false);
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false);
  const [gitStatusReady, setGitStatusReady] = createSignal(false);

  const [branchLog, { refetch: refetchBranchLog }] = createResource(
    () => (props.open ? props.task.worktreePath : null),
    (path) => invoke(IPC.GetBranchLog, { worktreePath: path }),
  );
  const [mergeStatus, { refetch: refetchMergeStatus }] = createResource(
    () => (props.open ? props.task.worktreePath : null),
    (path) => invoke(IPC.CheckMergeStatus, { worktreePath: path }),
  );

  const worktreeStatus = () => getTaskGitStatus(props.task.id);
  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;
  const hasUncommittedChanges = () => worktreeStatus()?.has_uncommitted_changes ?? false;
  const mergeTargetLabel = () => getProject(props.task.projectId)?.baseBranch ?? 'base branch';
  const rebasePrompt = () => `rebase on ${mergeTargetLabel()}`;
  const isGitStatusVerified = () => !gitStatusLoading() && gitStatusReady();
  const gitStatusUnavailable = () => !gitStatusLoading() && !gitStatusReady();

  function getRebaseBlockedReason(): string | null {
    if (!isGitStatusVerified()) {
      return 'Checking worktree status...';
    }

    if (hasUncommittedChanges()) {
      return 'Commit or stash changes before rebasing';
    }

    return null;
  }

  const rebaseBlockedReason = () => getRebaseBlockedReason();
  const rebaseDisabled = () => rebasing() || rebaseBlockedReason() !== null;
  const mergeConfirmDisabled = () =>
    merging() ||
    mergeStatus.loading ||
    !isGitStatusVerified() ||
    hasConflicts() ||
    !hasCommittedChangesToMerge();

  function refreshDialogGitStatus(): void {
    setGitStatusReady(false);
    setGitStatusLoading(true);
    void refreshTaskGitStatusForTask(props.task.id)
      .then((refreshed) => {
        setGitStatusReady(refreshed);
      })
      .finally(() => {
        setGitStatusLoading(false);
      });
  }

  createEffect(() => {
    if (props.open) {
      setCleanupAfterMerge(props.initialCleanup);
      setSquash(false);
      setSquashMessage('');
      setMergeError('');
      setRebaseError('');
      setRebaseSuccess(false);
      setMerging(false);
      setRebasing(false);
      // Force fresh data on every open — covers edge cases where
      // createResource source tracking alone misses a refresh
      // (e.g. external rebase by AI agent while dialog was closed).
      refetchBranchLog();
      refetchMergeStatus();
      refreshDialogGitStatus();
    }
  });

  return (
    <ConfirmDialog
      open={props.open}
      title={`Merge into ${mergeTargetLabel()}`}
      width="520px"
      autoFocusCancel
      message={
        <div>
          <Show when={isGitStatusVerified() && hasUncommittedChanges()}>
            <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
              Warning: You have uncommitted changes that will NOT be included in this merge.
            </InlineNotice>
          </Show>
          <Show when={isGitStatusVerified() && worktreeStatus() && !hasCommittedChangesToMerge()}>
            <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
              Nothing to merge: this branch has no committed changes compared to the base branch.
            </InlineNotice>
          </Show>
          <Show when={gitStatusUnavailable()}>
            <InlineNotice style={{ 'margin-bottom': '12px' }} tone="warning" weight="semibold">
              Unable to verify current git status. Reopen this dialog after the worktree is
              available.
            </InlineNotice>
          </Show>
          <Show when={mergeStatus.loading}>
            <InlineNotice style={{ 'margin-bottom': '12px' }}>
              Checking for conflicts with {mergeTargetLabel()}...
            </InlineNotice>
          </Show>
          <Show when={!mergeStatus.loading && mergeStatus()}>
            {(status) => (
              <Show when={status().main_ahead_count > 0}>
                <InlineNotice
                  style={{
                    'margin-bottom': '12px',
                  }}
                  tone={hasConflicts() ? 'error' : 'warning'}
                  weight="semibold"
                >
                  <Show when={!hasConflicts()}>
                    {mergeTargetLabel()} has {status().main_ahead_count} new commit
                    {status().main_ahead_count > 1 ? 's' : ''}. Rebase onto {mergeTargetLabel()}{' '}
                    first.
                  </Show>
                  <Show when={hasConflicts()}>
                    <div>
                      Conflicts detected with {mergeTargetLabel()} (
                      {status().conflicting_files.length} file
                      {status().conflicting_files.length > 1 ? 's' : ''}):
                    </div>
                    <ul style={{ margin: '4px 0 0', 'padding-left': '20px', 'font-weight': '400' }}>
                      <For each={status().conflicting_files}>{(f) => <li>{f}</li>}</For>
                    </ul>
                    <div style={{ 'margin-top': '4px', 'font-weight': '400' }}>
                      Rebase onto {mergeTargetLabel()} to resolve conflicts.
                    </div>
                  </Show>
                </InlineNotice>
                <div
                  style={{
                    'margin-bottom': '12px',
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    disabled={rebaseDisabled()}
                    onClick={async () => {
                      setRebasing(true);
                      setRebaseError('');
                      setRebaseSuccess(false);
                      try {
                        await invoke(IPC.RebaseTask, { worktreePath: props.task.worktreePath });
                        setRebaseSuccess(true);
                        refetchMergeStatus();
                        refetchBranchLog();
                        refreshDialogGitStatus();
                      } catch (err) {
                        setRebaseError(String(err));
                      } finally {
                        setRebasing(false);
                      }
                    }}
                    title={rebaseBlockedReason() ?? `Rebase onto ${mergeTargetLabel()}`}
                    style={{
                      padding: '6px 14px',
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                      color: theme.fg,
                      cursor: rebaseDisabled() ? 'not-allowed' : 'pointer',
                      opacity: rebaseDisabled() ? '0.5' : '1',
                      ...typography.meta,
                    }}
                  >
                    {rebasing() ? 'Rebasing...' : `Rebase onto ${mergeTargetLabel()}`}
                  </button>
                  <Show
                    when={
                      props.task.agentIds.length > 0 &&
                      store.agents[props.task.agentIds[0]]?.status !== 'exited'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const agentId = props.task.agentIds[0];
                        props.onDone();
                        sendPrompt(props.task.id, agentId, rebasePrompt()).catch((err) => {
                          console.error('Failed to send rebase prompt:', err);
                        });
                      }}
                      title="Close dialog and ask the AI agent to rebase"
                      style={{
                        padding: '6px 14px',
                        background: theme.accent,
                        border: 'none',
                        'border-radius': '8px',
                        color: theme.accentText,
                        cursor: 'pointer',
                        ...typography.metaStrong,
                      }}
                    >
                      Rebase with AI
                    </button>
                  </Show>
                  <Show when={rebaseSuccess()}>
                    <span style={{ color: theme.success, ...typography.meta }}>
                      Rebase successful
                    </span>
                  </Show>
                  <Show when={rebaseError()}>
                    <span style={{ color: theme.error, ...typography.meta }}>{rebaseError()}</span>
                  </Show>
                </div>
              </Show>
            )}
          </Show>
          <p style={{ margin: '0 0 12px' }}>
            Merge <strong>{props.task.branchName}</strong> into {mergeTargetLabel()}:
          </p>
          <Show when={!branchLog.loading && branchLog()}>
            {(log) => {
              const commits = () =>
                log()
                  .split('\n')
                  .filter((l: string) => l.trim())
                  .map((l: string) => {
                    const stripped = l.replace(/^- /, '');
                    const spaceIdx = stripped.indexOf(' ');
                    if (spaceIdx > 0) {
                      return {
                        hash: stripped.slice(0, spaceIdx),
                        msg: stripped.slice(spaceIdx + 1),
                      };
                    }
                    // Hash-only line (empty commit message) — keep hash, use empty msg
                    const looksLikeHash = /^[a-f0-9]{7,}$/.test(stripped);
                    return {
                      hash: looksLikeHash ? stripped : '',
                      msg: looksLikeHash ? '' : stripped,
                    };
                  });
              return (
                <div
                  style={{
                    'margin-bottom': '12px',
                    'max-height': '120px',
                    'overflow-y': 'auto',
                    'overflow-x': 'hidden',
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    padding: '4px 0',
                    ...typography.monoMeta,
                  }}
                >
                  <For each={commits()}>
                    {(commit) => (
                      <div
                        title={`${commit.hash} ${commit.msg}`}
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                          padding: '2px 8px',
                          'white-space': 'nowrap',
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          color: theme.fg,
                        }}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          style={{ 'flex-shrink': '0' }}
                        >
                          <circle
                            cx="5"
                            cy="5"
                            r="3"
                            fill="none"
                            stroke={theme.accent}
                            stroke-width="1.5"
                          />
                        </svg>
                        <Show when={commit.hash}>
                          <span style={{ color: theme.fgMuted, 'flex-shrink': '0' }}>
                            {commit.hash}
                          </span>
                        </Show>
                        <span
                          style={{
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                          }}
                        >
                          {commit.msg}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </Show>
          <div
            style={{
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              overflow: 'hidden',
              'max-height': '240px',
              display: 'flex',
              'flex-direction': 'column',
            }}
          >
            <ChangedFilesList
              kind="task"
              taskId={props.task.id}
              worktreePath={props.task.worktreePath}
              isActive={props.open}
              onFileClick={props.onDiffFileClick}
            />
          </div>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'margin-top': '12px',
              cursor: 'pointer',
              color: theme.fg,
              ...typography.ui,
            }}
          >
            <input
              type="checkbox"
              checked={cleanupAfterMerge()}
              onChange={(e) => setCleanupAfterMerge(e.currentTarget.checked)}
              style={{ cursor: 'pointer' }}
            />
            Delete branch and worktree after merge
          </label>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'margin-top': '8px',
              cursor: 'pointer',
              color: theme.fg,
              ...typography.ui,
            }}
          >
            <input
              type="checkbox"
              checked={squash()}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setSquash(checked);
                if (checked && !squashMessage()) {
                  const log = branchLog() ?? '';
                  const msgOnly = log
                    .split('\n')
                    .map((l) => l.replace(/^- [a-f0-9]+ /, '- '))
                    .join('\n');
                  setSquashMessage(msgOnly);
                }
              }}
              style={{ cursor: 'pointer' }}
            />
            Squash commits
          </label>
          <Show when={squash()}>
            <textarea
              value={squashMessage()}
              onInput={(e) => setSquashMessage(e.currentTarget.value)}
              placeholder="Commit message..."
              rows={6}
              style={{
                'margin-top': '8px',
                width: '100%',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 10px',
                color: theme.fg,
                resize: 'vertical',
                outline: 'none',
                'box-sizing': 'border-box',
                ...typography.monoUi,
              }}
            />
          </Show>
          <Show when={mergeError()}>
            <div
              style={{
                'margin-top': '12px',
                color: theme.error,
                background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
                padding: '8px 12px',
                'border-radius': '8px',
                border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
                ...typography.meta,
              }}
            >
              {mergeError()}
            </div>
          </Show>
        </div>
      }
      confirmDisabled={mergeConfirmDisabled()}
      confirmLoading={merging()}
      confirmLabel={merging() ? 'Merging...' : squash() ? 'Squash Merge' : 'Merge'}
      onConfirm={() => {
        const taskId = props.task.id;
        const onDone = props.onDone;
        setMergeError('');
        setMerging(true);
        void mergeTask(taskId, {
          squash: squash(),
          message: squash() ? squashMessage() || undefined : undefined,
          cleanup: cleanupAfterMerge(),
        })
          .then(() => {
            onDone();
          })
          .catch((err) => {
            setMergeError(String(err));
          })
          .finally(() => {
            setMerging(false);
          });
      }}
      onCancel={() => {
        props.onDone();
        setMergeError('');
        setSquash(false);
        setCleanupAfterMerge(false);
        setSquashMessage('');
        setRebaseError('');
        setRebaseSuccess(false);
      }}
    />
  );
}
