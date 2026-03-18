import { describe, expect, it } from 'vitest';

import {
  buildAskAboutCodePrompt,
  compileDiffReviewPrompt,
  compilePlanReviewPrompt,
} from './review-prompts';

describe('review prompts', () => {
  it('builds an ask-about-code prompt with line context and fenced code', () => {
    expect(
      buildAskAboutCodePrompt(
        'src/example.ts',
        4,
        6,
        'const answer = 42;',
        'Why is this variable named answer?',
      ),
    ).toContain('In src/example.ts, lines 4-6:');
  });

  it('compiles diff review annotations into a deterministic prompt', () => {
    expect(
      compileDiffReviewPrompt([
        {
          id: 'annotation-1',
          source: 'src/example.ts',
          lineBeginning: 'const answer = 42;',
          startLine: 4,
          endLine: 6,
          selectedText: 'answer = 42',
          comment: 'Use a more specific name.',
        },
      ]),
    ).toBe(
      [
        'Please address these file review comments:',
        '',
        '- src/example.ts | lines 4-6 | begins with: const answer = 42;',
        '  Comment: Use a more specific name.',
      ].join('\n'),
    );
  });

  it('compiles plan review annotations with quoted plan excerpts', () => {
    expect(
      compilePlanReviewPrompt([
        {
          id: 'annotation-1',
          source: 'plan.md § Bootstrap',
          startLine: 1,
          endLine: 2,
          selectedText: 'Start the worker before restore.',
          comment: 'Define the failure behavior explicitly.',
        },
      ]),
    ).toContain('Feedback on the implementation plan:');
  });
});
