import { createSignal } from 'solid-js';
import { arenaStore, markBranchMerged } from './store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { BattleCompetitor } from './types';

type WorktreeStatus = { hasCommitted: boolean; hasUncommitted: boolean };

/** Creates merge workflow state and handlers for the results screen */
export function createMergeWorkflow() {
  const [mergedId, setMergedId] = createSignal<string | null>(null);
  const [merging, setMerging] = createSignal(false);
  const [mergeError, setMergeError] = createSignal<string | null>(null);
  const [worktreeStatus, setWorktreeStatus] = createSignal<Record<string, WorktreeStatus>>({});
  const [commitTarget, setCommitTarget] = createSignal<BattleCompetitor | null>(null);

  function loadWorktreeStatuses(): void {
    for (const c of arenaStore.battle) {
      if (!c.worktreePath) continue;
      invoke<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }>(
        IPC.GetWorktreeStatus,
        { worktreePath: c.worktreePath },
      )
        .then((status) => {
          if (status.has_committed_changes || status.has_uncommitted_changes) {
            setWorktreeStatus((prev) => ({
              ...prev,
              [c.id]: {
                hasCommitted: status.has_committed_changes,
                hasUncommitted: status.has_uncommitted_changes,
              },
            }));
          }
        })
        .catch((e) => console.warn('Failed to get worktree status:', c.id, e));
    }
  }

  function hasChanges(id: string): boolean {
    const s = worktreeStatus()[id];
    return !!s && (s.hasCommitted || s.hasUncommitted);
  }

  function handleMergeClick(competitor: BattleCompetitor): void {
    const status = worktreeStatus()[competitor.id];
    if (status?.hasUncommitted) {
      setCommitTarget(competitor);
    } else {
      void doMerge(competitor);
    }
  }

  async function commitAndMerge(message: string): Promise<void> {
    const competitor = commitTarget();
    if (!competitor?.worktreePath) return;
    setCommitTarget(null);
    setMerging(true);
    setMergeError(null);
    try {
      await invoke(IPC.CommitAll, {
        worktreePath: competitor.worktreePath,
        message,
      });
      await doMerge(competitor);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  async function discardAndMerge(): Promise<void> {
    const competitor = commitTarget();
    if (!competitor?.worktreePath) return;
    setCommitTarget(null);
    setMerging(true);
    setMergeError(null);
    try {
      await invoke(IPC.DiscardUncommitted, { worktreePath: competitor.worktreePath });
      await doMerge(competitor);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  async function doMerge(competitor: BattleCompetitor): Promise<void> {
    if (!competitor.worktreePath || !competitor.branchName) return;
    setMerging(true);
    setMergeError(null);
    try {
      const status = await invoke<{ main_ahead_count: number; conflicting_files: string[] }>(
        IPC.CheckMergeStatus,
        { worktreePath: competitor.worktreePath },
      );
      if (status.conflicting_files.length > 0) {
        setMergeError(`Conflicts in: ${status.conflicting_files.join(', ')}`);
        return;
      }
      const promptSnippet =
        arenaStore.prompt.slice(0, 60) + (arenaStore.prompt.length > 60 ? '...' : '');
      await invoke(IPC.MergeTask, {
        projectRoot: arenaStore.cwd,
        branchName: competitor.branchName,
        squash: true,
        message: `arena: merge ${competitor.name} — ${promptSnippet}`,
        cleanup: true,
      });
      setMergedId(competitor.id);
      markBranchMerged(competitor.id);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  }

  return {
    mergedId,
    merging,
    mergeError,
    worktreeStatus,
    commitTarget,
    hasChanges,
    handleMergeClick,
    commitAndMerge,
    discardAndMerge,
    loadWorktreeStatuses,
    dismissCommitDialog: () => setCommitTarget(null),
  };
}
