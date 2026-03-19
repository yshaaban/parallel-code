import {
  getTaskReviewStateBadgeLabel,
  getTaskReviewStateBadgeTone,
  getTaskReviewStatePanelTone,
  type TaskReviewState,
  type TaskReviewTone,
} from '../domain/task-convergence';
import { theme } from '../lib/theme';

function getTaskReviewToneColor(tone: TaskReviewTone): string {
  switch (tone) {
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'accent':
      return theme.accent;
    case 'muted':
      return theme.fgMuted;
    case 'subtle':
      return theme.fgSubtle;
  }
}

export function getTaskReviewBadgeColor(state: TaskReviewState): string {
  return getTaskReviewToneColor(getTaskReviewStateBadgeTone(state));
}

export function getTaskReviewBadgeLabelForState(state: TaskReviewState): string | null {
  return getTaskReviewStateBadgeLabel(state);
}

export function getTaskReviewPanelColor(state: TaskReviewState): string {
  return getTaskReviewToneColor(getTaskReviewStatePanelTone(state));
}
