import { describe, expect, it, vi } from 'vitest';
import { createTaskNameRegistry } from './task-names.js';

describe('createTaskNameRegistry', () => {
  it('loads task names from saved state and falls back to formatted ids', () => {
    const registry = createTaskNameRegistry();

    registry.syncFromSavedState(
      JSON.stringify({
        tasks: {
          one: { id: 'task-123', name: 'Alpha' },
        },
      }),
    );

    expect(registry.getTaskName('task-123')).toBe('Alpha');
    expect(registry.getTaskName('task-999')).toBe('999');
  });

  it('ignores malformed saved state without replacing existing names', () => {
    const registry = createTaskNameRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.setTaskName('task-123', 'Alpha');
    registry.syncFromSavedState('{');

    expect(registry.getTaskName('task-123')).toBe('Alpha');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('supports direct updates and deletion', () => {
    const registry = createTaskNameRegistry();

    registry.setTaskName('task-123', 'Alpha');
    expect(registry.getTaskName('task-123')).toBe('Alpha');

    registry.deleteTaskName('task-123');
    expect(registry.getTaskName('task-123')).toBe('123');
  });
});
