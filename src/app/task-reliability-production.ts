import { IPC } from '../../electron/ipc/channels.js';
import { listenRendererEvent } from '../lib/ipc-events.js';
import { invoke, invokeWithAbortSignal } from '../lib/ipc.js';
import {
  createTaskReliabilityClient,
  type TaskReliabilityClient,
  type TaskReliabilityRawTransport,
} from './task-reliability-client.js';

const CAPABILITY_HANDLER_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 400, 400]);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isActivationPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no handler registered|no handler for|not registered|unknown ipc channel/iu.test(message);
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const rejectAborted = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', rejectAborted);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', rejectAborted, { once: true });
    // Abort may happen after the first check but before the listener is
    // installed. AbortSignal does not replay an already-dispatched event.
    if (signal?.aborted) rejectAborted();
  });
}

function readCapabilities(signal?: AbortSignal): Promise<unknown> {
  return signal
    ? invokeWithAbortSignal(IPC.GetTaskReliabilityCapabilities, signal)
    : invoke(IPC.GetTaskReliabilityCapabilities);
}

async function readCapabilitiesAfterActivation(signal?: AbortSignal): Promise<unknown> {
  for (const delayMs of CAPABILITY_HANDLER_RETRY_DELAYS_MS) {
    try {
      return await readCapabilities(signal);
    } catch (error) {
      if (!isActivationPendingError(error)) throw error;
      await waitForRetry(delayMs, signal);
    }
  }
  return readCapabilities(signal);
}

/** One typed renderer facade shared by Electron and standalone browser hosts. */
export function createProductionTaskReliabilityClient(): TaskReliabilityClient {
  const transport: TaskReliabilityRawTransport = {
    agentSessions: {
      execute: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.ExecuteAgentSessionOperation, signal, request)
          : invoke(IPC.ExecuteAgentSessionOperation, request),
      getProjection: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.GetAgentSessionOperationProjection, signal, request)
          : invoke(IPC.GetAgentSessionOperationProjection, request),
    },
    capabilities: { read: readCapabilitiesAfterActivation },
    initialPromptDelivery: {
      getProjection: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.GetInitialPromptDeliveryProjection, signal, request)
          : invoke(IPC.GetInitialPromptDeliveryProjection, request),
      resolveAmbiguity: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.ResolveInitialPromptAmbiguity, signal, request)
          : invoke(IPC.ResolveInitialPromptAmbiguity, request),
      reviseDraft: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.ReviseInitialPromptDraft, signal, request)
          : invoke(IPC.ReviseInitialPromptDraft, request),
      sendManually: (request, signal) =>
        signal
          ? invokeWithAbortSignal(IPC.SendInitialPromptManually, signal, request)
          : invoke(IPC.SendInitialPromptManually, request),
    },
    liveEvents: {
      subscribe: (listener) => listenRendererEvent(IPC.TaskReliabilityChanged, listener),
    },
  };
  return createTaskReliabilityClient(transport);
}

let singleton: TaskReliabilityClient | null = null;

export function getProductionTaskReliabilityClient(): TaskReliabilityClient {
  singleton ??= createProductionTaskReliabilityClient();
  return singleton;
}

export function disposeProductionTaskReliabilityClientForTests(): void {
  singleton?.dispose();
  singleton = null;
}
