import { setStore, store } from './core';
import type { IncomingTaskTakeoverRequest } from './types';

export function upsertIncomingTaskTakeoverRequest(request: IncomingTaskTakeoverRequest): void {
  setStore('incomingTaskTakeoverRequests', request.requestId, request);
}

export function clearIncomingTaskTakeoverRequest(requestId: string): void {
  if (!store.incomingTaskTakeoverRequests[requestId]) {
    return;
  }

  setStore('incomingTaskTakeoverRequests', (currentRequests) => {
    const nextRequests = { ...currentRequests };
    delete nextRequests[requestId];
    return nextRequests;
  });
}

export function clearIncomingTaskTakeoverRequests(): void {
  if (Object.keys(store.incomingTaskTakeoverRequests).length === 0) {
    return;
  }

  setStore('incomingTaskTakeoverRequests', {});
}

export function hasIncomingTaskTakeoverRequests(): boolean {
  return Object.keys(store.incomingTaskTakeoverRequests).length > 0;
}

export function listIncomingTaskTakeoverRequests(): IncomingTaskTakeoverRequest[] {
  return Object.values(store.incomingTaskTakeoverRequests).sort(
    (left, right) => left.expiresAt - right.expiresAt,
  );
}

export function getIncomingTaskTakeoverRequest(
  requestId: string,
): IncomingTaskTakeoverRequest | null {
  return store.incomingTaskTakeoverRequests[requestId] ?? null;
}
