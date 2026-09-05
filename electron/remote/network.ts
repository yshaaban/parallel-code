import { networkInterfaces } from 'os';
import { isIP } from 'net';

export interface NetworkIps {
  tailscale: string | null;
  wifi: string | null;
}

export interface RemotePeerSocketAddress {
  localAddress?: string;
  remoteAddress?: string;
}

export interface RemotePeerTrustPolicy {
  allowedInterfaces: readonly string[];
  allowedPeerRanges: readonly string[];
}

const SAFE_INTERFACE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;

interface ParsedAddress {
  bytes: Uint8Array;
  family: 4 | 6;
}

interface ParsedRange extends ParsedAddress {
  prefix: number;
}

function parseIpv4(value: string): ParsedAddress | null {
  const components = value.split('.');
  if (components.length !== 4) return null;
  const bytes = components.map((component) => {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(component)) return -1;
    const byte = Number(component);
    return byte <= 255 ? byte : -1;
  });
  return bytes.some((byte) => byte < 0) ? null : { bytes: Uint8Array.from(bytes), family: 4 };
}

function parseIpv6(value: string): ParsedAddress | null {
  if (value.includes('%') || value.toLowerCase().startsWith('::ffff:')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const expand = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const component of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/iu.test(component)) return null;
      words.push(Number.parseInt(component, 16));
    }
    return words;
  };
  const left = expand(halves[0] ?? '');
  const right = expand(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return { bytes, family: 6 };
}

function parseAddress(value: string | undefined): ParsedAddress | null {
  if (!value || value.includes('%') || value.toLowerCase().startsWith('::ffff:')) return null;
  const family = isIP(value);
  return family === 4 ? parseIpv4(value) : family === 6 ? parseIpv6(value) : null;
}

function parseRange(value: string): ParsedRange | null {
  const [addressSource, prefixSource, ...extra] = value.split('/');
  if (!addressSource || extra.length > 0) return null;
  const address = parseAddress(addressSource);
  if (!address) return null;
  const maxPrefix = address.family === 4 ? 32 : 128;
  const prefix = prefixSource === undefined ? maxPrefix : Number(prefixSource);
  return Number.isSafeInteger(prefix) && prefix >= 0 && prefix <= maxPrefix
    ? { ...address, prefix }
    : null;
}

function isInRange(address: ParsedAddress, range: ParsedRange): boolean {
  if (address.family !== range.family) return false;
  const fullBytes = Math.floor(range.prefix / 8);
  const remainder = range.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (address.bytes[index] !== range.bytes[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((address.bytes[fullBytes] ?? 0) & mask) === ((range.bytes[fullBytes] ?? 0) & mask);
}

function interfaceOwnsAddress(interfaceName: string, address: ParsedAddress): boolean {
  const entries = networkInterfaces()[interfaceName] ?? [];
  return entries.some((entry) => {
    const candidate = parseAddress(entry.address);
    return (
      candidate?.family === address.family &&
      candidate.bytes.every((byte, index) => byte === address.bytes[index])
    );
  });
}

/**
 * Validates only kernel-observed socket addresses and current interface state.
 * Forwarding, Host, Origin, and DNS headers deliberately never enter trust.
 */
export function validateRemotePeerSocket(
  socket: RemotePeerSocketAddress,
  policy: RemotePeerTrustPolicy | null | undefined,
): boolean {
  if (!policy || !isValidRemotePeerTrustPolicy(policy)) {
    return false;
  }
  const local = parseAddress(socket.localAddress);
  const remote = parseAddress(socket.remoteAddress);
  if (!local || !remote) return false;
  if (!policy.allowedInterfaces.some((name) => interfaceOwnsAddress(name, local))) return false;
  const ranges = policy.allowedPeerRanges.map(parseRange);
  if (ranges.some((range) => range === null)) return false;
  return ranges.some((range) => range !== null && isInRange(remote, range));
}

export function isValidRemotePeerTrustPolicy(policy: RemotePeerTrustPolicy): boolean {
  return (
    policy.allowedInterfaces.length >= 1 &&
    policy.allowedInterfaces.length <= 8 &&
    new Set(policy.allowedInterfaces).size === policy.allowedInterfaces.length &&
    policy.allowedInterfaces.every((name) => SAFE_INTERFACE_NAME.test(name)) &&
    policy.allowedPeerRanges.length >= 1 &&
    policy.allowedPeerRanges.length <= 32 &&
    new Set(policy.allowedPeerRanges).size === policy.allowedPeerRanges.length &&
    policy.allowedPeerRanges.every((range) => parseRange(range) !== null)
  );
}

export function getNetworkIps(): NetworkIps {
  const networks = networkInterfaces();
  let wifi: string | null = null;
  let tailscale: string | null = null;

  for (const addresses of Object.values(networks)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('100.')) {
        tailscale ??= address.address;
        continue;
      }
      if (!address.address.startsWith('172.')) {
        wifi ??= address.address;
      }
    }
  }

  return { tailscale, wifi };
}

export function buildAccessUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}?token=${token}`;
}

export function buildOptionalAccessUrl(
  host: string | null,
  port: number,
  token: string,
): string | null {
  if (!host) return null;
  return buildAccessUrl(host, port, token);
}

export interface SecureSessionBootstrapUrlOptions {
  bootstrapPath?: string;
  nextPath?: string;
}

export function buildSecureSessionBootstrapUrl(
  host: string,
  port: number,
  token: string,
  options: SecureSessionBootstrapUrlOptions = {},
): string {
  const url = new URL(`https://${host}:${port}${options.bootstrapPath ?? '/auth/bootstrap'}`);
  url.searchParams.set('token', token);
  url.searchParams.set('next', options.nextPath ?? '/');
  return url.toString();
}

export function buildOptionalSecureSessionBootstrapUrl(
  host: string | null,
  port: number,
  token: string,
  options: SecureSessionBootstrapUrlOptions = {},
): string | null {
  return host ? buildSecureSessionBootstrapUrl(host, port, token, options) : null;
}
