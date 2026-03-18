import { afterEach, describe, expect, it } from 'vitest';

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

    registerTerminalAttachCandidate(
      'background-terminal',
      () => 2,
      () => {
        attachOrder.push('background');
      },
    );
    registerTerminalAttachCandidate(
      'active-terminal',
      () => 0,
      () => {
        attachOrder.push('active');
      },
    );
    registerTerminalAttachCandidate(
      'visible-terminal',
      () => 1,
      () => {
        attachOrder.push('visible');
      },
    );

    await Promise.resolve();

    expect(attachOrder).toEqual(['active']);
  });

  it('starts the next foreground attach after release and only then resumes background work', async () => {
    const attachOrder: string[] = [];

    const active = registerTerminalAttachCandidate(
      'active-terminal',
      () => 0,
      () => {
        attachOrder.push('active');
      },
    );
    const visible = registerTerminalAttachCandidate(
      'visible-terminal',
      () => 1,
      () => {
        attachOrder.push('visible');
      },
    );
    const background = registerTerminalAttachCandidate(
      'background-terminal',
      () => 2,
      () => {
        attachOrder.push('background');
      },
    );

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

    const dynamic = registerTerminalAttachCandidate(
      'dynamic-terminal',
      () => dynamicPriority,
      () => {
        attachOrder.push('dynamic');
      },
    );
    const visible = registerTerminalAttachCandidate(
      'visible-terminal',
      () => 1,
      () => {
        attachOrder.push('visible');
      },
    );

    dynamicPriority = 0;
    dynamic.updatePriority();
    await Promise.resolve();

    expect(attachOrder).toEqual(['dynamic']);

    dynamic.unregister();
    visible.unregister();
  });
});
