import {
  Show,
  For,
  createSignal,
  createResource,
  createEffect,
  onCleanup,
  type JSX,
} from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  isTaskCommandLeaseSkipped,
  runWithTaskCommandLease,
} from '../app/task-command-lease-session';
import { mergeTask, sendPrompt } from '../app/task-workflows';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { getProject } from '../store/projects';
import {
  getTaskGitStatus,
  isTaskGitStatusFresh,
  refreshTaskGitStatusForTask,
} from '../store/task-git-status';
import { store } from '../store/state';
import { getSelectedTaskAgentId } from '../store/task-agent-selection';
import { normalizeTaskBaseBranch } from '../store/task-git-isolation';
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

type RebaseButtonTone = 'primary' | 'secondary';

interface MergeDialogGitRequest {
  baseBranch?: string;
  worktreePath: string;
}

function getBaseBranchRequest(baseBranch: string | undefined): { baseBranch?: string } {
  return baseBranch !== undefined ? { baseBranch } : {};
}

function getRebaseButtonStyle(tone: RebaseButtonTone, disabled = false): JSX.CSSProperties {
  const primary = tone === 'primary';
  return {
    padding: '6px 14px',
    background: primary ? theme.accent : theme.bgInput,
    border: primary ? 'none' : `1px solid ${theme.border}`,
    'border-radius': '8px',
    color: primary ? theme.accentText : theme.fg,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? '0.5' : '1',
    ...(primary ? typography.metaStrong : typography.meta),
  };
}

function getSquashMessageTemplate(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(/^- [a-f0-9]+ /, '- '))
    .join('\n');
}

