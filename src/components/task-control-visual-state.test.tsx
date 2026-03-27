import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal, Show, untrack } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';
import { createTaskControlVisualState } from './task-control-visual-state';

interface HarnessProps {
  active: boolean;
  taskId: string;
}

function TaskControlVisualStateHarness(props: HarnessProps) {
  const taskId = untrack(() => props.taskId);
  const visualState = createTaskControlVisualState({
    fallbackAction: 'type in the terminal',
    isActive: () => props.active,
    taskId,
  });

  return (
    <div>
      <div data-testid="banner-visible">{visualState.isBannerVisible() ? 'true' : 'false'}</div>
      <div data-testid="label">{visualState.status()?.label ?? 'none'}</div>
      <button onClick={() => visualState.dismissBanner()}>dismiss</button>
      <button onClick={() => visualState.expandBanner()}>expand</button>
      <Show when={visualState.status()}>
        {(status) => <div data-testid="message">{status().message}</div>}
      </Show>
    </div>
  );
}

describe('createTaskControlVisualState', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  afterEach(() => {
    resetStoreForTest();
  });

  it('shows the banner when an active peer controller is introduced', () => {
    const [active] = createSignal(true);
    const result = render(() => (
      <TaskControlVisualStateHarness active={active()} taskId="task-1" />
    ));

    expect(result.getByTestId('banner-visible').textContent).toBe('false');

    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });

    expect(result.getByTestId('banner-visible').textContent).toBe('true');
    expect(result.getByTestId('label').textContent).toContain('typing');
  });

  it('collapses to chip state when dismissed and re-expands on demand', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });

    const [active] = createSignal(true);
    const result = render(() => (
      <TaskControlVisualStateHarness active={active()} taskId="task-1" />
    ));

    expect(result.getByTestId('banner-visible').textContent).toBe('true');

    await fireEvent.click(result.getByText('dismiss'));
    expect(result.getByTestId('banner-visible').textContent).toBe('false');
    expect(result.getByTestId('label').textContent).toContain('typing');

    await fireEvent.click(result.getByText('expand'));
    expect(result.getByTestId('banner-visible').textContent).toBe('true');
  });

  it('reintroduces the banner when a different peer controller replaces the dismissed one', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-a',
    });

    const [active] = createSignal(true);
    const result = render(() => (
      <TaskControlVisualStateHarness active={active()} taskId="task-1" />
    ));

    expect(result.getByTestId('banner-visible').textContent).toBe('true');
    await fireEvent.click(result.getByText('dismiss'));
    expect(result.getByTestId('banner-visible').textContent).toBe('false');

    setStore('taskCommandControllers', 'task-1', {
      action: 'send a prompt',
      controllerId: 'peer-b',
    });

    expect(result.getByTestId('banner-visible').textContent).toBe('true');
    expect(result.getByTestId('message').textContent).toContain('sending prompts');
  });
});
