import { describe, expect, it } from 'vitest';

import {
  findBranchRefPrefixConflict,
  formatBranchRefPrefixConflict,
  sanitizeBranchPrefix,
  toBranchName,
} from './branch-name';

describe('branch-name', () => {
  it('converts task names to branch slugs', () => {
    expect(toBranchName('Add OAuth Login!')).toBe('add-oauth-login');
  });

  it('sanitizes branch prefixes while preserving slash hierarchy', () => {
    expect(sanitizeBranchPrefix(' Feature\\Auth // UI ')).toBe('feature/auth/ui');
  });

  it('finds conflicts when an existing branch is a proposed branch prefix', () => {
    expect(findBranchRefPrefixConflict('feature/auth', ['main', 'feature'])).toEqual({
      conflictingBranch: 'feature',
      proposedBranch: 'feature/auth',
      type: 'existing-is-prefix',
    });
  });

  it('finds conflicts when a proposed branch would become a prefix of an existing branch', () => {
    expect(findBranchRefPrefixConflict('feature', ['feature/auth', 'main'])).toEqual({
      conflictingBranch: 'feature/auth',
      proposedBranch: 'feature',
      type: 'proposed-is-prefix',
    });
  });

  it('ignores exact matches so task branch allocation can retry with a suffix', () => {
    expect(findBranchRefPrefixConflict('task/auth', ['task/auth'])).toBeNull();
  });

  it('allows sibling branch names under the same prefix', () => {
    expect(findBranchRefPrefixConflict('feature/billing', ['feature/auth'])).toBeNull();
  });

  it('formats an actionable conflict message', () => {
    const conflict = findBranchRefPrefixConflict('feature/auth', ['feature']);

    expect(conflict).not.toBeNull();
    if (!conflict) {
      throw new Error('Expected a branch-ref prefix conflict');
    }
    expect(formatBranchRefPrefixConflict(conflict)).toContain('Choose a different branch prefix');
  });
});
