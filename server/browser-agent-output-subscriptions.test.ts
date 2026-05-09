import { describe, expect, it, vi } from 'vitest';

import { createBrowserAgentOutputSubscriptions } from './browser-agent-output-subscriptions.js';

interface TestClient {
  open: boolean;
}

function createClient(): TestClient {
  return { open: true };
}

describe('browser agent output subscriptions', () => {
  it('sends scrollback before subscribing to live output', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    const subscribeToAgent = vi.fn(() => true);
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentCols: () => 120,
      getAgentScrollback: () => 'previous output',
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent,
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');

    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'scrollback',
      agentId: 'agent-1',
      cols: 120,
      data: 'previous output',
    });
    expect(subscribeToAgent).toHaveBeenCalledTimes(1);
  });

  it('forwards live output only while the client is open', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    let outputCallback: ((data: string) => void) | null = null;
    function emitOutput(data: string): void {
      if (!outputCallback) {
        throw new Error('Output callback was not registered');
      }

      outputCallback(data);
    }

    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent: (_agentId, callback) => {
        outputCallback = callback;
        return true;
      },
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');

    emitOutput('line 1\n');
    client.open = false;
    emitOutput('line 2\n');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'output',
      agentId: 'agent-1',
      data: 'line 1\n',
    });
  });

  it('ignores duplicate subscriptions for the same client and agent', () => {
    const client = createClient();
    const subscribeToAgent = vi.fn(() => true);
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage: vi.fn(() => true),
      subscribeToAgent,
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');
    subscriptions.subscribe(client, 'agent-1');

    expect(subscribeToAgent).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes live output on explicit unsubscribe and client cleanup', () => {
    const client = createClient();
    const callbacks = new Map<string, (data: string) => void>();
    const unsubscribeFromAgent = vi.fn();
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage: vi.fn(() => true),
      subscribeToAgent: (agentId, callback) => {
        callbacks.set(agentId, callback);
        return true;
      },
      unsubscribeFromAgent,
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');
    subscriptions.subscribe(client, 'agent-2');
    subscriptions.unsubscribe(client, 'agent-1');
    subscriptions.cleanupClient(client);

    expect(unsubscribeFromAgent).toHaveBeenCalledWith('agent-1', callbacks.get('agent-1'));
    expect(unsubscribeFromAgent).toHaveBeenCalledWith('agent-2', callbacks.get('agent-2'));
    expect(unsubscribeFromAgent).toHaveBeenCalledTimes(2);
  });
});
