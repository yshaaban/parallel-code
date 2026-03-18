export function markBusyTaskCommandTakeoverRequest(
  currentRequestIds: ReadonlySet<string>,
  requestId: string,
): Set<string> {
  if (currentRequestIds.has(requestId)) {
    return currentRequestIds instanceof Set ? currentRequestIds : new Set(currentRequestIds);
  }

  const nextRequestIds = new Set(currentRequestIds);
  nextRequestIds.add(requestId);
  return nextRequestIds;
}

export function clearBusyTaskCommandTakeoverRequest(
  currentRequestIds: ReadonlySet<string>,
  requestId: string,
): Set<string> {
  if (!currentRequestIds.has(requestId)) {
    return currentRequestIds instanceof Set ? currentRequestIds : new Set(currentRequestIds);
  }

  const nextRequestIds = new Set(currentRequestIds);
  nextRequestIds.delete(requestId);
  return nextRequestIds;
}

export function syncBusyTaskCommandTakeoverRequests(
  currentBusyRequestIds: ReadonlySet<string>,
  activeRequestIds: ReadonlySet<string>,
): Set<string> {
  let changed = false;
  const nextBusyRequestIds = new Set<string>();

  for (const requestId of currentBusyRequestIds) {
    if (!activeRequestIds.has(requestId)) {
      changed = true;
      continue;
    }

    nextBusyRequestIds.add(requestId);
  }

  if (!changed && currentBusyRequestIds instanceof Set) {
    return currentBusyRequestIds;
  }

  return nextBusyRequestIds;
}
