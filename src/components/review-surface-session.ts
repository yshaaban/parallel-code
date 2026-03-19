import type { Accessor } from 'solid-js';

import { createTaskReviewSession } from '../app/task-review-session';
import type { ReviewAnnotation, ReviewSession } from '../app/review-session';
import {
  createReviewCommentCopyController,
  createReviewSidebarProps,
  type ReviewCommentCopyController,
} from './review-sidebar-actions';
import type { ReviewSidebarProps } from './ReviewSidebar';

interface CreateReviewSurfaceSessionOptions {
  compilePrompt: (annotations: ReadonlyArray<ReviewAnnotation>) => string;
  getAgentId: () => string | undefined;
  getTaskId: () => string | undefined;
  onScrollTo?: (annotation: ReviewAnnotation) => void;
  onSubmitted?: () => void;
}

interface ReviewSurfaceSession {
  reviewCommentCopyController: ReviewCommentCopyController;
  reviewSidebarProps: Accessor<ReviewSidebarProps>;
  reviewSession: ReviewSession;
}

export function createReviewSurfaceSession(
  options: CreateReviewSurfaceSessionOptions,
): ReviewSurfaceSession {
  const reviewSession = createTaskReviewSession({
    compilePrompt: options.compilePrompt,
    getAgentId: options.getAgentId,
    getTaskId: options.getTaskId,
    ...(options.onSubmitted ? { onSubmitted: options.onSubmitted } : {}),
  });
  const reviewCommentCopyController = createReviewCommentCopyController({
    compilePrompt: options.compilePrompt,
    reviewSession,
  });
  const onScrollTo = options.onScrollTo ?? reviewSession.setScrollTarget;
  const reviewSidebarProps = createReviewSidebarProps({
    copyActionLabel: reviewCommentCopyController.copyActionLabel,
    onCopy: reviewCommentCopyController.copyComments,
    onScrollTo,
    reviewSession,
  });

  return {
    reviewCommentCopyController,
    reviewSession,
    reviewSidebarProps,
  };
}
