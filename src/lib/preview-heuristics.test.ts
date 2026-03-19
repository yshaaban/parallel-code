import { describe, expect, it } from 'vitest';

import {
  getRecentVisibleLines,
  isMeaningfulPreviewLine,
  truncatePreview,
} from './preview-heuristics';

describe('preview heuristics', () => {
  it('truncates preview text with the shared helper', () => {
    expect(truncatePreview('abcdef', 4)).toBe('abc…');
    expect(truncatePreview('abc', 4)).toBe('abc');
  });

  it('normalizes and keeps recent visible lines', () => {
    const lines = getRecentVisibleLines('  first \n\nsecond\nthird  ', (line) => line.trim());

    expect(lines).toEqual(['first', 'second', 'third']);
  });

  it('detects meaningful preview lines with optional keyword shortcuts', () => {
    expect(isMeaningfulPreviewLine('   ')).toBe(false);
    expect(isMeaningfulPreviewLine('Use arrow keys', { keywordPattern: /use arrow keys/i })).toBe(
      true,
    );
    expect(isMeaningfulPreviewLine('ready for next input')).toBe(true);
  });
});
