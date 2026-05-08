export interface ServerStateVersionTracker {
  highestVersion: number;
  versionByKey: Map<string, number>;
}

export interface ServerStateVersionedPayload {
  stateVersion?: number;
}

function isFiniteServerStateVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isFinite(version);
}

export function createServerStateVersionTracker(): ServerStateVersionTracker {
  return {
    highestVersion: -1,
    versionByKey: new Map<string, number>(),
  };
}

export function getServerStatePayloadVersion(
  payload: ServerStateVersionedPayload,
): number | undefined {
  if (!isFiniteServerStateVersion(payload.stateVersion)) {
    return undefined;
  }

  return payload.stateVersion;
}

export function stripServerStatePayloadVersion<TPayload extends ServerStateVersionedPayload>(
  payload: TPayload,
): Omit<TPayload, 'stateVersion'> {
  const copy = { ...payload };
  delete copy.stateVersion;
  return copy as Omit<TPayload, 'stateVersion'>;
}

export function shouldApplyServerStateEventVersion(
  tracker: ServerStateVersionTracker,
  key: string,
  version: number | undefined,
): boolean {
  if (version === undefined) {
    return !tracker.versionByKey.has(key);
  }

  const keyVersion = tracker.versionByKey.get(key) ?? -1;
  return version >= tracker.highestVersion && version >= keyVersion;
}

export function noteServerStateEventVersion(
  tracker: ServerStateVersionTracker,
  key: string,
  version: number | undefined,
): void {
  if (version === undefined) {
    return;
  }

  tracker.highestVersion = Math.max(tracker.highestVersion, version);
  tracker.versionByKey.set(key, version);
}

export function shouldApplyServerStateSnapshotEvent(
  tracker: ServerStateVersionTracker,
  key: string,
  version: number | undefined,
  currentUpdatedAt: number | undefined,
  nextUpdatedAt: number,
): boolean {
  if (!shouldApplyServerStateEventVersion(tracker, key, version)) {
    return false;
  }

  if (version !== undefined) {
    return true;
  }

  if (currentUpdatedAt === undefined) {
    return true;
  }

  return nextUpdatedAt >= currentUpdatedAt;
}

export function shouldApplyServerStateReplacement(
  tracker: ServerStateVersionTracker,
  version: number | undefined,
): boolean {
  return (
    version === undefined ||
    (isFiniteServerStateVersion(version) && version >= tracker.highestVersion)
  );
}

export function noteServerStateReplacement(
  tracker: ServerStateVersionTracker,
  keys: Iterable<string>,
  version: number | undefined,
): void {
  tracker.versionByKey.clear();
  if (version === undefined) {
    tracker.highestVersion = -1;
    return;
  }

  if (!isFiniteServerStateVersion(version)) {
    return;
  }

  tracker.highestVersion = Math.max(tracker.highestVersion, version);
  for (const key of keys) {
    tracker.versionByKey.set(key, version);
  }
}

export function resetServerStateVersionTracker(tracker: ServerStateVersionTracker): void {
  tracker.highestVersion = -1;
  tracker.versionByKey.clear();
}
