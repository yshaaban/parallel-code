import type { GitStatusSyncSnapshotEvent } from '../../src/domain/server-state.js';

const gitStatusSnapshots = new Map<string, GitStatusSyncSnapshotEvent>();
let gitStatusVersion = 0;

function bumpGitStatusVersion(): number {
  gitStatusVersion += 1;
  return gitStatusVersion;
}

export function listGitStatusSnapshots(): GitStatusSyncSnapshotEvent[] {
  return Array.from(gitStatusSnapshots.values()).sort((left, right) =>
    (left.worktreePath ?? '').localeCompare(right.worktreePath ?? ''),
  );
}

export function getGitStatusStateVersion(): number {
  return gitStatusVersion;
}

export function recordGitStatusSnapshot(snapshot: GitStatusSyncSnapshotEvent): void {
  const current = gitStatusSnapshots.get(snapshot.worktreePath);
  if (
    current?.status.has_committed_changes === snapshot.status.has_committed_changes &&
    current?.status.has_uncommitted_changes === snapshot.status.has_uncommitted_changes &&
    current?.branchName === snapshot.branchName &&
    current?.projectRoot === snapshot.projectRoot
  ) {
    return;
  }

  gitStatusSnapshots.set(snapshot.worktreePath, snapshot);
  bumpGitStatusVersion();
}

export function removeGitStatusSnapshot(worktreePath: string): void {
  if (!gitStatusSnapshots.delete(worktreePath)) {
    return;
  }

  bumpGitStatusVersion();
}

export function clearGitStatusSnapshots(): void {
  if (gitStatusSnapshots.size === 0) {
    return;
  }

  gitStatusSnapshots.clear();
  bumpGitStatusVersion();
}
