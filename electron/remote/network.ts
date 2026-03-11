import { networkInterfaces } from 'os';

export interface NetworkIps {
  tailscale: string | null;
  wifi: string | null;
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
