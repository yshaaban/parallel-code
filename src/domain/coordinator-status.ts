export interface CoordinatorUnsupportedStatus {
  kind: 'unsupported';
  owner: 'none';
  reason: 'backend-owner-missing';
}

export interface CoordinatorDeferredStatus {
  kind: 'deferred';
  owner: 'backend-required';
  reason: 'local-design-required';
  upstreamScope: readonly string[];
}

export type CoordinatorStatus = CoordinatorUnsupportedStatus | CoordinatorDeferredStatus;

export const COORDINATOR_DEFERRED_STATUS = {
  kind: 'deferred',
  owner: 'backend-required',
  reason: 'local-design-required',
  upstreamScope: ['MCP orchestration', 'coordinator UI', 'subtask lifecycle'],
} as const satisfies CoordinatorDeferredStatus;

export const COORDINATOR_UNSUPPORTED_STATUS = {
  kind: 'unsupported',
  owner: 'none',
  reason: 'backend-owner-missing',
} as const satisfies CoordinatorUnsupportedStatus;

export function getCoordinatorStatus(hasBackendOwner: boolean): CoordinatorStatus {
  return hasBackendOwner ? COORDINATOR_DEFERRED_STATUS : COORDINATOR_UNSUPPORTED_STATUS;
}

export function isCoordinatorStatus(value: unknown): value is CoordinatorStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<CoordinatorStatus>;
  if (candidate.kind === 'unsupported') {
    return candidate.owner === 'none' && candidate.reason === 'backend-owner-missing';
  }

  if (candidate.kind === 'deferred') {
    return (
      candidate.owner === 'backend-required' &&
      candidate.reason === 'local-design-required' &&
      Array.isArray(candidate.upstreamScope) &&
      candidate.upstreamScope.every((entry) => typeof entry === 'string')
    );
  }

  return false;
}
