import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentSupervisionController } from './agent-supervision.js';

describe('agent supervision', () => {
  let currentTime = 1_000;

  function advanceTime(ms: number): void {
    currentTime += ms;
    vi.advanceTimersByTime(ms);
  }

  beforeEach(() => {
    currentTime = 1_000;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks agents awaiting input when the tail shows a question', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'Proceed with deployment? [Y/n]');

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      state: 'awaiting-input',
    });
  });

  it('marks agents idle at prompt when Hydra is waiting for the next step', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', '\nhydra[dispatch]> ');

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'hydra[dispatch]>',
      state: 'idle-at-prompt',
    });
  });

  it('does not treat shortcut-only permission footers as waiting for input', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput(
      'agent-1',
      'What would you like to work on?\n⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ',
    );

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'What would you like to work on?',
      state: 'idle-at-prompt',
    });
  });

  it('keeps Hydra interactive choices in waiting-input while the operator prompt is still visible', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput(
      'agent-1',
      'Use arrow keys to cycle\nSelect an option\nhydra[dispatch]>',
    );

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      preview: 'Select an option',
      state: 'awaiting-input',
    });
  });

  it('keeps Hydra prompt-ready supervision under repeated redraw-heavy footer updates', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });
    const footer =
      '\u001b[s\u001b[1;29r\u001b[29;1H\u001b[30;1H\u001b[2K──────────────────────────────────────────────────────────────\u001b[31;1H\u001b[2K ↻ auto  │  0 tasks                                           \u001b[32;1H\u001b[2K● ✦ GEMINI Inact…  │  ● ֎ CODEX Inacti…  │  ● ❋ CLAUDE Inact…\u001b[33;1H\u001b[2K  ↳ awaiting events...\u001b[34;1H\u001b[2K\u001b[u';

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput(
      'agent-1',
      `hydra>\u001b[8GDescribe a task to dispatch to agents${footer.repeat(8)}`,
    );

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'hydra>',
      state: 'idle-at-prompt',
    });
  });

  it('marks agents quiet when output stops for too long', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
      quietAfterMs: 10_000,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'Running formatter...\n');

    advanceTime(10_000);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'quiet-too-long',
      state: 'quiet',
    });
  });

  it('does not decay awaiting-input supervision into quiet', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
      quietAfterMs: 10_000,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'Proceed with deployment? [Y/n]');

    advanceTime(10_000);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      preview: 'Proceed with deployment? [Y/n]',
      state: 'awaiting-input',
    });
  });

  it('does not decay idle-at-prompt supervision into quiet', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
      quietAfterMs: 10_000,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', '\nhydra[dispatch]> ');

    advanceTime(10_000);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'hydra[dispatch]>',
      state: 'idle-at-prompt',
    });
  });

  it('drops unreadable active preview lines instead of surfacing terminal noise', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
      quietAfterMs: 10_000,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', '▐▛▜▌ ▝▜█████▛▘ ▘▘ ▝▝');

    advanceTime(10_000);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'quiet-too-long',
      preview: 'No recent output',
      state: 'quiet',
    });
  });

  it('emits removal events when supervision state is cleared', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });
    const events: unknown[] = [];

    controller.subscribe((event) => {
      events.push(event);
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.removeTask('task-1');

    expect(events).toContainEqual({
      kind: 'removed',
      agentId: 'agent-1',
      removed: true,
      taskId: 'task-1',
    });
  });

  it('marks non-zero exits as failed attention', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordExit('agent-1', {
      exitCode: 1,
      lastOutput: ['fatal: merge conflict'],
      signal: null,
    });

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'failed',
      preview: 'fatal: merge conflict',
      state: 'exited-error',
    });
  });

  it('restores idle-at-prompt supervision after automatic pause clears', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', '\nready for next input\n❯ ');
    controller.recordPauseState('agent-1', 'flow-control');

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'flow-controlled',
      state: 'flow-controlled',
    });

    controller.recordPauseState('agent-1', null);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'ready for next input',
      state: 'idle-at-prompt',
    });
  });

  it('restores awaiting-input supervision after restore pause clears', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'Proceed with deployment? [Y/n]');
    controller.recordPauseState('agent-1', 'restore');

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'restoring',
      state: 'restoring',
    });

    controller.recordPauseState('agent-1', null);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      preview: 'Proceed with deployment? [Y/n]',
      state: 'awaiting-input',
    });
  });

  it('keeps pause clear reclassification stable across repeated automatic pause churn', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: true,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'Proceed with deployment? [Y/n]');

    for (const reason of ['flow-control', 'restore', 'flow-control', null] as const) {
      controller.recordPauseState('agent-1', reason);
    }

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      preview: 'Proceed with deployment? [Y/n]',
      state: 'awaiting-input',
    });

    controller.recordOutput('agent-1', '\nnext step ready\n❯ ');
    controller.recordPauseState('agent-1', 'flow-control');
    controller.recordPauseState('agent-1', null);

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'ready-for-next-step',
      preview: 'next step ready',
      state: 'idle-at-prompt',
    });
  });
});
