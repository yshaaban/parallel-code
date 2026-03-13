interface ClientBatch {
  messages: string[];
  timer: NodeJS.Timeout | null;
}

export type BrowserSendQueueResult =
  | { ok: true }
  | {
      ok: false;
      retry: boolean;
    };

export interface CreateBrowserSendQueueOptions<Client> {
  flushIntervalMs?: number;
  send: (client: Client, message: string) => BrowserSendQueueResult;
}

export interface BrowserSendQueue<Client> {
  cleanupClient: (client: Client) => void;
  queueMessage: (client: Client, message: string) => boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 8;

export function createBrowserSendQueue<Client extends object>(
  options: CreateBrowserSendQueueOptions<Client>,
): BrowserSendQueue<Client> {
  const clientBatches = new WeakMap<Client, ClientBatch>();
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  function flushClientBatch(client: Client): void {
    const batch = clientBatches.get(client);
    if (!batch || batch.messages.length === 0) return;

    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    let sentCount = 0;
    for (const message of batch.messages) {
      const result = options.send(client, message);
      if (!result.ok) {
        if (!result.retry) {
          batch.messages = [];
          return;
        }

        batch.messages = batch.messages.slice(sentCount);
        batch.timer = setTimeout(() => {
          flushClientBatch(client);
        }, flushIntervalMs);
        return;
      }
      sentCount += 1;
    }

    batch.messages = [];
  }

  function queueMessage(client: Client, message: string): boolean {
    let batch = clientBatches.get(client);
    if (!batch) {
      batch = { messages: [], timer: null };
      clientBatches.set(client, batch);
    }

    batch.messages.push(message);
    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        flushClientBatch(client);
      }, flushIntervalMs);
    }

    return true;
  }

  function cleanupClient(client: Client): void {
    const batch = clientBatches.get(client);
    if (!batch) return;

    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    clientBatches.delete(client);
  }

  return {
    cleanupClient,
    queueMessage,
  };
}
