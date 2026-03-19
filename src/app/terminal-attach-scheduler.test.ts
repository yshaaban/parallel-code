import { afterEach, describe, expect, it } from 'vitest';
import { getTerminalStartupSummary } from '../store/terminal-startup';

import {
  registerTerminalAttachCandidate,
  resetTerminalAttachSchedulerForTests,
} from './terminal-attach-scheduler';

describe('terminal-attach-scheduler', () => {
  afterEach(() => {
    resetTerminalAttachSchedulerForTests();
  });

  it('serializes foreground attaches ahead of background work', async () => {
    const attachOrder: string[] = [];

    registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background');
      },
      getPriority: () => 2,
      key: 'background-terminal',
      taskId: 'task-background',
    });
    registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('active');
      },
      getPriority: () => 0,
      key: 'active-terminal',
      taskId: 'task-active',
    });
    registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('visible');
      },
      getPriority: () => 1,
      key: 'visible-terminal',
      taskId: 'task-visible',
    });

    await Promise.resolve();

    expect(attachOrder).toEqual(['active']);
  });

  it('starts the next foreground attach after release and only then resumes background work', async () => {
    const attachOrder: string[] = [];

    const active = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('active');
      },
      getPriority: () => 0,
      key: 'active-terminal',
      taskId: 'task-active',
    });
    const visible = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('visible');
      },
      getPriority: () => 1,
      key: 'visible-terminal',
      taskId: 'task-visible',
    });
    const background = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background');
      },
      getPriority: () => 2,
      key: 'background-terminal',
      taskId: 'task-background',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['active']);

    active.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'visible']);

    visible.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'visible', 'background']);

    active.unregister();
    visible.unregister();
    background.unregister();
  });

  it('reorders pending attaches when a candidate priority changes before attachment', async () => {
    const attachOrder: string[] = [];
    let dynamicPriority = 2;

    const dynamic = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('dynamic');
      },
      getPriority: () => dynamicPriority,
      key: 'dynamic-terminal',
      taskId: 'task-dynamic',
    });
    const visible = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('visible');
      },
      getPriority: () => 1,
      key: 'visible-terminal',
      taskId: 'task-visible',
    });

    dynamicPriority = 0;
    dynamic.updatePriority();
    await Promise.resolve();

    expect(attachOrder).toEqual(['dynamic']);

    dynamic.unregister();
    visible.unregister();
  });

  it('publishes queued and binding startup state while terminals wait for attachment', async () => {
    const queued = registerTerminalAttachCandidate({
      attach: () => undefined,
      getPriority: () => 2,
      key: 'task-1:agent-1',
      taskId: 'task-1',
    });

    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 0,
      bindingCount: 0,
      detail: '1 queued',
      label: 'Preparing terminal…',
      pendingCount: 1,
      queuedCount: 1,
      restoringCount: 0,
    });

    await Promise.resolve();

    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 0,
      bindingCount: 1,
      detail: '1 connecting',
      label: 'Connecting to terminal…',
      pendingCount: 1,
      queuedCount: 0,
      restoringCount: 0,
    });

    queued.unregister();

    expect(getTerminalStartupSummary()).toBeNull();
  });
});
