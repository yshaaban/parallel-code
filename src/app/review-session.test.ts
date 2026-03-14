import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReviewSession } from './review-session';

describe('createReviewSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates review annotations from the pending selection', () => {
    createRoot((dispose) => {
      const session = createReviewSession();
      session.handleSelection({
        source: 'src/example.ts',
        startLine: 4,
        endLine: 6,
        selectedText: 'const answer = 42;',
      });

      const annotationId = session.submitSelection('Rename this variable', 'review');

      expect(annotationId).toEqual(expect.any(String));
      expect(session.pendingSelection()).toBeNull();
      expect(session.sidebarOpen()).toBe(true);
      expect(session.annotations()).toMatchObject([
        {
          source: 'src/example.ts',
          startLine: 4,
          endLine: 6,
          selectedText: 'const answer = 42;',
          comment: 'Rename this variable',
        },
      ]);
      dispose();
    });
  });

  it('creates ask-about-code questions from the pending selection', () => {
    createRoot((dispose) => {
      const session = createReviewSession();
      session.handleSelection({
        source: 'src/example.ts',
        startLine: 8,
        endLine: 8,
        selectedText: 'return cache.get(key);',
        afterLine: 8,
      });

      const questionId = session.submitSelection('Why is this cached?', 'ask');

      expect(questionId).toEqual(expect.any(String));
      expect(session.pendingSelection()).toBeNull();
      expect(session.activeQuestions()).toMatchObject([
        {
          source: 'src/example.ts',
          question: 'Why is this cached?',
          startLine: 8,
          endLine: 8,
          afterLine: 8,
        },
      ]);
      dispose();
    });
  });

  it('submits current annotations and resets local state on success', async () => {
    const onSubmitReview = vi.fn().mockResolvedValue(undefined);
    const onSubmitted = vi.fn();

    await createRoot(async (dispose) => {
      const session = createReviewSession({
        onSubmitReview,
        onSubmitted,
      });
      session.handleSelection({
        source: 'src/example.ts',
        startLine: 2,
        endLine: 3,
        selectedText: 'const foo = bar();',
      });
      session.submitSelection('Use a clearer name', 'review');

      await session.submitReview();

      expect(onSubmitReview).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'src/example.ts',
            comment: 'Use a clearer name',
          }),
        ]),
      );
      expect(onSubmitted).toHaveBeenCalledTimes(1);
      expect(session.annotations()).toEqual([]);
      expect(session.sidebarOpen()).toBe(false);
      expect(session.submitError()).toBe('');
      dispose();
    });
  });

  it('surfaces a submit error when review submission fails', async () => {
    await createRoot(async (dispose) => {
      const session = createReviewSession({
        onSubmitReview: vi.fn().mockRejectedValue(new Error('Send failed')),
      });
      session.handleSelection({
        source: 'src/example.ts',
        startLine: 10,
        endLine: 10,
        selectedText: 'throw new Error();',
      });
      session.submitSelection('Use a typed error', 'review');

      await session.submitReview();

      expect(session.submitError()).toBe('Send failed');
      expect(session.annotations()).toHaveLength(1);
      dispose();
    });
  });
});
