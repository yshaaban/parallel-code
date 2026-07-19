import { describe, expect, it } from 'vitest';
import { isTaskMode, isTerminalTask, normalizeTaskMode } from './task-mode';

describe('task mode', () => {
  it('recognizes the two canonical execution modes', () => {
    expect(isTaskMode('agent')).toBe(true);
    expect(isTaskMode('terminal')).toBe(true);
    expect(isTaskMode('coordinator')).toBe(false);
  });

  it('defaults missing and invalid persisted values to the legacy agent behavior', () => {
    expect(normalizeTaskMode(undefined)).toBe('agent');
    expect(normalizeTaskMode('unknown')).toBe('agent');
  });

  it('identifies terminal-only tasks explicitly rather than inferring from agent counts', () => {
    expect(isTerminalTask({ taskMode: 'terminal' })).toBe(true);
    expect(isTerminalTask({ taskMode: 'agent' })).toBe(false);
  });
});
