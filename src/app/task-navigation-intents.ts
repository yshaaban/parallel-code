import { hasBlockingDialog, navigateTask } from '../store/focus';
import { jumpToTask } from '../store/navigation';
import { store } from '../store/state';
import { requestTerminalPrewarm } from './terminal-prewarm';

// Keyboard task navigation is the strongest selection intent we have before
// the target terminal becomes visible, so the predicted target gets a
// selection-intent prewarm before the store navigation runs. The store layer
// stays free of app imports; this wrapper owns the prewarm composition.

function prewarmPredictedTask(targetTaskId: string | undefined): void {
  if (!targetTaskId || !store.tasks[targetTaskId]) {
    return;
  }

  requestTerminalPrewarm(targetTaskId, 'selection-intent');
}

export function navigateTaskWithPrewarm(direction: 'left' | 'right'): void {
  if (!hasBlockingDialog()) {
    const activeTaskId = store.activeTaskId;
    const currentIndex = activeTaskId ? store.taskOrder.indexOf(activeTaskId) : -1;
    if (currentIndex !== -1) {
      const offset = direction === 'left' ? -1 : 1;
      prewarmPredictedTask(store.taskOrder[currentIndex + offset]);
    }
  }

  navigateTask(direction);
}

export function jumpToTaskWithPrewarm(index: number): void {
  prewarmPredictedTask(store.taskOrder[index]);
  jumpToTask(index);
}
