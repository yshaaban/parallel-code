import type { ServerMessage } from '../electron/remote/protocol.js';

export type AgentCommandResult = Extract<ServerMessage, { type: 'agent-command-result' }>;
export type AgentCommandResultCommand = AgentCommandResult['command'];

export interface AgentCommandRequest {
  agentId: string;
  requestId: string;
  type: AgentCommandResultCommand;
}

interface CachedAgentCommandResult {
  expiresAt: number;
  result: AgentCommandResult;
}

export interface BrowserAgentCommandResultCache<Client> {
  cache: (client: Client, result: AgentCommandResult) => void;
  cleanup: () => void;
  get: (client: Client, request: AgentCommandRequest | undefined) => AgentCommandResult | null;
  pruneExpired: (now?: number) => void;
}

export interface CreateBrowserAgentCommandResultCacheOptions<Client> {
  getClientId: (client: Client) => string | null;
  maxResultsPerClient?: number;
  ttlMs?: number;
}

const DEFAULT_AGENT_COMMAND_RESULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_CACHED_AGENT_COMMAND_RESULTS_PER_CLIENT = 256;

function getAgentCommandResultCacheKey(result: {
  agentId: string;
  command: AgentCommandResultCommand;
  requestId: string;
}): string {
  return `${result.command}:${result.agentId}:${result.requestId}`;
}

export function createAgentCommandResult(
  request: AgentCommandRequest,
  accepted: boolean,
  reason?: string,
): AgentCommandResult {
  return {
    accepted,
    agentId: request.agentId,
    command: request.type,
    ...(reason ? { message: reason } : {}),
    requestId: request.requestId,
    type: 'agent-command-result',
  };
}

export function getAgentCommandRequest(message: {
  agentId: string;
  requestId?: string;
  type?: 'input' | 'resize';
}): AgentCommandRequest | undefined {
  if (!message.requestId || !message.type) {
    return undefined;
  }

  return {
    agentId: message.agentId,
    requestId: message.requestId,
    type: message.type,
  };
}

export function createBrowserAgentCommandResultCache<Client>(
  options: CreateBrowserAgentCommandResultCacheOptions<Client>,
): BrowserAgentCommandResultCache<Client> {
  const cachedAgentCommandResults = new Map<string, Map<string, CachedAgentCommandResult>>();
  const cachedAgentCommandResultPruneTimers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  const ttlMs = options.ttlMs ?? DEFAULT_AGENT_COMMAND_RESULT_CACHE_TTL_MS;
  const maxResultsPerClient =
    options.maxResultsPerClient ?? DEFAULT_MAX_CACHED_AGENT_COMMAND_RESULTS_PER_CLIENT;

  function clearPruneTimer(clientId: string): void {
    const pruneTimer = cachedAgentCommandResultPruneTimers.get(clientId);
    if (!pruneTimer) {
      return;
    }

    globalThis.clearTimeout(pruneTimer);
    cachedAgentCommandResultPruneTimers.delete(clientId);
  }

  function schedulePrune(
    clientId: string,
    entries: Map<string, CachedAgentCommandResult>,
    now: number,
  ): void {
    clearPruneTimer(clientId);
    if (entries.size === 0) {
      return;
    }

    let nextExpiresAt = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      nextExpiresAt = Math.min(nextExpiresAt, entry.expiresAt);
    }

    const delayMs = Math.max(nextExpiresAt - now, 0);
    const pruneTimer = globalThis.setTimeout(() => {
      cachedAgentCommandResultPruneTimers.delete(clientId);
      pruneExpired(Date.now());
    }, delayMs);
    cachedAgentCommandResultPruneTimers.set(clientId, pruneTimer);
  }

  function pruneExpired(now = Date.now()): void {
    for (const [clientId, entries] of cachedAgentCommandResults) {
      let hasExpiredEntry = false;
      for (const [cacheKey, entry] of entries) {
        if (entry.expiresAt > now) {
          continue;
        }

        hasExpiredEntry = true;
        entries.delete(cacheKey);
      }

      if (entries.size === 0) {
        clearPruneTimer(clientId);
        cachedAgentCommandResults.delete(clientId);
        continue;
      }

      if (hasExpiredEntry || !cachedAgentCommandResultPruneTimers.has(clientId)) {
        schedulePrune(clientId, entries, now);
      }
    }
  }

  function get(
    client: Client,
    request: AgentCommandRequest | undefined,
  ): AgentCommandResult | null {
    if (!request) {
      return null;
    }

    const clientId = options.getClientId(client);
    if (!clientId) {
      return null;
    }

    pruneExpired();
    const entry = cachedAgentCommandResults.get(clientId)?.get(
      getAgentCommandResultCacheKey({
        agentId: request.agentId,
        command: request.type,
        requestId: request.requestId,
      }),
    );
    return entry?.result ?? null;
  }

  function cache(client: Client, result: AgentCommandResult): void {
    const clientId = options.getClientId(client);
    if (!clientId) {
      return;
    }

    const now = Date.now();
    pruneExpired(now);
    const entries = cachedAgentCommandResults.get(clientId) ?? new Map();
    entries.set(getAgentCommandResultCacheKey(result), {
      expiresAt: now + ttlMs,
      result,
    });

    while (entries.size > maxResultsPerClient) {
      const oldestCacheKey = entries.keys().next().value;
      if (typeof oldestCacheKey !== 'string') {
        break;
      }
      entries.delete(oldestCacheKey);
    }

    cachedAgentCommandResults.set(clientId, entries);
    schedulePrune(clientId, entries, now);
  }

  function cleanup(): void {
    for (const clientId of [...cachedAgentCommandResultPruneTimers.keys()]) {
      clearPruneTimer(clientId);
    }
    cachedAgentCommandResults.clear();
  }

  return {
    cache,
    cleanup,
    get,
    pruneExpired,
  };
}
