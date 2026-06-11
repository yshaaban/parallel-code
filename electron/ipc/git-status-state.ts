import type { GitStatusSyncSnapshotEvent } from '../../src/domain/server-state.js';

type GitStatusSnapshotsListener = () => void;

const gitStatusSnapshots = new Map<string, GitStatusSyncSnapshotEvent>();
const gitStatusSnapshotsListeners = new Set<GitStatusSnapshotsListener>();
let gitStatusVersion = 0;

function bumpGitStatusVersion(): number {
  gitStatusVersion += 1;
  return gitStatusVersion;
}

function notifyGitStatusSnapshotsChanged(): void {
  for (const listener of gitStatusSnapshotsListeners) {
    listener();
  }
}

export function subscribeGitStatusSnapshots(listener: GitStatusSnapshotsListener): () => void {
  gitStatusSnapshotsListeners.add(listener);
  return () => {
    gitStatusSnapshotsListeners.delete(listener);
  };
}

export function listGitStatusSnapshots(): GitStatusSyncSnapshotEvent[] {
  return Array.from(gitStatusSnapshots.values()).sort((left, right) =>
    (left.worktreePath ?? '').localeCompare(right.worktreePath ?? ''),
  );
}

export function getGitStatusStateVersion(): number {
  return gitStatusVersion;
}

export function hydrateGitStatusSnapshots(
  snapshots: ReadonlyArray<GitStatusSyncSnapshotEvent>,
): void {
  if (snapshots.length === 0) {
    return;
  }

  for (const snapshot of snapshots) {
    gitStatusSnapshots.set(snapshot.worktreePath, snapshot);
  }
  bumpGitStatusVersion();
  notifyGitStatusSnapshotsChanged();
}

export function recordGitStatusSnapshot(snapshot: GitStatusSyncSnapshotEvent): number {
  const current = gitStatusSnapshots.get(snapshot.worktreePath);
  if (
    current?.status.has_committed_changes === snapshot.status.has_committed_changes &&
    current?.status.has_uncommitted_changes === snapshot.status.has_uncommitted_changes &&
    current?.branchName === snapshot.branchName &&
    current?.projectRoot === snapshot.projectRoot
  ) {
    return gitStatusVersion;
  }

  gitStatusSnapshots.set(snapshot.worktreePath, snapshot);
  const version = bumpGitStatusVersion();
  notifyGitStatusSnapshotsChanged();
  return version;
}

export function removeGitStatusSnapshot(worktreePath: string): void {
  if (!gitStatusSnapshots.delete(worktreePath)) {
    return;
  }

  bumpGitStatusVersion();
  notifyGitStatusSnapshotsChanged();
}

export function clearGitStatusSnapshots(): void {
  if (gitStatusSnapshots.size === 0) {
    return;
  }

  gitStatusSnapshots.clear();
  bumpGitStatusVersion();
  notifyGitStatusSnapshotsChanged();
}
