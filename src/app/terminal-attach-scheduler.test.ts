import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTerminalStartupSummary } from '../store/terminal-startup';
import {
  beginBrowserColdBootstrap,
  completeBrowserColdBootstrap,
  resetBrowserStartupStateForTests,
} from './browser-startup';

import {
  notifyTerminalAttachPolicyChanged,
  registerTerminalAttachCandidate,
  resetTerminalAttachSchedulerForTests,
} from './terminal-attach-scheduler';

async function withMutedAttachWarnings(run: () => Promise<void>): Promise<void> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await run();
  } finally {
    warnSpy.mockRestore();
  }
}

describe('terminal-attach-scheduler', () => {
  afterEach(() => {
    resetBrowserStartupStateForTests();
    resetTerminalAttachSchedulerForTests();
  });

  it('attaches the foreground candidate first without starving background slots', async () => {
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

    // The foreground cap holds 'visible' back, but a pending foreground
    // candidate no longer collapses background concurrency to one: the
    // remaining slot goes to background work in the same drain pass.
    expect(attachOrder).toEqual(['active', 'background']);
  });

  it('starts the next foreground attach after release while background slots stay busy', async () => {
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
    expect(attachOrder).toEqual(['active', 'background']);

    active.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'background', 'visible']);

    active.unregister();
    visible.unregister();
    background.unregister();
  });

  it('keeps background concurrency above one while a foreground candidate stays pending', async () => {
    const attachOrder: string[] = [];

    const active = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('active');
      },
      getPriority: () => 0,
      key: 'active-terminal',
      taskId: 'task-active',
    });
    // A second pending foreground candidate (over the foreground cap) used to
    // break the whole drain and serialize every reconnect re-attach.
    const pendingForeground = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('pending-foreground');
      },
      getPriority: () => 0,
      key: 'pending-foreground-terminal',
      taskId: 'task-pending-foreground',
    });
    const backgroundA = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-a');
      },
      getPriority: () => 2,
      key: 'u-background-a',
      taskId: 'task-background-a',
    });
    const backgroundB = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-b');
      },
      getPriority: () => 2,
      key: 'v-background-b',
      taskId: 'task-background-b',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'background-a']);

    backgroundA.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'background-a', 'background-b']);

    active.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['active', 'background-a', 'background-b', 'pending-foreground']);

    active.unregister();
    pendingForeground.unregister();
    backgroundA.unregister();
    backgroundB.unregister();
  });

  it('ignores stale release and unregister calls after the same key is re-registered', async () => {
    const attachOrder: string[] = [];

    const stale = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('stale');
      },
      getPriority: () => 0,
      key: 'same-terminal',
      taskId: 'task-1',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['stale']);

    const current = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('current');
      },
      getPriority: () => 0,
      key: 'same-terminal',
      taskId: 'task-1',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['stale', 'current']);

    const contender = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('contender');
      },
      getPriority: () => 0,
      key: 'contender-terminal',
      taskId: 'task-2',
    });

    stale.release();
    stale.unregister();
    await Promise.resolve();
    expect(attachOrder).toEqual(['stale', 'current']);
    expect(getTerminalStartupSummary()?.pendingCount).toBe(2);

    current.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['stale', 'current', 'contender']);

    current.unregister();
    contender.unregister();
  });

  it('limits background attaches to the scheduler budget and drains queued work on release', async () => {
    const attachOrder: string[] = [];

    const backgroundA = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-a');
      },
      getPriority: () => 2,
      key: 'background-a',
      taskId: 'task-background-a',
    });
    const backgroundB = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-b');
      },
      getPriority: () => 2,
      key: 'background-b',
      taskId: 'task-background-b',
    });
    const backgroundC = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-c');
      },
      getPriority: () => 2,
      key: 'background-c',
      taskId: 'task-background-c',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['background-a', 'background-b']);

    backgroundA.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['background-a', 'background-b', 'background-c']);

    backgroundA.unregister();
    backgroundB.unregister();
    backgroundC.unregister();
  });

  it('starts a foreground attach even when background attach budget is saturated', async () => {
    const attachOrder: string[] = [];

    const backgroundA = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-a');
      },
      getPriority: () => 2,
      key: 'background-a',
      taskId: 'task-background-a',
    });
    const backgroundB = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('background-b');
      },
      getPriority: () => 2,
      key: 'background-b',
      taskId: 'task-background-b',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['background-a', 'background-b']);

    const selected = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('selected');
      },
      getPriority: () => 0,
      key: 'selected-terminal',
      taskId: 'task-selected',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['background-a', 'background-b', 'selected']);

    backgroundA.unregister();
    backgroundB.unregister();
    selected.unregister();
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

  it('cancels queued candidates released before attachment', async () => {
    const attachOrder: string[] = [];

    const active = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('active');
      },
      getPriority: () => 0,
      key: 'active-terminal',
      taskId: 'task-active',
    });
    const queued = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('queued');
      },
      getPriority: () => 1,
      key: 'queued-terminal',
      taskId: 'task-queued',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['active']);

    queued.release();
    active.release();
    await Promise.resolve();

    expect(attachOrder).toEqual(['active']);
    expect(getTerminalStartupSummary()?.pendingCount).toBe(1);

    active.unregister();
    queued.unregister();
  });

  it('releases attach admission when a candidate throws during attachment', async () => {
    const attachOrder: string[] = [];

    await withMutedAttachWarnings(async () => {
      registerTerminalAttachCandidate({
        attach: () => {
          attachOrder.push('throws');
          throw new Error('attach failed');
        },
        getPriority: () => 0,
        key: 'a-throwing-terminal',
        taskId: 'task-throwing',
      });
      const next = registerTerminalAttachCandidate({
        attach: () => {
          attachOrder.push('next');
        },
        getPriority: () => 1,
        key: 'z-next-terminal',
        taskId: 'task-next',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(attachOrder).toEqual(['throws', 'next']);
      expect(getTerminalStartupSummary()?.pendingCount).toBe(1);

      next.unregister();
    });
  });

  it('does not clear a same-key replacement when a stale candidate throws during attachment', async () => {
    const attachOrder: string[] = [];

    await withMutedAttachWarnings(async () => {
      let replacement: ReturnType<typeof registerTerminalAttachCandidate> | undefined;
      registerTerminalAttachCandidate({
        attach: () => {
          attachOrder.push('stale');
          replacement = registerTerminalAttachCandidate({
            attach: () => {
              attachOrder.push('replacement');
            },
            getPriority: () => 0,
            key: 'same-terminal',
            taskId: 'task-replacement',
          });
          throw new Error('stale attach failed');
        },
        getPriority: () => 0,
        key: 'same-terminal',
        taskId: 'task-stale',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(attachOrder).toEqual(['stale', 'replacement']);
      expect(getTerminalStartupSummary()?.pendingCount).toBe(1);

      replacement?.unregister();
    });
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
      label: 'Preparing terminal…',
      pendingCount: 1,
      queuedCount: 0,
      restoringCount: 0,
    });

    queued.unregister();

    expect(getTerminalStartupSummary()).toBeNull();
  });

  it('blocks non-foreground terminal attaches during browser cold bootstrap', async () => {
    beginBrowserColdBootstrap();
    const attachOrder: string[] = [];

    const selected = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('selected');
      },
      getPriority: () => 1,
      key: 'selected-terminal',
      taskId: 'task-selected',
    });
    const hidden = registerTerminalAttachCandidate({
      attach: () => {
        attachOrder.push('hidden');
      },
      getPriority: () => 3,
      key: 'hidden-terminal',
      taskId: 'task-hidden',
    });

    await Promise.resolve();
    expect(attachOrder).toEqual(['selected']);

    selected.release();
    await Promise.resolve();
    expect(attachOrder).toEqual(['selected']);

    completeBrowserColdBootstrap();
    notifyTerminalAttachPolicyChanged();
    await Promise.resolve();
    expect(attachOrder).toEqual(['selected', 'hidden']);

    selected.unregister();
    hidden.unregister();
  });
});
