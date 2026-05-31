import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestAgentDef,
  createTestProject,
  createTestAgent,
  createTestTask,
  resetStoreForTest,
} from '../../test/store-test-helpers';
import { setStore } from '../../store/core';
import { store, triggerFocus } from '../../store/store';
import { TaskAiTerminalSection } from './TaskAiTerminalSection';
import { IPC } from '../../../electron/ipc/channels';

const readyCallbacks = new Map<string, (focusFn: () => void) => void>();
const { invokeMock, saveCurrentRuntimeStateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
}));

vi.mock('../TerminalView', () => ({
  TerminalView: (props: {
    agentId: string;
    isCommandTarget?: boolean;
    manageTaskSwitchWindowLifecycle?: boolean;
    onReady?: (focusFn: () => void) => void;
    runnerProfile?: { provider: string };
  }) => (
    <div
      data-command-target={props.isCommandTarget === true ? 'true' : 'false'}
      data-manage-switch-window={String(props.manageTaskSwitchWindowLifecycle)}
      data-runner-provider={props.runnerProfile?.provider ?? 'host'}
      ref={() => {
        if (props.onReady) {
          readyCallbacks.set(props.agentId, props.onReady);
        }
      }}
    >
      Terminal {props.agentId}
    </div>
  ),
}));

vi.mock('../AgentSwitchMenu', () => ({
  AgentSwitchMenu: () => <button type="button">Switch agent</button>,
}));

vi.mock('../../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../../store/persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

function getRequiredButton(
  container: HTMLElement,
  selector: string,
  missingMessage: string,
): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(missingMessage);
  }

  return button;
}

