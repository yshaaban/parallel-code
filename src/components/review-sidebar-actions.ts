import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

import type { ReviewAnnotation, ReviewSession } from '../app/review-session';
import {
  copyReviewCommentsPrompt,
  COPY_REVIEW_COMMENTS_LABEL,
  PROMPT_WITH_REVIEW_COMMENTS_LABEL,
  resetReviewCommentCopyLabel,
} from '../lib/review-comment-actions';
import type { ReviewSidebarProps } from './ReviewSidebar';

interface CreateReviewCommentCopyControllerOptions {
  compilePrompt: (annotations: ReadonlyArray<ReviewAnnotation>) => string;
  reviewSession: ReviewSession;
}

interface CreateReviewSidebarPropsOptions {
  copyActionLabel: Accessor<string>;
  onCopy: () => void;
  onScrollTo: (annotation: ReviewAnnotation) => void;
  reviewSession: ReviewSession;
}

export interface ReviewCommentCopyController {
  copyActionLabel: Accessor<string>;
  copyComments: () => void;
  resetCopyActionLabel: () => void;
}

export function createReviewCommentCopyController(
  options: CreateReviewCommentCopyControllerOptions,
): ReviewCommentCopyController {
  const [copyActionLabel, setCopyActionLabel] = createSignal(COPY_REVIEW_COMMENTS_LABEL);

  createEffect(() => {
    if (options.reviewSession.annotations().length === 0) {
      resetReviewCommentCopyLabel(setCopyActionLabel);
    }
  });

  function copyComments(): void {
    const prompt = options.compilePrompt(options.reviewSession.annotations());
    copyReviewCommentsPrompt(prompt, setCopyActionLabel);
  }

  function resetCopyActionLabel(): void {
    resetReviewCommentCopyLabel(setCopyActionLabel);
  }

  return {
    copyActionLabel,
    copyComments,
    resetCopyActionLabel,
  };
}

export function createReviewSidebarProps(
  options: CreateReviewSidebarPropsOptions,
): Accessor<ReviewSidebarProps> {
  const reviewSidebarProps = createMemo(() => ({
    annotations: options.reviewSession.annotations(),
    canSubmit: options.reviewSession.canSubmit(),
    copyActionLabel: options.copyActionLabel(),
    onCopy: options.onCopy,
    onDismiss: options.reviewSession.dismissAnnotation,
    onScrollTo: options.onScrollTo,
    onSubmit() {
      void options.reviewSession.submitReview();
    },
    submitActionLabel: PROMPT_WITH_REVIEW_COMMENTS_LABEL,
    submitError: options.reviewSession.submitError(),
  }));

  return reviewSidebarProps;
}
