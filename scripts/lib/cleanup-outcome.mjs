export function createLabeledCleanupError(label, error) {
  return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  });
}

async function settleCleanup(label, cleanup) {
  try {
    await cleanup();
    return null;
  } catch (error) {
    return createLabeledCleanupError(label, error);
  }
}

export function assertOperationCleanupSucceeded(label, operationOutcome, cleanupErrors) {
  const operationFailed = operationOutcome.status === 'rejected';
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(operationFailed ? [operationOutcome.reason] : []), ...cleanupErrors],
      operationFailed ? `${label} operation and cleanup failed` : `${label} cleanup failed`,
    );
  }
  if (operationFailed) {
    throw operationOutcome.reason;
  }
}

export async function runOperationWithCleanups(label, operation, cleanupSteps) {
  let operationOutcome;
  try {
    operationOutcome = { status: 'fulfilled', value: await operation() };
  } catch (reason) {
    operationOutcome = { reason, status: 'rejected' };
  }

  const cleanupErrors = [];
  for (const [cleanupLabel, cleanup] of cleanupSteps) {
    const cleanupError = await settleCleanup(cleanupLabel, cleanup);
    if (cleanupError !== null) {
      cleanupErrors.push(cleanupError);
    }
  }

  assertOperationCleanupSucceeded(label, operationOutcome, cleanupErrors);
  return operationOutcome.value;
}

export async function runIndependentCleanups(label, cleanupSteps) {
  const outcomes = await Promise.allSettled(
    cleanupSteps.map(([, cleanup]) => Promise.resolve().then(cleanup)),
  );
  const cleanupErrors = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      return [];
    }

    const cleanupStep = cleanupSteps[index];
    return cleanupStep ? [createLabeledCleanupError(cleanupStep[0], outcome.reason)] : [];
  });

  assertOperationCleanupSucceeded(label, { status: 'fulfilled', value: undefined }, cleanupErrors);
}
