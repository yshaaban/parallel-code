import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

import { getPeerTaskCommandControlStatus } from '../store/store';
import type { PeerTaskCommandControlStatus } from '../store/task-command-controllers';

interface CreateTaskControlVisualStateOptions {
  fallbackAction: string;
  isActive: Accessor<boolean>;
  taskId: string;
}

interface TaskControlVisualState {
  dismissBanner: () => void;
  expandBanner: () => void;
  isBannerVisible: Accessor<boolean>;
  status: Accessor<PeerTaskCommandControlStatus | null>;
}

export function createTaskControlVisualState(
  options: CreateTaskControlVisualStateOptions,
): TaskControlVisualState {
  const status = createMemo(() =>
    getPeerTaskCommandControlStatus(options.taskId, options.fallbackAction),
  );
  const [expandedControllerKey, setExpandedControllerKey] = createSignal<string | null>(null);
  const [dismissedControllerKey, setDismissedControllerKey] = createSignal<string | null>(null);
  const [introducedControllerKey, setIntroducedControllerKey] = createSignal<string | null>(null);

  function resetVisualState(): void {
    setExpandedControllerKey(null);
    setDismissedControllerKey(null);
    setIntroducedControllerKey(null);
  }

  createEffect(() => {
    const nextControllerKey = status()?.controllerKey ?? null;
    if (!nextControllerKey) {
      resetVisualState();
      return;
    }

    if (
      nextControllerKey !== expandedControllerKey() &&
      nextControllerKey !== dismissedControllerKey() &&
      nextControllerKey !== introducedControllerKey() &&
      options.isActive() === true
    ) {
      setExpandedControllerKey(nextControllerKey);
      setIntroducedControllerKey(nextControllerKey);
      return;
    }

    if (
      dismissedControllerKey() !== null &&
      dismissedControllerKey() !== nextControllerKey &&
      introducedControllerKey() !== nextControllerKey
    ) {
      setDismissedControllerKey(null);
      setExpandedControllerKey(null);
    }
  });

  function dismissBanner(): void {
    const nextControllerKey = status()?.controllerKey;
    if (!nextControllerKey) {
      return;
    }

    setDismissedControllerKey(nextControllerKey);
    if (expandedControllerKey() === nextControllerKey) {
      setExpandedControllerKey(null);
    }
  }

  function expandBanner(): void {
    const nextControllerKey = status()?.controllerKey;
    if (!nextControllerKey) {
      return;
    }

    if (dismissedControllerKey() === nextControllerKey) {
      setDismissedControllerKey(null);
    }
    setExpandedControllerKey(nextControllerKey);
    setIntroducedControllerKey(nextControllerKey);
  }

  const isBannerVisible = createMemo(() => {
    const nextControllerKey = status()?.controllerKey;
    if (!nextControllerKey) {
      return false;
    }

    return expandedControllerKey() === nextControllerKey;
  });

  return {
    dismissBanner,
    expandBanner,
    isBannerVisible,
    status,
  };
}
