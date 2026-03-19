export interface TaskCommandTransportAttempt {
  transportGeneration: number;
}

export interface TaskCommandTaskAndTransportAttempt extends TaskCommandTransportAttempt {
  taskGeneration: number;
}

export function clearOptionalInterval(
  timer: ReturnType<typeof globalThis.setInterval> | undefined,
): undefined {
  if (timer !== undefined) {
    globalThis.clearInterval(timer);
  }

  return undefined;
}

export function clearOptionalTimeout(
  timer: ReturnType<typeof globalThis.setTimeout> | undefined,
): undefined {
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
  }

  return undefined;
}

export function isTransportAttemptCurrent(
  currentTransportGeneration: number,
  attemptTransportGeneration: number,
  transportAvailable: boolean,
): boolean {
  return transportAvailable && currentTransportGeneration === attemptTransportGeneration;
}

export function isTaskAndTransportAttemptCurrent(
  currentTaskGeneration: number,
  currentTransportGeneration: number,
  attempt: TaskCommandTaskAndTransportAttempt,
  transportAvailable: boolean,
): boolean {
  return (
    attempt.taskGeneration === currentTaskGeneration &&
    isTransportAttemptCurrent(
      currentTransportGeneration,
      attempt.transportGeneration,
      transportAvailable,
    )
  );
}
