import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NEW_TASK_DEFAULTS,
  copyNewTaskDefaults,
  resolveNewTaskDefaults,
} from './new-task-defaults';

describe('new task defaults', () => {
  it.each([undefined, null, false, 'invalid', [], {}])(
    'uses the product defaults for malformed or absent input %#',
    (input) => {
      expect(resolveNewTaskDefaults(input)).toEqual(DEFAULT_NEW_TASK_DEFAULTS);
    },
  );

  it('resolves each field independently and ignores unknown fields', () => {
    expect(
      resolveNewTaskDefaults({
        skipPermissions: false,
        stepsTracking: 'yes',
        unknown: true,
      }),
    ).toEqual({
      skipPermissions: false,
      stepsTracking: false,
    });

    expect(
      resolveNewTaskDefaults({
        skipPermissions: 1,
        stepsTracking: true,
      }),
    ).toEqual({
      skipPermissions: true,
      stepsTracking: true,
    });
  });

  it('preserves explicit false for both fields', () => {
    expect(resolveNewTaskDefaults({ skipPermissions: false, stepsTracking: false })).toEqual({
      skipPermissions: false,
      stepsTracking: false,
    });
  });

  it('returns detached objects from normalization and copying', () => {
    const input = { skipPermissions: false, stepsTracking: true };
    const resolved = resolveNewTaskDefaults(input);
    const copied = copyNewTaskDefaults(resolved);

    expect(resolved).not.toBe(input);
    expect(copied).not.toBe(resolved);
    copied.skipPermissions = true;
    copied.stepsTracking = false;

    expect(resolved).toEqual({ skipPermissions: false, stepsTracking: true });
  });

  it('adds less than 100 uncompressed bytes to a serialized preference snapshot', () => {
    const withoutDefaults = JSON.stringify({});
    const withDefaults = JSON.stringify({ newTaskDefaults: DEFAULT_NEW_TASK_DEFAULTS });

    expect(withDefaults.length - withoutDefaults.length).toBeLessThan(100);
  });
});
