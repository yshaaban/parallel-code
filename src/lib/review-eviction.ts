import type { ReviewAnnotation, ReviewQuestion } from '../app/review-session';
import type { DiffHunk, ParsedFileDiff } from './unified-diff-parser';

type ReviewItem = ReviewAnnotation | ReviewQuestion;

function hunkTouchesRange(hunk: DiffHunk, startLine: number, endLine: number): boolean {
  const hunkNewEnd = hunk.newStart + hunk.newCount - 1;

  return hunk.lines.some((line) => {
    if (line.type === 'add') {
      return line.newLine !== null && line.newLine >= startLine && line.newLine <= endLine;
    }

    if (line.type === 'remove') {
      return hunk.newStart <= endLine && hunkNewEnd >= startLine;
    }

    return false;
  });
}

function isReviewItemCurrent<T extends ReviewItem>(
  item: T,
  fileMap: ReadonlyMap<string, ParsedFileDiff>,
): boolean {
  const file = fileMap.get(item.source);
  if (!file || file.status === 'D') {
    return false;
  }

  return !file.hunks.some((hunk) => hunkTouchesRange(hunk, item.startLine, item.endLine));
}

function evictStaleReviewItems<T extends ReviewItem>(
  items: ReadonlyArray<T>,
  files: ReadonlyArray<ParsedFileDiff>,
): T[] {
  const fileMap = new Map(files.map((file) => [file.path, file]));
  return items.filter((item) => isReviewItemCurrent(item, fileMap));
}

export function evictStaleAnnotations(
  annotations: ReadonlyArray<ReviewAnnotation>,
  files: ReadonlyArray<ParsedFileDiff>,
): ReviewAnnotation[] {
  return evictStaleReviewItems(annotations, files);
}

export function evictStaleQuestions(
  questions: ReadonlyArray<ReviewQuestion>,
  files: ReadonlyArray<ParsedFileDiff>,
): ReviewQuestion[] {
  return evictStaleReviewItems(questions, files);
}
