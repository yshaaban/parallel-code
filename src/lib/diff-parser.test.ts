import { describe, it, expect } from 'vitest';
import { isBinaryDiff, parseUnifiedDiff } from './diff-parser';

describe('isBinaryDiff', () => {
  it('detects binary diff output', () => {
    expect(isBinaryDiff('Binary files a/img.png and b/img.png differ')).toBe(true);
    expect(isBinaryDiff('GIT binary patch')).toBe(true);
  });

  it('returns false for text diff', () => {
    expect(isBinaryDiff('@@ -1,3 +1,4 @@\n foo\n+bar')).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  it('returns empty array for empty string', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('parses a simple add-only diff', () => {
    const diff = ['@@ -1,3 +1,4 @@', ' line1', ' line2', '+newline', ' line3'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldCount).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(4);
    expect(hunks[0].lines).toHaveLength(4);
    expect(hunks[0].lines[2].kind).toBe('add');
    expect(hunks[0].lines[2].text).toBe('newline');
    expect(hunks[0].lines[2].newLineNumber).toBe(3);
  });

  it('parses a diff with adds, deletes, and context', () => {
    const diff = ['@@ -5,4 +5,4 @@', ' context', '-old line', '+new line', ' more context'].join(
      '\n',
    );

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(4);

    const ctx1 = hunks[0].lines[0];
    expect(ctx1.kind).toBe('context');
    expect(ctx1.oldLineNumber).toBe(5);
    expect(ctx1.newLineNumber).toBe(5);

    const del = hunks[0].lines[1];
    expect(del.kind).toBe('delete');
    expect(del.oldLineNumber).toBe(6);
    expect(del.newLineNumber).toBeUndefined();

    const add = hunks[0].lines[2];
    expect(add.kind).toBe('add');
    expect(add.newLineNumber).toBe(6);
    expect(add.oldLineNumber).toBeUndefined();

    const ctx2 = hunks[0].lines[3];
    expect(ctx2.kind).toBe('context');
    expect(ctx2.oldLineNumber).toBe(7);
    expect(ctx2.newLineNumber).toBe(7);
  });

  it('parses multiple hunks', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-old1',
      '+new1',
      ' same',
      '@@ -10,2 +10,3 @@',
      ' ctx',
      '+added',
      ' ctx2',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].lines).toHaveLength(3);
    expect(hunks[1].oldStart).toBe(10);
    expect(hunks[1].lines).toHaveLength(3);
  });

  it('assigns correct line numbers across a hunk', () => {
    const diff = ['@@ -10,4 +10,5 @@', ' ctx', '-removed', '+added1', '+added2', ' ctx2'].join(
      '\n',
    );

    const hunks = parseUnifiedDiff(diff);
    const lines = hunks[0].lines;

    expect(lines[0]).toMatchObject({ kind: 'context', oldLineNumber: 10, newLineNumber: 10 });
    expect(lines[1]).toMatchObject({ kind: 'delete', oldLineNumber: 11 });
    expect(lines[2]).toMatchObject({ kind: 'add', newLineNumber: 11 });
    expect(lines[3]).toMatchObject({ kind: 'add', newLineNumber: 12 });
    expect(lines[4]).toMatchObject({ kind: 'context', oldLineNumber: 12, newLineNumber: 13 });
  });

  it('handles diff with file headers', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index abc..def 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' existing',
      '+new',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(2);
  });

  it('handles hunk with single line count (no comma)', () => {
    const diff = '@@ -1 +1,2 @@\n existing\n+new';
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldCount).toBe(1);
    expect(hunks[0].newCount).toBe(2);
  });

  it('skips "No newline at end of file" markers', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0].lines).toHaveLength(2);
    expect(hunks[0].lines[0].kind).toBe('delete');
    expect(hunks[0].lines[1].kind).toBe('add');
  });
});
