function getClientStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function getPersistentClientId(storageKey: string, fallbackClientId: string): string {
  const storage = getClientStorage();
  if (!storage) return fallbackClientId;

  const existing = storage.getItem(storageKey);
  if (existing) return existing;

  const clientId = crypto.randomUUID();
  storage.setItem(storageKey, clientId);
  return clientId;
}
