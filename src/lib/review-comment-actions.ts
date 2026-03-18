export const COPY_REVIEW_COMMENTS_LABEL = 'Copy Comments';
export const PROMPT_WITH_REVIEW_COMMENTS_LABEL = 'Prompt with Comments';

const COPIED_REVIEW_COMMENTS_LABEL = 'Copied';
const FAILED_REVIEW_COMMENTS_LABEL = 'Copy failed';
const REVIEW_COMMENT_COPY_RESET_DELAY_MS = 1500;

export function resetReviewCommentCopyLabel(setLabel: (label: string) => void): void {
  setLabel(COPY_REVIEW_COMMENTS_LABEL);
}

export function copyReviewCommentsPrompt(prompt: string, setLabel: (label: string) => void): void {
  if (!prompt.trim() || !navigator.clipboard?.writeText) {
    return;
  }

  void navigator.clipboard
    .writeText(prompt)
    .then(() => {
      setLabel(COPIED_REVIEW_COMMENTS_LABEL);
      window.setTimeout(
        () => setLabel(COPY_REVIEW_COMMENTS_LABEL),
        REVIEW_COMMENT_COPY_RESET_DELAY_MS,
      );
    })
    .catch(() => {
      setLabel(FAILED_REVIEW_COMMENTS_LABEL);
      window.setTimeout(
        () => setLabel(COPY_REVIEW_COMMENTS_LABEL),
        REVIEW_COMMENT_COPY_RESET_DELAY_MS,
      );
    });
}
