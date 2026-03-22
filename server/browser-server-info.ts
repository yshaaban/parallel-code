import {
  buildAccessUrl as buildRemoteAccessUrl,
  buildOptionalAccessUrl as buildOptionalRemoteAccessUrl,
  getNetworkIps,
} from '../electron/remote/network.js';
import type { EnabledRemoteAccessStatus } from '../src/domain/server-state.js';

export interface BrowserServerInfo {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

export type BrowserRemoteStatus = EnabledRemoteAccessStatus;

export interface CreateBrowserServerInfoOptions {
  getAuthenticatedClientCount: () => number;
  getPort: () => number;
  token: string;
}

export interface BrowserServerInfoService {
  buildAccessUrl: (host: string) => string;
  buildOptionalAccessUrl: (host: string | null) => string | null;
  getRemoteStatus: () => BrowserRemoteStatus;
  getServerInfo: () => BrowserServerInfo;
}

export function createBrowserServerInfo(
  options: CreateBrowserServerInfoOptions,
): BrowserServerInfoService {
  function buildAccessUrl(host: string): string {
    return buildRemoteAccessUrl(host, options.getPort(), options.token);
  }

  function buildOptionalAccessUrl(host: string | null): string | null {
    return buildOptionalRemoteAccessUrl(host, options.getPort(), options.token);
  }

  function getServerInfo(): BrowserServerInfo {
    const { wifi, tailscale } = getNetworkIps();
    return {
      url: buildAccessUrl('127.0.0.1'),
      wifiUrl: buildOptionalAccessUrl(wifi),
      tailscaleUrl: buildOptionalAccessUrl(tailscale),
      token: options.token,
      port: options.getPort(),
    };
  }

  function getRemoteStatus(): BrowserRemoteStatus {
    const connectedClients = options.getAuthenticatedClientCount();
    return {
      enabled: true,
      connectedClients,
      peerClients: Math.max(connectedClients - 1, 0),
      ...getServerInfo(),
    };
  }

  return {
    buildAccessUrl,
    buildOptionalAccessUrl,
    getRemoteStatus,
    getServerInfo,
  };
}
