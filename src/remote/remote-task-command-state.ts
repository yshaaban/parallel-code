import type { TaskCommandTakeoverResultMessage } from '../../electron/remote/protocol';

type RemoteTaskCommandLeaseOwnership =
  | {
      leaseGeneration?: undefined;
      status: 'idle';
    }
  | {
      leaseGeneration: number;
      status: 'retained';
    };

export interface RemoteTaskCommandLeaseState {
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  ownership: RemoteTaskCommandLeaseOwnership;
  releaseRequested: boolean;
  renewTimer: ReturnType<typeof setInterval> | undefined;
  retainingPromise: Promise<boolean> | undefined;
}

export interface RetainedRemoteTaskCommandLeaseState extends RemoteTaskCommandLeaseState {
  ownership: Extract<RemoteTaskCommandLeaseOwnership, { status: 'retained' }>;
}

export interface RemoteTaskCommandAttempt {
  taskGeneration: number;
  transportGeneration: number;
}

export type RemoteTakeoverDecision =
  | TaskCommandTakeoverResultMessage['decision']
  | 'transport-unavailable';

export interface PendingTakeoverRequest {
  resolve: (decision: RemoteTakeoverDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const localTaskCommandLeases = new Map<string, RemoteTaskCommandLeaseState>();
const sendQueues = new Map<string, Promise<boolean>>();
const taskCommandGenerations = new Map<string, number>();
const pendingTakeovers = new Map<string, PendingTakeoverRequest>();

export function getOrCreateLocalTaskCommandLease(taskId: string): RemoteTaskCommandLeaseState {
  const existingLease = localTaskCommandLeases.get(taskId);
  if (existingLease) {
    return existingLease;
  }

  const nextLease: RemoteTaskCommandLeaseState = {
    idleTimer: undefined,
    ownership: { status: 'idle' },
    releaseRequested: false,
    renewTimer: undefined,
    retainingPromise: undefined,
  };
  localTaskCommandLeases.set(taskId, nextLease);
  return nextLease;
}

export function isRetainedRemoteTaskCommandLease(
  lease: RemoteTaskCommandLeaseState,
): lease is RetainedRemoteTaskCommandLeaseState {
  return lease.ownership.status === 'retained';
}

export function getRetainedRemoteTaskCommandLeaseGeneration(
  lease: RemoteTaskCommandLeaseState,
): number | undefined {
  return isRetainedRemoteTaskCommandLease(lease) ? lease.ownership.leaseGeneration : undefined;
}

export function markRemoteTaskCommandLeaseRetained(
  lease: RemoteTaskCommandLeaseState,
  leaseGeneration: number,
): void {
  lease.ownership = {
    leaseGeneration,
    status: 'retained',
  };
}

export function markRemoteTaskCommandLeaseIdle(lease: RemoteTaskCommandLeaseState): void {
  lease.ownership = { status: 'idle' };
}

export function getLocalTaskCommandLease(taskId: string): RemoteTaskCommandLeaseState | undefined {
  return localTaskCommandLeases.get(taskId);
}

export function getLocalTaskCommandLeaseEntries(): IterableIterator<
  [string, RemoteTaskCommandLeaseState]
> {
  return localTaskCommandLeases.entries();
}

export function getLocalTaskCommandLeaseKeys(): IterableIterator<string> {
  return localTaskCommandLeases.keys();
}

export function getLocalTaskCommandLeaseValues(): IterableIterator<RemoteTaskCommandLeaseState> {
  return localTaskCommandLeases.values();
}

export function hasLocalTaskCommandLeases(): boolean {
  return localTaskCommandLeases.size > 0;
}

export function deleteLocalTaskCommandLease(taskId: string): void {
  localTaskCommandLeases.delete(taskId);
}

export function clearLocalTaskCommandLeases(): void {
  localTaskCommandLeases.clear();
}

export function getTaskCommandGeneration(taskId: string): number {
  return taskCommandGenerations.get(taskId) ?? 0;
}

export function bumpTaskCommandGeneration(taskId: string): number {
  const nextGeneration = getTaskCommandGeneration(taskId) + 1;
  taskCommandGenerations.set(taskId, nextGeneration);
  return nextGeneration;
}

export function clearTaskCommandGenerations(): void {
  taskCommandGenerations.clear();
}

export function getPendingTakeover(requestId: string): PendingTakeoverRequest | undefined {
  return pendingTakeovers.get(requestId);
}

export function setPendingTakeover(
  requestId: string,
  pendingTakeover: PendingTakeoverRequest,
): void {
  pendingTakeovers.set(requestId, pendingTakeover);
}

export function deletePendingTakeover(requestId: string): void {
  pendingTakeovers.delete(requestId);
}

export function getPendingTakeoverKeys(): IterableIterator<string> {
  return pendingTakeovers.keys();
}

export function hasPendingTakeovers(): boolean {
  return pendingTakeovers.size > 0;
}

export function clearPendingTakeovers(): void {
  pendingTakeovers.clear();
}

export function getSendQueue(agentId: string): Promise<boolean> | undefined {
  return sendQueues.get(agentId);
}

export function setSendQueue(agentId: string, nextQueue: Promise<boolean>): void {
  sendQueues.set(agentId, nextQueue);
}

export function deleteSendQueue(agentId: string): void {
  sendQueues.delete(agentId);
}

export function clearSendQueues(): void {
  sendQueues.clear();
}
