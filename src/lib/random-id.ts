let fallbackIdCounter = 0;

function getRuntimeCrypto(): Crypto | undefined {
  return globalThis.crypto;
}

function formatUuidBytes(bytes: Uint8Array): string {
  return [
    bytes.slice(0, 4),
    bytes.slice(4, 6),
    bytes.slice(6, 8),
    bytes.slice(8, 10),
    bytes.slice(10, 16),
  ]
    .map((part) => Array.from(part, (byte) => byte.toString(16).padStart(2, '0')).join(''))
    .join('-');
}

function createUuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuidBytes(bytes);
}

function createUuidFromRandomValues(cryptoSource: Crypto): string {
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  return createUuidFromBytes(bytes);
}

function createFallbackUuid(): string {
  fallbackIdCounter += 1;
  const bytes = new Uint8Array(16);
  const now = Date.now();

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  bytes[0] = (bytes[0] ?? 0) ^ ((now >>> 24) & 0xff);
  bytes[1] = (bytes[1] ?? 0) ^ ((now >>> 16) & 0xff);
  bytes[2] = (bytes[2] ?? 0) ^ ((now >>> 8) & 0xff);
  bytes[3] = (bytes[3] ?? 0) ^ (now & 0xff);
  bytes[4] = (bytes[4] ?? 0) ^ (fallbackIdCounter & 0xff);
  bytes[5] = (bytes[5] ?? 0) ^ ((fallbackIdCounter >>> 8) & 0xff);
  return createUuidFromBytes(bytes);
}

export function createRandomId(): string {
  const cryptoSource = getRuntimeCrypto();

  if (typeof cryptoSource?.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }

  if (typeof cryptoSource?.getRandomValues === 'function') {
    return createUuidFromRandomValues(cryptoSource);
  }

  return createFallbackUuid();
}

export function resetRandomIdStateForTests(): void {
  fallbackIdCounter = 0;
}
