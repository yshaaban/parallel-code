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

  it('treats interactive choice prompts as waiting for input', () => {
    const controller = createAgentSupervisionController({
      now: () => currentTime,
    });

    controller.recordSpawn({
      agentId: 'agent-1',
      isShell: false,
      taskId: 'task-1',
    });
    controller.recordOutput('agent-1', 'bypass permissions on (shift+tab to cycle)');

    expect(controller.getSnapshot('agent-1')).toMatchObject({
      attentionReason: 'waiting-input',
      preview: 'Select an option',
      state: 'awaiting-input',
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
});
