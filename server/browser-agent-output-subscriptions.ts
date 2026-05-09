import {
  getAgentCols,
  getAgentScrollback,
  subscribeToAgent,
  unsubscribeFromAgent,
} from '../electron/ipc/pty.js';
import type { ServerMessage } from '../electron/remote/protocol.js';

type AgentOutputCallback = (data: string) => void;
type AgentOutputSubscriptions = Map<string, AgentOutputCallback>;

export interface CreateBrowserAgentOutputSubscriptionsOptions<Client extends object> {
  getAgentCols?: (agentId: string) => number;
  getAgentScrollback?: (agentId: string) => string | null;
  isClientOpen: (client: Client) => boolean;
  sendMessage: (client: Client, message: ServerMessage) => boolean;
  subscribeToAgent?: (agentId: string, callback: AgentOutputCallback) => boolean;
  unsubscribeFromAgent?: (agentId: string, callback: AgentOutputCallback) => void;
}

export interface BrowserAgentOutputSubscriptions<Client extends object> {
  cleanupClient: (client: Client) => void;
  registerClient: (client: Client) => void;
  subscribe: (client: Client, agentId: string) => void;
  unsubscribe: (client: Client, agentId: string) => void;
}

export function createBrowserAgentOutputSubscriptions<Client extends object>(
  options: CreateBrowserAgentOutputSubscriptionsOptions<Client>,
): BrowserAgentOutputSubscriptions<Client> {
  const subscriptionsByClient = new WeakMap<Client, AgentOutputSubscriptions>();
  const readAgentCols = options.getAgentCols ?? getAgentCols;
  const readAgentScrollback = options.getAgentScrollback ?? getAgentScrollback;
  const subscribeAgent = options.subscribeToAgent ?? subscribeToAgent;
  const unsubscribeAgent = options.unsubscribeFromAgent ?? unsubscribeFromAgent;

  function registerClient(client: Client): void {
    subscriptionsByClient.set(client, new Map());
  }

  function cleanupClient(client: Client): void {
    const subscriptions = subscriptionsByClient.get(client);
    if (!subscriptions) {
      return;
    }

    for (const [agentId, callback] of subscriptions) {
      unsubscribeAgent(agentId, callback);
    }
    subscriptions.clear();
    subscriptionsByClient.delete(client);
  }

  function subscribe(client: Client, agentId: string): void {
    const subscriptions = subscriptionsByClient.get(client);
    if (!subscriptions || subscriptions.has(agentId)) {
      return;
    }

    const scrollback = readAgentScrollback(agentId);
    if (scrollback) {
      options.sendMessage(client, {
        type: 'scrollback',
        agentId,
        data: scrollback,
        cols: readAgentCols(agentId),
      });
    }

    const callback = (data: string) => {
      if (!options.isClientOpen(client)) {
        return;
      }

      options.sendMessage(client, {
        type: 'output',
        agentId,
        data,
      });
    };

    if (subscribeAgent(agentId, callback)) {
      subscriptions.set(agentId, callback);
    }
  }

  function unsubscribe(client: Client, agentId: string): void {
    const subscriptions = subscriptionsByClient.get(client);
    const callback = subscriptions?.get(agentId);
    if (!callback) {
      return;
    }

    unsubscribeAgent(agentId, callback);
    subscriptions?.delete(agentId);
  }

  return {
    cleanupClient,
    registerClient,
    subscribe,
    unsubscribe,
  };
}
