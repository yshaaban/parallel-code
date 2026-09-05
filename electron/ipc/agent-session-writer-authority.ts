import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

const MAX_ACTIVE_RESERVATIONS = 1_024;

export type AgentSessionWriterPurpose =
  | 'agent-session-operation'
  | 'coordinator-session'
  | 'desktop-compatibility'
  | 'task-shell-session'
  | 'startup-restore';

export interface AgentSessionGenerationReservationRequest {
  agentId: string;
  durableSourceGeneration?: number;
  expectedSourceGeneration: number | null;
  operationId: string;
  purpose: AgentSessionWriterPurpose;
  targetGeneration: number;
  taskId: string;
}

export interface AgentSessionSpawnPermit {
  readonly agentId: string;
  readonly operationId: string;
  readonly targetGeneration: number;
  readonly taskId: string;
}

export interface AgentSessionWriterRuntime {
  activate(cutoverEpoch: string): void;
  allocate(
    request: AgentSessionGenerationReservationRequest,
  ): 'allocated' | 'already-allocated' | 'stale';
  assertSpawnPermit(
    permit: AgentSessionSpawnPermit | undefined,
    request: { agentId: string; taskId: string },
  ): void;
  executeAllocated<TResult>(
    operationId: string,
    effect: (permit: AgentSessionSpawnPermit) => Promise<TResult>,
  ): Promise<TResult>;
  getCutoverEpoch(): string | null;
  isActive(): boolean;
  release(operationId: string): void;
  verify(cutoverEpoch: string): void;
}

interface Reservation {
  fingerprint: string;
  permit: AgentSessionSpawnPermit;
  request: AgentSessionGenerationReservationRequest;
}

function isIdentifier(value: string): boolean {
  return (
    value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512 && !value.includes('\u0000')
  );
}

function assertGeneration(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative safe integer or null`);
  }
}

function validateReservation(request: AgentSessionGenerationReservationRequest): void {
  if (
    !isIdentifier(request.agentId) ||
    !isIdentifier(request.operationId) ||
    !isIdentifier(request.taskId)
  ) {
    throw new TypeError('Agent-session writer identity is invalid');
  }
  assertGeneration(request.expectedSourceGeneration, 'expectedSourceGeneration');
  assertGeneration(request.durableSourceGeneration ?? null, 'durableSourceGeneration');
  assertGeneration(request.targetGeneration, 'targetGeneration');
  const isStartupRestore = request.purpose === 'startup-restore';
  if (
    isStartupRestore !== (request.durableSourceGeneration !== undefined) ||
    (isStartupRestore && request.expectedSourceGeneration !== null)
  ) {
    throw new TypeError(
      'Startup restore requires one durable source generation and no process-local source',
    );
  }
  const expectedTarget =
    (isStartupRestore ? request.durableSourceGeneration : request.expectedSourceGeneration) ?? -1;
  if (request.targetGeneration !== expectedTarget + 1) {
    throw new TypeError('Agent-session writer target generation is not the next generation');
  }
}

function reservationFingerprint(request: AgentSessionGenerationReservationRequest): string {
  return canonicalJsonStringify(request as unknown as JsonObject);
}

/**
 * Process-local generation admission used by every PTY-creating owner after
 * the persisted cutover. It does not spawn processes itself; the unforgeable
 * permit is checked again by the low-level spawn workflow immediately before
 * process creation.
 */
export function createAgentSessionWriterRuntime(options: {
  getCurrentGeneration(agentId: string): number | null;
}): AgentSessionWriterRuntime {
  const reservationsByOperation = new Map<string, Reservation>();
  const operationIdByAgent = new Map<string, string>();
  const inFlightByOperation = new Map<string, Promise<unknown>>();
  const permitReservations = new WeakMap<object, Reservation>();
  let cutoverEpoch: string | null = null;

  function requireActive(): void {
    if (!cutoverEpoch) throw new Error('Agent-session managed writer is not active');
  }

  function release(reservation: Reservation): void {
    if (reservationsByOperation.get(reservation.request.operationId) === reservation) {
      reservationsByOperation.delete(reservation.request.operationId);
    }
    if (operationIdByAgent.get(reservation.request.agentId) === reservation.request.operationId) {
      operationIdByAgent.delete(reservation.request.agentId);
    }
  }

  return {
    activate(epoch) {
      if (!isIdentifier(epoch)) throw new TypeError('Agent-session cutover epoch is invalid');
      if (cutoverEpoch && cutoverEpoch !== epoch) {
        throw new Error('Agent-session writer is already bound to another cutover epoch');
      }
      cutoverEpoch = epoch;
    },

    allocate(request) {
      requireActive();
      validateReservation(request);
      const fingerprint = reservationFingerprint(request);
      const existing = reservationsByOperation.get(request.operationId);
      if (existing) {
        return existing.fingerprint === fingerprint ? 'already-allocated' : 'stale';
      }
      if (reservationsByOperation.size >= MAX_ACTIVE_RESERVATIONS) return 'stale';
      const activeOperation = operationIdByAgent.get(request.agentId);
      if (activeOperation && activeOperation !== request.operationId) return 'stale';
      if (options.getCurrentGeneration(request.agentId) !== request.expectedSourceGeneration) {
        return 'stale';
      }
      const permit = Object.freeze({
        agentId: request.agentId,
        operationId: request.operationId,
        targetGeneration: request.targetGeneration,
        taskId: request.taskId,
      });
      const reservation = { fingerprint, permit, request: structuredClone(request) };
      reservationsByOperation.set(request.operationId, reservation);
      operationIdByAgent.set(request.agentId, request.operationId);
      permitReservations.set(permit, reservation);
      return 'allocated';
    },

    assertSpawnPermit(permit, request) {
      if (!cutoverEpoch) return;
      if (!permit || typeof permit !== 'object') {
        throw new Error('Agent-session process creation requires managed writer admission');
      }
      const reservation = permitReservations.get(permit as object);
      if (
        !reservation ||
        reservationsByOperation.get(reservation.request.operationId) !== reservation ||
        reservation.request.agentId !== request.agentId ||
        reservation.request.taskId !== request.taskId
      ) {
        throw new Error('Agent-session managed writer admission is stale or mismatched');
      }
    },

    executeAllocated<TResult>(
      operationId: string,
      effect: (permit: AgentSessionSpawnPermit) => Promise<TResult>,
    ): Promise<TResult> {
      requireActive();
      const existing = inFlightByOperation.get(operationId);
      if (existing) return existing as Promise<TResult>;
      const reservation = reservationsByOperation.get(operationId);
      if (!reservation) {
        return Promise.reject(new Error('Agent-session generation reservation is unavailable'));
      }
      const promise = Promise.resolve()
        .then(() => effect(reservation.permit))
        .finally(() => {
          if (inFlightByOperation.get(operationId) === promise) {
            inFlightByOperation.delete(operationId);
          }
          release(reservation);
        });
      inFlightByOperation.set(operationId, promise);
      return promise;
    },

    getCutoverEpoch: () => cutoverEpoch,
    isActive: () => cutoverEpoch !== null,
    release(operationId) {
      if (inFlightByOperation.has(operationId)) return;
      const reservation = reservationsByOperation.get(operationId);
      if (reservation) release(reservation);
    },
    verify(epoch) {
      if (!cutoverEpoch || cutoverEpoch !== epoch) {
        throw new Error('Agent-session writer cutover epoch is unavailable or mismatched');
      }
    },
  };
}
