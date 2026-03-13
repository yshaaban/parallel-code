export async function runQueuedRefresh(
  key: string,
  inFlightRefreshes: Map<string, Promise<void>>,
  pendingRefreshes: Set<string>,
  refresh: () => Promise<void>,
): Promise<void> {
  const inFlight = inFlightRefreshes.get(key);
  if (inFlight) {
    pendingRefreshes.add(key);
    await inFlight;
    return;
  }

  while (true) {
    pendingRefreshes.delete(key);

    const refreshPromise = refresh().finally(() => {
      if (inFlightRefreshes.get(key) === refreshPromise) {
        inFlightRefreshes.delete(key);
      }
    });

    inFlightRefreshes.set(key, refreshPromise);
    await refreshPromise;

    if (!pendingRefreshes.delete(key)) {
      return;
    }
  }
}
