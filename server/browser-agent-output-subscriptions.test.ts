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
    const outputCallbacks: Array<(data: string) => void> = [];
    function emitOutput(data: string): void {
      const outputCallback = outputCallbacks[0];
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
        outputCallbacks.push(callback);
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

  it('sends structured terminal Data without legacy scrollback or output', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    const outputCallbacks: Array<(data: string) => void> = [];
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentCols: () => 120,
      getAgentScrollback: () => Buffer.from('previous output', 'utf8').toString('base64'),
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent: (_agentId, callback) => {
        outputCallbacks.push(callback);
        return true;
      },
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1', 'structured');

    const data = Buffer.from('structured output', 'utf8').toString('base64');
    const outputCallback = outputCallbacks[0];
    if (!outputCallback) {
      throw new Error('Output callback was not registered');
    }
    outputCallback(data);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data,
      },
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'scrollback' }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'output' }),
    );
  });

  it('marks structured subscriptions degraded on send failure until recovery resumes them', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    const outputCallbacks: Array<(data: string) => void> = [];
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent: (_agentId, callback) => {
        outputCallbacks.push(callback);
        return true;
      },
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1', 'structured');
    sendMessage.mockReturnValueOnce(false).mockReturnValue(true);

    outputCallbacks[0]?.('first');
    outputCallbacks[0]?.('second');
    subscriptions.resume(client, 'agent-1');
    outputCallbacks[0]?.('third');

    expect(sendMessage).toHaveBeenNthCalledWith(1, client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data: 'first',
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'RecoveryRequired',
        reason: 'backpressure',
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data: 'third',
      },
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('sends structured terminal Exit diagnostics and clears the dead subscription', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    const subscribeToAgent = vi.fn(() => true);
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent,
      unsubscribeFromAgent: vi.fn(),
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1', 'structured');
    subscriptions.emitExit('agent-1', {
      exitCode: 2,
      lastOutput: ['fatal error'],
      signal: null,
    });
    subscriptions.subscribe(client, 'agent-1', 'structured');

    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Exit',
        data: {
          exit_code: 2,
          last_output: ['fatal error'],
          signal: null,
        },
      },
    });
    expect(subscribeToAgent).toHaveBeenCalledTimes(2);
  });

  it('clears legacy subscriptions on terminal exit so same-id respawns can resubscribe', () => {
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
    subscriptions.emitExit('agent-1');
    subscriptions.subscribe(client, 'agent-1');

    expect(subscribeToAgent).toHaveBeenCalledTimes(2);
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

  it('cleans up previous callbacks when the same client is registered again', () => {
    const client = createClient();
    const sendMessage = vi.fn(() => true);
    const callbacks: Array<(data: string) => void> = [];
    const unsubscribeFromAgent = vi.fn();
    const subscriptions = createBrowserAgentOutputSubscriptions<TestClient>({
      getAgentScrollback: () => null,
      isClientOpen: (currentClient) => currentClient.open,
      sendMessage,
      subscribeToAgent: (_agentId, callback) => {
        callbacks.push(callback);
        return true;
      },
      unsubscribeFromAgent,
    });

    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');
    subscriptions.registerClient(client);
    subscriptions.subscribe(client, 'agent-1');

    callbacks[0]?.('stale output');
    callbacks[1]?.('fresh output');

    expect(unsubscribeFromAgent).toHaveBeenCalledWith('agent-1', callbacks[0]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'output',
      agentId: 'agent-1',
      data: 'fresh output',
    });
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
