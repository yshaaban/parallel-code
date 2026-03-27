import { createSignal, onCleanup, type Accessor } from 'solid-js';

// Task activity UI only needs sub-second cadence to keep the 1.5s/2s activity
// windows responsive; a 500ms clock cuts global wakeups in half without making
// status transitions feel stale.
const TASK_ACTIVITY_TICK_MS = 500;

const [taskActivityNow, setTaskActivityNow] = createSignal(Date.now());

let subscriberCount = 0;
let taskActivityTimer: ReturnType<typeof setInterval> | undefined;

function clearTaskActivityTimer(): void {
  if (taskActivityTimer === undefined) {
    return;
  }

  clearInterval(taskActivityTimer);
  taskActivityTimer = undefined;
}

function ensureTaskActivityTimer(): void {
  if (subscriberCount <= 0 || taskActivityTimer !== undefined) {
    return;
  }

  taskActivityTimer = setInterval(() => {
    setTaskActivityNow(Date.now());
  }, TASK_ACTIVITY_TICK_MS);
}

export function useTaskActivityNow(): Accessor<number> {
  subscriberCount += 1;
  ensureTaskActivityTimer();

  onCleanup(() => {
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      clearTaskActivityTimer();
    }
  });

  return taskActivityNow;
}

export function resetTaskActivityClockForTests(now = Date.now()): void {
  subscriberCount = 0;
  clearTaskActivityTimer();
  setTaskActivityNow(now);
}