export function MergeDialog(props: MergeDialogProps): JSX.Element {
  const [mergeError, setMergeError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal('');
  const [shouldPopulateSquashMessage, setShouldPopulateSquashMessage] = createSignal(false);
  const [rebasing, setRebasing] = createSignal(false);
  const [rebaseError, setRebaseError] = createSignal('');
  const [rebaseSuccess, setRebaseSuccess] = createSignal(false);
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false);
  const [gitStatusReady, setGitStatusReady] = createSignal(false);
  let gitStatusRefreshGeneration = 0;
  let rebaseGeneration = 0;
  let mergeGeneration = 0;
  const mergeBaseBranch = (): string | undefined =>
    normalizeTaskBaseBranch(props.task) ?? getProject(props.task.projectId)?.baseBranch;
  const gitRequest = (): MergeDialogGitRequest | null => {
    if (!props.open) {
      return null;
    }

    return {
      ...getBaseBranchRequest(mergeBaseBranch()),
      worktreePath: props.task.worktreePath,
    };
  };

  const [branchLog, { refetch: refetchBranchLog }] = createResource(gitRequest, (request) =>
    invoke(IPC.GetBranchLog, {
      ...getBaseBranchRequest(request.baseBranch),
      worktreePath: request.worktreePath,
    }),
  );
  const [mergeStatus, { refetch: refetchMergeStatus }] = createResource(gitRequest, (request) =>
    invoke(IPC.CheckMergeStatus, {
      ...getBaseBranchRequest(request.baseBranch),
      worktreePath: request.worktreePath,
    }),
  );

  const worktreeStatus = () => getTaskGitStatus(props.task.id);
  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  const selectedAiAgentId = (): string | null => getSelectedTaskAgentId(props.task);
  const aiRebaseAgentId = (): string | null => {
    const agentId = selectedAiAgentId();
    if (!agentId || store.agents[agentId]?.status === 'exited') {
      return null;
    }

    return agentId;
  };
  const hasBranchMismatch = () => {
    const status = mergeStatus();
    if (!status) {
      return false;
    }

    const currentBranch = status.current_branch;
    return currentBranch === null || currentBranch !== props.task.branchName;
  };
  const currentBranchLabel = () => mergeStatus()?.current_branch ?? 'detached HEAD';
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;
  const hasUncommittedChanges = () => worktreeStatus()?.has_uncommitted_changes ?? false;
  const mergeTargetLabel = () => mergeBaseBranch() ?? 'base branch';
  const rebasePrompt = () => `rebase on ${mergeTargetLabel()}`;
  const isGitStatusVerified = () =>
    !gitStatusLoading() && gitStatusReady() && isTaskGitStatusFresh(worktreeStatus());
  const gitStatusUnavailable = () =>
    !gitStatusLoading() && (!gitStatusReady() || !isTaskGitStatusFresh(worktreeStatus()));
  const gitStatusErrorMessage = () => worktreeStatus()?.errorMessage ?? '';

  function getRebaseBlockedReason(): string | null {
    if (!isGitStatusVerified()) {
      return 'Checking worktree status...';
    }

    if (hasBranchMismatch()) {
      return 'Refresh the task branch before rebasing';
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
    hasBranchMismatch() ||
    hasConflicts() ||
    !hasCommittedChangesToMerge();
  const plainRebaseIsPrimary = () => !hasConflicts();
  const plainRebaseButtonTone = (): RebaseButtonTone =>
    plainRebaseIsPrimary() ? 'primary' : 'secondary';
  const aiRebaseButtonTone = (): RebaseButtonTone =>
    plainRebaseIsPrimary() ? 'secondary' : 'primary';

  onCleanup(() => {
    invalidateGitStatusRefresh();
    invalidateRebaseRun();
    invalidateMergeRun();
  });

  function nextGitStatusRefreshGeneration(): number {
    gitStatusRefreshGeneration += 1;
    return gitStatusRefreshGeneration;
  }

  function invalidateGitStatusRefresh(): void {
    gitStatusRefreshGeneration += 1;
  }

  function nextRebaseGeneration(): number {
    rebaseGeneration += 1;
    return rebaseGeneration;
  }

  function invalidateRebaseRun(): void {
    rebaseGeneration += 1;
  }

  function nextMergeGeneration(): number {
    mergeGeneration += 1;
    return mergeGeneration;
  }

  function invalidateMergeRun(): void {
    mergeGeneration += 1;
  }

  function resetGitStatusValidation(): void {
    setGitStatusReady(false);
    setGitStatusLoading(false);
  }

  function populateSquashMessage(log: string): void {
    setSquashMessage(getSquashMessageTemplate(log));
    setShouldPopulateSquashMessage(false);
  }

  function handleSquashChange(checked: boolean): void {
    setSquash(checked);

    if (!checked || squashMessage()) {
      setShouldPopulateSquashMessage(false);
      return;
    }

    const log = branchLog();
    if (log === undefined) {
      setShouldPopulateSquashMessage(true);
      return;
    }

    populateSquashMessage(log);
  }

  function handleSquashMessageInput(message: string): void {
    setShouldPopulateSquashMessage(false);
    setSquashMessage(message);
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

  function rebaseTaskFromDialog(): void {
    const generation = nextRebaseGeneration();
    const taskId = props.task.id;
    const worktreePath = props.task.worktreePath;
    const baseBranch = mergeBaseBranch();
    setRebasing(true);
    setRebaseError('');
    setRebaseSuccess(false);

    void runWithTaskCommandLease(taskId, 'rebase this task', () =>
      invoke(IPC.RebaseTask, {
        controllerId: getRuntimeClientId(),
        taskId,
        worktreePath,
        ...getBaseBranchRequest(baseBranch),
      }),
    )
      .then((result) => {
        if (generation !== rebaseGeneration || isTaskCommandLeaseSkipped(result)) {
          return;
        }

        setRebaseSuccess(true);
        refetchMergeStatus();
        refetchBranchLog();
        refreshDialogGitStatus(taskId);
      })
      .catch((err) => {
        if (generation !== rebaseGeneration) {
          return;
        }

        setRebaseError(String(err));
      })
      .finally(() => {
        if (generation !== rebaseGeneration) {
          return;
        }

        setRebasing(false);
      });
  }

  createEffect(() => {
    const taskId = props.task.id;
    if (!props.open) {
      invalidateGitStatusRefresh();
      invalidateRebaseRun();
      invalidateMergeRun();
      resetGitStatusValidation();
      setMerging(false);
      setRebasing(false);
      return;
    }

    invalidateRebaseRun();
    invalidateMergeRun();
    setCleanupAfterMerge(props.initialCleanup);
    setSquash(false);
    setSquashMessage('');
    setShouldPopulateSquashMessage(false);
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
    refreshDialogGitStatus(taskId);
  });

  createEffect(() => {
    if (!shouldPopulateSquashMessage()) {
      return;
    }

    if (!squash() || squashMessage()) {
      setShouldPopulateSquashMessage(false);
      return;
    }

    const log = branchLog();
    if (log !== undefined) {
      populateSquashMessage(log);
    }
  });

  function mergeConfirmLabel(): string {
    if (merging()) {
      return 'Merging...';
    }

    if (cleanupAfterMerge()) {
      return squash() ? 'Squash & delete branch' : 'Merge & delete branch';
    }

    return squash() ? 'Squash Merge' : 'Merge';
  }

  return (
    <ConfirmDialog
      open={props.open}
      title={`Merge into ${mergeTargetLabel()}`}
      width="520px"
      danger={cleanupAfterMerge()}
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
              <Show when={gitStatusErrorMessage()}> Details: {gitStatusErrorMessage()}</Show>
            </InlineNotice>
          </Show>
          <Show when={mergeStatus.loading}>
            <InlineNotice style={{ 'margin-bottom': '12px' }}>
              Checking for conflicts with {mergeTargetLabel()}...
            </InlineNotice>
          </Show>
          <Show when={!mergeStatus.loading && mergeStatus()}>
            {(status) => (
              <>
                <Show when={hasBranchMismatch()}>
                  <InlineNotice style={{ 'margin-bottom': '12px' }} tone="error" weight="semibold">
                    Task worktree is on {currentBranchLabel()}, expected {props.task.branchName}.
                    Refresh the task branch before merging.
                  </InlineNotice>
                </Show>
                <Show when={!hasBranchMismatch() && status().main_ahead_count > 0}>
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
                      <ul
                        style={{ margin: '4px 0 0', 'padding-left': '20px', 'font-weight': '400' }}
                      >
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
                      onClick={rebaseTaskFromDialog}
                      title={rebaseBlockedReason() ?? `Rebase onto ${mergeTargetLabel()}`}
                      style={getRebaseButtonStyle(plainRebaseButtonTone(), rebaseDisabled())}
                    >
                      {rebasing() ? 'Rebasing...' : `Rebase onto ${mergeTargetLabel()}`}
                    </button>
                    <Show when={aiRebaseAgentId()} keyed>
                      {(agentId) => (
                        <button
                          type="button"
                          onClick={() => {
                            props.onDone();
                            sendPrompt(props.task.id, agentId, rebasePrompt()).catch((err) => {
                              console.error('Failed to send rebase prompt:', err);
                            });
                          }}
                          title="Close dialog and ask the AI agent to rebase"
                          style={getRebaseButtonStyle(aiRebaseButtonTone())}
                        >
                          Rebase with AI
                        </button>
                      )}
                    </Show>
                    <Show when={rebaseSuccess()}>
                      <span style={{ color: theme.success, ...typography.meta }}>
                        Rebase successful
                      </span>
                    </Show>
                    <Show when={rebaseError()}>
                      <span style={{ color: theme.error, ...typography.meta }}>
                        {rebaseError()}
                      </span>
                    </Show>
                  </div>
                </Show>
              </>
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
              onChange={(e) => handleSquashChange(e.currentTarget.checked)}
              style={{ cursor: 'pointer' }}
            />
            Squash commits
          </label>
          <Show when={squash()}>
            <textarea
              value={squashMessage()}
              onInput={(e) => handleSquashMessageInput(e.currentTarget.value)}
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
      confirmLabel={mergeConfirmLabel()}
      onConfirm={() => {
        const generation = nextMergeGeneration();
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
            if (generation !== mergeGeneration) {
              return;
            }

            onDone();
          })
          .catch((err) => {
            if (generation !== mergeGeneration) {
              return;
            }

            setMergeError(String(err));
          })
          .finally(() => {
            if (generation !== mergeGeneration) {
              return;
            }

            setMerging(false);
          });
      }}
      onCancel={() => {
        props.onDone();
        setMergeError('');
        setSquash(false);
        setCleanupAfterMerge(false);
        setSquashMessage('');
        setShouldPopulateSquashMessage(false);
        setRebaseError('');
        setRebaseSuccess(false);
      }}
    />
  );
}
