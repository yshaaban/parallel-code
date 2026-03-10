import { describe, it, expect } from 'vitest';
import { compileReviewPrompt } from './reviewPromptCompiler';
import type { DiffComment } from '../store/types';

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    taskId: 't1',
    agentId: 'a1',
    anchor: {
      filePath: 'src/foo.ts',
      hunkKey: 'hunk-0',
      side: 'new',
      startLine: 42,
      endLine: 42,
      diffKind: 'add',
    },
    text: 'Fix the naming here',
    status: 'draft',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('compileReviewPrompt', () => {
  it('returns empty string for no comments', () => {
    expect(compileReviewPrompt([])).toBe('');
  });

  it('returns empty string when all comments are sent', () => {
    expect(compileReviewPrompt([makeComment({ status: 'sent' })])).toBe('');
  });

  it('compiles a single comment', () => {
    const result = compileReviewPrompt([makeComment()]);
    expect(result).toBe(
      'Please make these changes to the code:\n- In `src/foo.ts` line 42: Fix the naming here',
    );
  });

  it('compiles multi-line range comment', () => {
    const comment = makeComment({
      anchor: {
        filePath: 'src/bar.ts',
        hunkKey: 'hunk-0',
        side: 'new',
        startLine: 10,
        endLine: 15,
        diffKind: 'add',
      },
      text: 'Refactor this block',
    });
    const result = compileReviewPrompt([comment]);
    expect(result).toContain('lines 10-15');
  });

  it('sorts comments by file then line', () => {
    const comments = [
      makeComment({
        id: 'c2',
        anchor: {
          filePath: 'src/z.ts',
          hunkKey: 'h0',
          side: 'new',
          startLine: 1,
          endLine: 1,
          diffKind: 'add',
        },
        text: 'second file',
      }),
      makeComment({
        id: 'c3',
        anchor: {
          filePath: 'src/a.ts',
          hunkKey: 'h0',
          side: 'new',
          startLine: 20,
          endLine: 20,
          diffKind: 'add',
        },
        text: 'later line',
      }),
      makeComment({
        id: 'c1',
        anchor: {
          filePath: 'src/a.ts',
          hunkKey: 'h0',
          side: 'new',
          startLine: 5,
          endLine: 5,
          diffKind: 'add',
        },
        text: 'earlier line',
      }),
    ];
    const result = compileReviewPrompt(comments);
    const lines = result.split('\n').slice(1); // skip header
    expect(lines[0]).toContain('src/a.ts');
    expect(lines[0]).toContain('line 5');
    expect(lines[1]).toContain('src/a.ts');
    expect(lines[1]).toContain('line 20');
    expect(lines[2]).toContain('src/z.ts');
  });

  it('filters out non-draft comments', () => {
    const comments = [
      makeComment({ id: 'c1', status: 'draft', text: 'included' }),
      makeComment({ id: 'c2', status: 'sent', text: 'excluded' }),
      makeComment({ id: 'c3', status: 'stale', text: 'also excluded' }),
    ];
    const result = compileReviewPrompt(comments);
    expect(result).toContain('included');
    expect(result).not.toContain('excluded');
    expect(result).not.toContain('also excluded');
  });
});
