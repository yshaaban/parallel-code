export function toBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/--+/g, '-');
}

export function sanitizeBranchPrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = normalized
    .split('/')
    .map((segment) => toBranchName(segment))
    .filter((segment) => segment.length > 0);
  return parts.join('/') || 'task';
}

export interface BranchRefPrefixConflict {
  conflictingBranch: string;
  proposedBranch: string;
  type: 'existing-is-prefix' | 'proposed-is-prefix';
}

export function findBranchRefPrefixConflict(
  proposedBranch: string,
  existingBranches: readonly string[],
): BranchRefPrefixConflict | null {
  const proposed = proposedBranch.trim();
  if (!proposed) {
    return null;
  }

  for (const existingBranch of existingBranches) {
    const existing = existingBranch.trim();
    if (!existing || existing === proposed) {
      continue;
    }

    if (proposed.startsWith(`${existing}/`)) {
      return {
        conflictingBranch: existing,
        proposedBranch: proposed,
        type: 'existing-is-prefix',
      };
    }

    if (existing.startsWith(`${proposed}/`)) {
      return {
        conflictingBranch: existing,
        proposedBranch: proposed,
        type: 'proposed-is-prefix',
      };
    }
  }

  return null;
}

export function formatBranchRefPrefixConflict(conflict: BranchRefPrefixConflict): string {
  if (conflict.type === 'existing-is-prefix') {
    return `Cannot create branch "${conflict.proposedBranch}" because local branch "${conflict.conflictingBranch}" already uses that ref path. Choose a different branch prefix.`;
  }

  return `Cannot create branch "${conflict.proposedBranch}" because it would block existing local branch "${conflict.conflictingBranch}". Choose a more specific branch prefix.`;
}
