import { isStringTupleMember } from '../lib/type-guards.js';

export const RAW_CHANGED_FILE_STATUSES = [
  'M',
  'A',
  'D',
  'R',
  'C',
  'T',
  'U',
  'X',
  'B',
  '?',
] as const;

export const DERIVED_CHANGED_FILE_STATUSES = [
  'modified',
  'added',
  'deleted',
  'untracked',
  'staged',
  'unstaged',
] as const;

export const CHANGED_FILE_STATUSES = [
  ...RAW_CHANGED_FILE_STATUSES,
  ...DERIVED_CHANGED_FILE_STATUSES,
] as const;

export const PARSED_DIFF_FILE_STATUSES = ['M', 'A', 'D', '?'] as const;

export type RawChangedFileStatus = (typeof RAW_CHANGED_FILE_STATUSES)[number];
export type DerivedChangedFileStatus = (typeof DERIVED_CHANGED_FILE_STATUSES)[number];
export type ChangedFileStatus = (typeof CHANGED_FILE_STATUSES)[number];
export type ParsedDiffFileStatus = (typeof PARSED_DIFF_FILE_STATUSES)[number];
export type ChangedFileStatusCategory = 'added' | 'deleted' | 'modified';

export function normalizeRawChangedFileStatus(value: string): RawChangedFileStatus {
  return isRawChangedFileStatus(value) ? value : 'M';
}

export function isRawChangedFileStatus(value: unknown): value is RawChangedFileStatus {
  return isStringTupleMember(value, RAW_CHANGED_FILE_STATUSES);
}

export function isChangedFileStatus(value: unknown): value is ChangedFileStatus {
  return isStringTupleMember(value, CHANGED_FILE_STATUSES);
}

export function getChangedFileStatusCategory(
  status: ChangedFileStatus | ParsedDiffFileStatus,
): ChangedFileStatusCategory {
  switch (status) {
    case 'A':
    case '?':
    case 'added':
    case 'untracked':
      return 'added';
    case 'D':
    case 'deleted':
      return 'deleted';
    case 'M':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
    case 'X':
    case 'B':
    case 'modified':
    case 'staged':
    case 'unstaged':
      return 'modified';
  }
}
