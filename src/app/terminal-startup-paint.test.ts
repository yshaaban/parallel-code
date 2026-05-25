import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearTerminalStartupPaintCoordinationEntry,
  getGlobalTerminalStartupPaintCoordinationSnapshot,
  getTaskTerminalStartupPaintCoordinationSnapshot,
  resetTerminalStartupPaintCoordinationForTests,
  setTerminalStartupPaintCoordinationEntry,
} from './terminal-startup-paint';

describe('terminal-startup-paint', () => {
  beforeEach(() => {
    resetTerminalStartupPaintCoordinationForTests();
  });

  it('summarizes selected, visible-sibling, and hidden startup paint state by task', () => {
    setTerminalStartupPaintCoordinationEntry('task-1:selected', {
      paintReady: false,
      role: 'selected',
      taskId: 'task-1',
    });
    setTerminalStartupPaintCoordinationEntry('task-1:visible-ready', {
      paintReady: true,
      role: 'visible-sibling',
      taskId: 'task-1',
    });
    setTerminalStartupPaintCoordinationEntry('task-1:hidden-pending', {
      paintReady: false,
      role: 'hidden',
      taskId: 'task-1',
    });
    setTerminalStartupPaintCoordinationEntry('task-2:other', {
      paintReady: true,
      role: 'selected',
      taskId: 'task-2',
    });

    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1')).toEqual({
      hiddenPendingCount: 1,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 1,
      visibleReadyCount: 1,
    });
  });

  it('updates the selected ready state and clears removed entries', () => {
    setTerminalStartupPaintCoordinationEntry('task-1:selected', {
      paintReady: false,
      role: 'selected',
      taskId: 'task-1',
    });

    setTerminalStartupPaintCoordinationEntry('task-1:selected', {
      paintReady: true,
      role: 'selected',
      taskId: 'task-1',
    });

    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1').selectedPaintReady).toBe(true);

    clearTerminalStartupPaintCoordinationEntry('task-1:selected');

    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1')).toEqual({
      hiddenPendingCount: 0,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 0,
      visiblePendingCount: 0,
      visibleReadyCount: 0,
    });
  });

  it('ignores stale clears after the same key is claimed by a newer owner', () => {
    setTerminalStartupPaintCoordinationEntry(
      'task-1:selected',
      {
        paintReady: false,
        role: 'selected',
        taskId: 'task-1',
      },
      1,
    );

    setTerminalStartupPaintCoordinationEntry(
      'task-1:selected',
      {
        paintReady: true,
        role: 'selected',
        taskId: 'task-1',
      },
      2,
    );

    clearTerminalStartupPaintCoordinationEntry('task-1:selected', 1);
    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1').selectedPaintReady).toBe(true);

    clearTerminalStartupPaintCoordinationEntry('task-1:selected', 2);
    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1').selectedPaintReady).toBe(
      false,
    );
  });

  it('summarizes startup paint state across all tasks', () => {
    setTerminalStartupPaintCoordinationEntry('task-1:selected', {
      paintReady: true,
      role: 'selected',
      taskId: 'task-1',
    });
    setTerminalStartupPaintCoordinationEntry('task-2:visible-pending', {
      paintReady: false,
      role: 'visible-sibling',
      taskId: 'task-2',
    });
    setTerminalStartupPaintCoordinationEntry('task-3:hidden-ready', {
      paintReady: true,
      role: 'hidden',
      taskId: 'task-3',
    });

    expect(getGlobalTerminalStartupPaintCoordinationSnapshot()).toEqual({
      hiddenPendingCount: 0,
      hiddenReadyCount: 1,
      selectedPaintReady: true,
      selectedPendingCount: 0,
      visiblePendingCount: 1,
      visibleReadyCount: 1,
    });
  });
});
