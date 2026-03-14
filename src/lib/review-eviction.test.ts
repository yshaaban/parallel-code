import { describe, expect, it } from 'vitest';

import { evictStaleAnnotations, evictStaleQuestions } from './review-eviction';

describe('review eviction', () => {
  const files = [
    {
      path: 'src/example.ts',
      status: 'M' as const,
      binary: false,
      hunks: [
        {
          oldStart: 3,
          oldCount: 1,
          newStart: 3,
          newCount: 2,
          lines: [
            { type: 'remove' as const, content: 'old line', oldLine: 3, newLine: null },
            { type: 'add' as const, content: 'new line', oldLine: null, newLine: 3 },
          ],
        },
      ],
    },
  ];

  it('evicts annotations that point at modified ranges', () => {
    expect(
      evictStaleAnnotations(
        [
          {
            id: 'stale',
            source: 'src/example.ts',
            startLine: 3,
            endLine: 3,
            selectedText: 'old line',
            comment: 'Update this.',
          },
          {
            id: 'keep',
            source: 'src/example.ts',
            startLine: 10,
            endLine: 10,
            selectedText: 'stable line',
            comment: 'Keep this.',
          },
        ],
        files,
      ).map((annotation) => annotation.id),
    ).toEqual(['keep']);
  });

  it('evicts questions that point at modified ranges', () => {
    expect(
      evictStaleQuestions(
        [
          {
            id: 'stale',
            source: 'src/example.ts',
            afterLine: 3,
            question: 'Why was this changed?',
            startLine: 3,
            endLine: 3,
            selectedText: 'old line',
          },
          {
            id: 'keep',
            source: 'src/example.ts',
            afterLine: 12,
            question: 'Is this cached?',
            startLine: 12,
            endLine: 12,
            selectedText: 'stable line',
          },
        ],
        files,
      ).map((question) => question.id),
    ).toEqual(['keep']);
  });

  it('evicts items when their file disappears from the refreshed diff', () => {
    expect(
      evictStaleAnnotations(
        [
          {
            id: 'gone',
            source: 'src/missing.ts',
            startLine: 2,
            endLine: 2,
            selectedText: 'stale line',
            comment: 'This file is no longer part of the diff.',
          },
        ],
        files,
      ),
    ).toEqual([]);

    expect(
      evictStaleQuestions(
        [
          {
            id: 'gone-question',
            source: 'src/missing.ts',
            afterLine: 2,
            question: 'Why did this disappear?',
            startLine: 2,
            endLine: 2,
            selectedText: 'stale line',
          },
        ],
        files,
      ),
    ).toEqual([]);
  });
});
