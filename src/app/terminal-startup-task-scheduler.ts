export type TerminalStartupTaskSchedulingMode = 'off' | 'post-task' | 'yield-only';
export type TerminalStartupTaskSchedulingOutcome =
  | 'fallback-animation-frame'
  | 'fallback-timeout'
  | 'off'
  | 'scheduler-post-task'
  | 'scheduler-yield';
export type TerminalStartupTaskSchedulingRole = 'hidden' | 'selected' | 'visible-sibling';
type TerminalStartupTaskSchedulerPriority = 'background' | 'user-blocking' | 'user-visible';

interface SchedulerLike {
  postTask?: <T>(
    callback: () => T | PromiseLike<T>,
    options?: { priority?: TerminalStartupTaskSchedulerPriority },
  ) => Promise<T>;
  yield?: () => Promise<void>;
}

function getSchedulerLike(): SchedulerLike | null {
  const globalScheduler = (globalThis as typeof globalThis & { scheduler?: SchedulerLike })
    .scheduler;
  return globalScheduler ?? null;
}

function getSchedulingPriority(
  role: TerminalStartupTaskSchedulingRole,
): TerminalStartupTaskSchedulerPriority {
  switch (role) {
    case 'selected':
      return 'user-blocking';
    case 'visible-sibling':
      return 'user-visible';
    case 'hidden':
      return 'background';
  }
}

function waitForFallbackYield(useTimeoutFallback: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (useTimeoutFallback) {
      globalThis.setTimeout(resolve, 0);
      return;
    }

    globalThis.requestAnimationFrame(() => resolve());
  });
}

function getFallbackYieldOutcome(
  useTimeoutFallback: boolean,
): TerminalStartupTaskSchedulingOutcome {
  return useTimeoutFallback ? 'fallback-timeout' : 'fallback-animation-frame';
}

export async function scheduleTerminalStartupTask<T>(
  role: TerminalStartupTaskSchedulingRole,
  mode: TerminalStartupTaskSchedulingMode,
  callback: () => T | Promise<T>,
): Promise<{ outcome: TerminalStartupTaskSchedulingOutcome; value: T }> {
  if (mode === 'off') {
    return { outcome: 'off', value: await callback() };
  }

  const schedulerLike = getSchedulerLike();
  if (mode === 'post-task' && schedulerLike?.postTask) {
    const value = await schedulerLike.postTask(callback, {
      priority: getSchedulingPriority(role),
    });
    return {
      outcome: 'scheduler-post-task',
      value,
    };
  }

  if (schedulerLike?.yield) {
    await schedulerLike.yield();
    return {
      outcome: 'scheduler-yield',
      value: await callback(),
    };
  }

  return {
    outcome: 'off',
    value: await callback(),
  };
}

export async function yieldTerminalStartupTask(options: {
  mode: TerminalStartupTaskSchedulingMode;
  role: TerminalStartupTaskSchedulingRole;
  useTimeoutFallback: boolean;
}): Promise<TerminalStartupTaskSchedulingOutcome> {
  const { mode, role, useTimeoutFallback } = options;

  if (mode === 'off') {
    await waitForFallbackYield(useTimeoutFallback);
    return getFallbackYieldOutcome(useTimeoutFallback);
  }

  const schedulerLike = getSchedulerLike();
  if (mode === 'post-task' && schedulerLike?.postTask) {
    await schedulerLike.postTask(() => undefined, {
      priority: getSchedulingPriority(role),
    });
    return 'scheduler-post-task';
  }

  if (schedulerLike?.yield) {
    await schedulerLike.yield();
    return 'scheduler-yield';
  }

  await waitForFallbackYield(useTimeoutFallback);
  return getFallbackYieldOutcome(useTimeoutFallback);
}
