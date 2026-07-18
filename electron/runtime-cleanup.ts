export type DesktopRuntimeCleanupLabel = 'agent runner' | 'ask about code' | 'coordinator';

export interface RuntimeCleanupFailure<TLabel extends string> {
  error: unknown;
  label: TLabel;
}

export type DesktopRuntimeCleanupFailure = RuntimeCleanupFailure<DesktopRuntimeCleanupLabel>;

export async function collectRuntimeCleanupFailures<TLabel extends string>(
  owners: ReadonlyArray<{
    cleanup: Promise<void>;
    label: TLabel;
  }>,
): Promise<Array<RuntimeCleanupFailure<TLabel>>> {
  const results = await Promise.allSettled(owners.map((owner) => owner.cleanup));
  return results.flatMap((result, index): Array<RuntimeCleanupFailure<TLabel>> => {
    if (result.status === 'fulfilled') {
      return [];
    }

    const owner = owners[index];
    return owner === undefined ? [] : [{ error: result.reason, label: owner.label }];
  });
}

export class DesktopRuntimeCleanupError extends Error {
  readonly failures: DesktopRuntimeCleanupFailure[];

  constructor(failures: DesktopRuntimeCleanupFailure[]) {
    super(`Desktop runtime cleanup failed: ${failures.map((failure) => failure.label).join(', ')}`);
    this.name = 'DesktopRuntimeCleanupError';
    this.failures = failures;
  }
}

export async function settleDesktopRuntimeCleanupOwners(
  owners: ReadonlyArray<{
    cleanup: Promise<void>;
    label: DesktopRuntimeCleanupLabel;
  }>,
): Promise<void> {
  const failures = await collectRuntimeCleanupFailures(owners);
  if (failures.length > 0) {
    throw new DesktopRuntimeCleanupError(failures);
  }
}

export async function finishDesktopRuntimeShutdown(
  cleanup: Promise<void>,
  actions: {
    exit: (code: number, error: unknown) => void;
    quit: () => void;
  },
): Promise<void> {
  try {
    await cleanup;
    actions.quit();
  } catch (error) {
    actions.exit(1, error);
  }
}
