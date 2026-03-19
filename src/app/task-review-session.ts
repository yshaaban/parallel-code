import { createReviewSession, type ReviewAnnotation, type ReviewSession } from './review-session';
import { submitReviewAnnotations } from './task-ai-workflows';

interface CreateTaskReviewSessionOptions {
  getAgentId: () => string | undefined;
  compilePrompt: (annotations: ReadonlyArray<ReviewAnnotation>) => string;
  getTaskId: () => string | undefined;
  onSubmitted?: () => void;
}

export function createTaskReviewSession(options: CreateTaskReviewSessionOptions): ReviewSession {
  return createReviewSession({
    canSubmit: () => Boolean(options.getTaskId() && options.getAgentId()),
    onSubmitReview: (annotations) => {
      const taskId = options.getTaskId();
      const agentId = options.getAgentId();
      if (!taskId || !agentId) {
        throw new Error('No agent available to receive review');
      }

      return submitReviewAnnotations(taskId, agentId, annotations, options.compilePrompt);
    },
    ...(options.onSubmitted ? { onSubmitted: options.onSubmitted } : {}),
  });
}