describe('TaskAiTerminalSection', () => {
  beforeEach(() => {
    resetStoreForTest();
    readyCallbacks.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveCurrentRuntimeStateMock.mockReset();
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the selected task agent instead of assuming the first agent', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-2',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({
        def: createTestAgentDef({ id: 'claude', name: 'Claude' }),
        id: 'agent-1',
        taskId: 'task-1',
      }),
      'agent-2': createTestAgent({
        def: createTestAgentDef({ id: 'codex', name: 'Codex' }),
        id: 'agent-2',
        taskId: 'task-1',
      }),
    });

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-2')).toBeDefined();
    expect(screen.queryByText('Terminal agent-1')).toBeNull();
  });

  it('lets the active agent override stale selected-agent metadata for the active task', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-2');

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-2')).toBeDefined();
  });

  it('hides layout controls when there is only one agent terminal to arrange', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    const view = render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(view.container.querySelector('[data-ai-terminal-layout-controls]')).toBeNull();
    expect(view.container.querySelectorAll('[data-ai-terminal-layout-button]')).toHaveLength(0);
  });

  it('shows layout controls when multiple agent terminals can be arranged', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });

    const view = render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));
    const layoutButtons = view.container.querySelectorAll('[data-ai-terminal-layout-button]');
    const gridButton = getRequiredButton(
      view.container,
      '[data-ai-terminal-layout-button="grid"]',
      'Grid layout button was not rendered',
    );

    expect(view.container.querySelector('[data-ai-terminal-layout-controls]')).toBeDefined();
    expect(layoutButtons).toHaveLength(4);
    expect(screen.getByText('Solo')).toBeDefined();

    fireEvent.click(gridButton);

    expect(store.tasks['task-1']?.terminalLayoutMode).toBe('grid');
  });

  it('adds a sibling agent from the terminal info bar', async () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    const codexDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('availableAgents', [createTestAgentDef({ id: 'claude', name: 'Claude' }), codexDef]);
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    const view = render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));
    const addButton = getRequiredButton(
      view.container,
      '[data-ai-terminal-add-agent-button]',
      'Add agent button was not rendered',
    );

    fireEvent.click(addButton);
    const codexOption = getRequiredButton(
      view.container,
      '[data-ai-terminal-add-agent-option="codex"]',
      'Codex add-agent option was not rendered',
    );

    fireEvent.click(codexOption);

    await waitFor(() => {
      expect(store.tasks['task-1']?.agentIds).toHaveLength(2);
    });
    const addedAgentId = store.tasks['task-1']?.agentIds[1];
    expect(addedAgentId).toBeDefined();
    expect(store.tasks['task-1']?.selectedAgentId).toBe(addedAgentId);
    expect(store.agents[addedAgentId ?? '']?.def).toEqual(codexDef);
    expect(screen.getByText(`Terminal ${addedAgentId}`)).toBeDefined();
    expect(view.container.querySelector('[data-ai-terminal-agent-tabs]')).toBeDefined();
    expect(view.container.querySelector('[data-ai-terminal-layout-controls]')).toBeDefined();
  });

  it('closes a selected sibling agent from the terminal info bar', async () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-2',
      terminalLayoutMode: 'split',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({
        def: createTestAgentDef({ id: 'codex', name: 'Codex' }),
        id: 'agent-2',
        taskId: 'task-1',
      }),
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-2');

    const view = render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));
    const closeButton = getRequiredButton(
      view.container,
      '[data-ai-terminal-agent-close="agent-2"]',
      'Agent close button was not rendered',
    );

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'agent-2' });
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-1');
    expect(store.activeAgentId).toBe('agent-1');
    expect(store.agents['agent-2']).toBeUndefined();
    expect(view.container.querySelector('[data-ai-terminal-layout-controls]')).toBeNull();
  });

  it('renders passive siblings without granting command authority in split layout', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2', 'agent-3'],
      id: 'task-1',
      selectedAgentId: 'agent-2',
      terminalLayoutMode: 'split',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
      'agent-3': createTestAgent({ id: 'agent-3', taskId: 'task-1' }),
    });

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-2').dataset.commandTarget).toBe('true');
    expect(screen.getByText('Terminal agent-2').dataset.manageSwitchWindow).toBe('false');
    expect(screen.getByText('Terminal agent-1').dataset.commandTarget).toBe('false');
    expect(screen.getByText('Terminal agent-1').dataset.manageSwitchWindow).toBe('false');
    expect(screen.queryByText('Terminal agent-3')).toBeNull();
  });

  it('uses stacked layout to expose every task agent with one command target', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2', 'agent-3'],
      id: 'task-1',
      selectedAgentId: 'agent-2',
      terminalLayoutMode: 'stacked',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
      'agent-3': createTestAgent({ id: 'agent-3', taskId: 'task-1' }),
    });

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-1').dataset.commandTarget).toBe('false');
    expect(screen.getByText('Terminal agent-2').dataset.commandTarget).toBe('true');
    expect(screen.getByText('Terminal agent-3').dataset.commandTarget).toBe('false');
  });

  it('falls back to a visible live sibling when the selected agent is missing', () => {
    const task = createTestTask({
      agentIds: ['agent-missing', 'agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-missing',
      terminalLayoutMode: 'stacked',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.queryByText('Terminal agent-missing')).toBeNull();
    expect(screen.getByText('Terminal agent-1').dataset.commandTarget).toBe('true');
    expect(screen.getByText('Terminal agent-2').dataset.commandTarget).toBe('false');
  });

  it('replays an ai-terminal focus request when the selected tile becomes ready', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    const focusAgent = vi.fn();
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    triggerFocus('task-1:ai-terminal');
    expect(focusAgent).not.toHaveBeenCalled();

    readyCallbacks.get('agent-1')?.(focusAgent);

    expect(focusAgent).toHaveBeenCalledTimes(1);
  });

  it('passes project agent runner config into each visible terminal', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('projects', [
      createTestProject({
        agentRunnerConfig: {
          image: 'agent:latest',
          provider: 'docker-container',
        },
      }),
    ]);
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));

    expect(screen.getByText('Terminal agent-1').dataset.runnerProvider).toBe('docker-container');
  });

  it('passes unsupported persisted runner profiles so backend launch rejects instead of falling back to host', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('projects', [
      createTestProject({
        agentRunnerConfig: {
          provider: 'docker-sandbox',
        },
      }),
    ]);
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));

    expect(screen.getByText('Terminal agent-1').dataset.runnerProvider).toBe('docker-sandbox');
  });

  it('drops stale focus callbacks when a visible sibling unmounts before becoming selected again', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
      terminalLayoutMode: 'split',
    });
    const staleFocusAgent = vi.fn();
    const nextFocusAgent = vi.fn();
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));

    readyCallbacks.get('agent-2')?.(staleFocusAgent);
    setStore('tasks', 'task-1', 'terminalLayoutMode', undefined);
    expect(screen.queryByText('Terminal agent-2')).toBeNull();

    setStore('activeAgentId', 'agent-2');
    setStore('tasks', 'task-1', 'selectedAgentId', 'agent-2');
    triggerFocus('task-1:ai-terminal');

    expect(staleFocusAgent).not.toHaveBeenCalled();
    readyCallbacks.get('agent-2')?.(nextFocusAgent);
    expect(nextFocusAgent).toHaveBeenCalledTimes(1);
  });

  it('drops stale focus callbacks when a selected terminal remounts for a new session', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    const staleFocusAgent = vi.fn();
    const nextFocusAgent = vi.fn();
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TaskAiTerminalSection
        isActive={() => true}
        onReuseLastPrompt={vi.fn()}
        task={() => store.tasks['task-1'] ?? task}
      />
    ));

    readyCallbacks.get('agent-1')?.(staleFocusAgent);
    setStore('agents', 'agent-1', 'terminalSessionVersion', 1);
    triggerFocus('task-1:ai-terminal');

    expect(staleFocusAgent).not.toHaveBeenCalled();
    readyCallbacks.get('agent-1')?.(nextFocusAgent);
    expect(nextFocusAgent).toHaveBeenCalledTimes(1);
  });
});
