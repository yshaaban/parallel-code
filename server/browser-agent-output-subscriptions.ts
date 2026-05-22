import {
  getAgentCols,
  getAgentScrollback,
  subscribeToAgent,
  unsubscribeFromAgent,
} from '../electron/ipc/pty.js';
import type { ServerMessage, SubscribeCommand } from '../electron/remote/protocol.js';

type AgentOutputCallback = (data: string) => void;
type TerminalSubscriptionProtocol = NonNullable<SubscribeCommand['terminalProtocol']>;

interface AgentOutputSubscription {
  callback: AgentOutputCallback;
  degraded: boolean;
  terminalProtocol: TerminalSubscriptionProtocol;
}

type AgentOutputSubscriptions = Map<string, AgentOutputSubscription>;

export interface BrowserAgentOutputExitData {
  exitCode?: number | null;
  lastOutput?: string[];
  signal?: unknown;
}

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
  emitExit: (agentId: string, data?: BrowserAgentOutputExitData) => void;
  registerClient: (client: Client) => void;
  resume: (client: Client, agentId: string) => void;
  subscribe: (
    client: Client,
    agentId: string,
    terminalProtocol?: TerminalSubscriptionProtocol,
  ) => void;
  unsubscribe: (client: Client, agentId: string) => void;
}

function createTerminalExitData(data: BrowserAgentOutputExitData): {
  exit_code: number | null;
  last_output: string[];
  signal: string | null;
} {
  return {
    exit_code: data.exitCode ?? null,
    last_output: Array.isArray(data.lastOutput) ? data.lastOutput : [],
    signal: data.signal === null || data.signal === undefined ? null : String(data.signal),
  };
}

export function createBrowserAgentOutputSubscriptions<Client extends object>(
  options: CreateBrowserAgentOutputSubscriptionsOptions<Client>,
): BrowserAgentOutputSubscriptions<Client> {
  const subscriptionsByClient = new WeakMap<Client, AgentOutputSubscriptions>();
  const registeredClients = new Set<Client>();
  const readAgentCols = options.getAgentCols ?? getAgentCols;
  const readAgentScrollback = options.getAgentScrollback ?? getAgentScrollback;
  const subscribeAgent = options.subscribeToAgent ?? subscribeToAgent;
  const unsubscribeAgent = options.unsubscribeFromAgent ?? unsubscribeFromAgent;

  function registerClient(client: Client): void {
    cleanupClient(client);
    registeredClients.add(client);
    subscriptionsByClient.set(client, new Map());
  }

  function cleanupClient(client: Client): void {
    const subscriptions = subscriptionsByClient.get(client);
    if (!subscriptions) {
      return;
    }

    for (const [agentId, subscription] of subscriptions) {
      unsubscribeAgent(agentId, subscription.callback);
    }
    subscriptions.clear();
    subscriptionsByClient.delete(client);
    registeredClients.delete(client);
  }

  function emitExit(agentId: string, data: BrowserAgentOutputExitData = {}): void {
    for (const client of registeredClients) {
      const subscriptions = subscriptionsByClient.get(client);
      const subscription = subscriptions?.get(agentId);
      if (!subscriptions || !subscription) {
        continue;
      }

      if (subscription.terminalProtocol === 'structured' && options.isClientOpen(client)) {
        options.sendMessage(client, {
          type: 'terminal-stream',
          agentId,
          event: {
            type: 'Exit',
            data: createTerminalExitData(data),
          },
        });
      }

      subscriptions.delete(agentId);
    }
  }

  function sendRecoveryRequired(client: Client, agentId: string): void {
    options.sendMessage(client, {
      type: 'terminal-stream',
      agentId,
      event: {
        type: 'RecoveryRequired',
        reason: 'backpressure',
      },
    });
  }

  function sendStructuredData(
    client: Client,
    agentId: string,
    subscription: AgentOutputSubscription,
    data: string,
  ): void {
    if (subscription.degraded) {
      return;
    }

    const sent = options.sendMessage(client, {
      type: 'terminal-stream',
      agentId,
      event: {
        type: 'Data',
        data,
      },
    });
    if (sent) {
      return;
    }

    subscription.degraded = true;
    sendRecoveryRequired(client, agentId);
  }

  function subscribe(
    client: Client,
    agentId: string,
    terminalProtocol: TerminalSubscriptionProtocol = 'legacy',
  ): void {
    const subscriptions = subscriptionsByClient.get(client);
    if (!subscriptions || subscriptions.has(agentId)) {
      return;
    }

    if (terminalProtocol === 'legacy') {
      const scrollback = readAgentScrollback(agentId);
      if (scrollback) {
        options.sendMessage(client, {
          type: 'scrollback',
          agentId,
          data: scrollback,
          cols: readAgentCols(agentId),
        });
      }
    }

    const callback = (data: string) => {
      const subscription = subscriptionsByClient.get(client)?.get(agentId);
      if (!subscription || subscription.callback !== callback) {
        return;
      }

      if (!options.isClientOpen(client)) {
        return;
      }

      if (terminalProtocol === 'structured') {
        sendStructuredData(client, agentId, subscription, data);
        return;
      }

      options.sendMessage(client, {
        type: 'output',
        agentId,
        data,
      });
    };

    if (subscribeAgent(agentId, callback)) {
      subscriptions.set(agentId, {
        callback,
        degraded: false,
        terminalProtocol,
      });
    }
  }

  function resume(client: Client, agentId: string): void {
    const subscription = subscriptionsByClient.get(client)?.get(agentId);
    if (subscription) {
      subscription.degraded = false;
    }
  }

  function unsubscribe(client: Client, agentId: string): void {
    const subscriptions = subscriptionsByClient.get(client);
    const subscription = subscriptions?.get(agentId);
    if (!subscription) {
      return;
    }

    unsubscribeAgent(agentId, subscription.callback);
    subscriptions?.delete(agentId);
  }

  return {
    cleanupClient,
    emitExit,
    registerClient,
    resume,
    subscribe,
    unsubscribe,
  };
}
