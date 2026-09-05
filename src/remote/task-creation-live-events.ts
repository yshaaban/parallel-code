import type {
  GetTaskCreationOperationRequest,
  TaskCreationOperationLiveEventSource,
  TaskCreationOperationLiveMessage,
} from '../domain/task-creation';
import { isTaskCreationOperationServerMessage } from '../../electron/remote/task-creation-message';
import {
  registerRemoteTaskCreationOperationFrameHandler,
  send,
  status,
  subscribeRemoteAuthenticationExpired,
  subscribeRemoteConnectionStatus,
  type RemoteTaskCreationOperationServerMessage,
} from './ws';

interface OperationSubscription {
  listeners: Set<(message: TaskCreationOperationLiveMessage) => void>;
  operationCapability: GetTaskCreationOperationRequest['operationCapability'];
}

const MAX_OPERATION_SUBSCRIPTIONS = 8;
const subscriptions = new Map<
  GetTaskCreationOperationRequest['operationId'],
  OperationSubscription
>();
let transportCleanup: (() => void) | null = null;

function sendSubscription(
  operationId: GetTaskCreationOperationRequest['operationId'],
  operationCapability: GetTaskCreationOperationRequest['operationCapability'],
): void {
  send({
    type: 'subscribe-task-creation-operation',
    operationCapability,
    operationId,
  });
}

function notifySubscription(
  operationId: GetTaskCreationOperationRequest['operationId'],
  message: TaskCreationOperationLiveMessage,
): void {
  for (const listener of subscriptions.get(operationId)?.listeners ?? []) listener(message);
}

function handleServerMessage(message: RemoteTaskCreationOperationServerMessage): void {
  if (message.type === 'task-creation-operation-snapshot') {
    notifySubscription(message.snapshot.operationId, {
      kind: 'snapshot',
      snapshot: message.snapshot,
    });
  } else {
    notifySubscription(message.operationId, {
      kind: 'subscription-state',
      state: message.state,
    });
  }
}

function ensureTransport(): void {
  if (transportCleanup) return;
  const cleanups = [
    registerRemoteTaskCreationOperationFrameHandler(
      isTaskCreationOperationServerMessage,
      handleServerMessage,
    ),
    subscribeRemoteConnectionStatus((connectionStatus) => {
      const message = {
        kind: 'connection-state',
        state: connectionStatus === 'connected' ? 'connected' : 'disconnected',
      } as const satisfies TaskCreationOperationLiveMessage;
      for (const subscription of subscriptions.values()) {
        for (const listener of subscription.listeners) listener(message);
      }
      if (connectionStatus === 'connected') {
        for (const [operationId, subscription] of subscriptions) {
          sendSubscription(operationId, subscription.operationCapability);
        }
      }
    }),
    subscribeRemoteAuthenticationExpired(() => {
      subscriptions.clear();
      releaseTransport();
    }),
  ];
  transportCleanup = () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function releaseTransport(): void {
  const cleanup = transportCleanup;
  transportCleanup = null;
  cleanup?.();
}

export const remoteTaskCreationOperationLiveEvents: TaskCreationOperationLiveEventSource = {
  subscribe(request, listener) {
    const existing = subscriptions.get(request.operationId);
    if (
      (existing && existing.operationCapability !== request.operationCapability) ||
      (!existing && subscriptions.size >= MAX_OPERATION_SUBSCRIPTIONS)
    ) {
      listener({ kind: 'connection-state', state: 'disconnected' });
      listener({ kind: 'subscription-state', state: 'degraded' });
      return () => undefined;
    }

    ensureTransport();
    const subscription = existing ?? {
      listeners: new Set<(message: TaskCreationOperationLiveMessage) => void>(),
      operationCapability: request.operationCapability,
    };
    if (!existing) subscriptions.set(request.operationId, subscription);
    subscription.listeners.add(listener);
    listener({
      kind: 'connection-state',
      state: status() === 'connected' ? 'connected' : 'disconnected',
    });
    if (!existing && status() === 'connected') {
      sendSubscription(request.operationId, request.operationCapability);
    }

    return () => {
      const current = subscriptions.get(request.operationId);
      if (current !== subscription) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      subscriptions.delete(request.operationId);
      send({
        type: 'unsubscribe-task-creation-operation',
        operationId: request.operationId,
      });
      if (subscriptions.size === 0) releaseTransport();
    };
  },
};
