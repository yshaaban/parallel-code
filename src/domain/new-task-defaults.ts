export interface NewTaskDefaults {
  skipPermissions: boolean;
  stepsTracking: boolean;
}

export type NewTaskDefaultKey = keyof NewTaskDefaults;

export const DEFAULT_NEW_TASK_DEFAULTS: Readonly<NewTaskDefaults> = Object.freeze({
  skipPermissions: true,
  stepsTracking: false,
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolve persisted client input without coercion. Each member falls back independently so one
 * malformed value cannot erase a valid sibling preference.
 */
export function resolveNewTaskDefaults(value: unknown): NewTaskDefaults {
  const input = asRecord(value);

  return {
    skipPermissions:
      typeof input.skipPermissions === 'boolean'
        ? input.skipPermissions
        : DEFAULT_NEW_TASK_DEFAULTS.skipPermissions,
    stepsTracking:
      typeof input.stepsTracking === 'boolean'
        ? input.stepsTracking
        : DEFAULT_NEW_TASK_DEFAULTS.stepsTracking,
  };
}

/** Return a detached per-open form value rather than aliasing the durable preference. */
export function copyNewTaskDefaults(value: NewTaskDefaults): NewTaskDefaults {
  return {
    skipPermissions: value.skipPermissions,
    stepsTracking: value.stepsTracking,
  };
}
