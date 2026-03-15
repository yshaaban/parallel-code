import { describe, expect, it } from 'vitest';

import {
  getChangedFileStatusCategory,
  isChangedFileStatus,
  normalizeRawChangedFileStatus,
} from './git-status';

describe('git status domain helpers', () => {
  it('normalizes unsupported raw statuses to modified', () => {
    expect(normalizeRawChangedFileStatus('A')).toBe('A');
    expect(normalizeRawChangedFileStatus('R')).toBe('R');
    expect(normalizeRawChangedFileStatus('unsupported')).toBe('M');
  });

  it('recognizes the shared changed-file status domain', () => {
    expect(isChangedFileStatus('staged')).toBe(true);
    expect(isChangedFileStatus('?')).toBe(true);
    expect(isChangedFileStatus('renamed')).toBe(false);
  });

  it('categorizes raw and derived statuses consistently', () => {
    expect(getChangedFileStatusCategory('A')).toBe('added');
    expect(getChangedFileStatusCategory('?')).toBe('added');
    expect(getChangedFileStatusCategory('deleted')).toBe('deleted');
    expect(getChangedFileStatusCategory('R')).toBe('modified');
    expect(getChangedFileStatusCategory('unstaged')).toBe('modified');
  });
});
