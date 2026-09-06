import {
  buildAccessUrl as buildRemoteAccessUrl,
  buildOptionalAccessUrl as buildOptionalRemoteAccessUrl,
  buildOptionalSecureSessionBootstrapUrl,
  buildSecureSessionBootstrapUrl,
  getNetworkIps,
  type SecureSessionBootstrapUrlOptions,
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
  networkAccessible?: boolean;
  secureSessionBootstrap?: SecureSessionBootstrapUrlOptions;
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
    return options.secureSessionBootstrap
      ? buildSecureSessionBootstrapUrl(
          host,
          options.getPort(),
          options.token,
          options.secureSessionBootstrap,
        )
      : buildRemoteAccessUrl(host, options.getPort(), options.token);
  }

  function buildOptionalAccessUrl(host: string | null): string | null {
    return options.secureSessionBootstrap
      ? buildOptionalSecureSessionBootstrapUrl(
          host,
          options.getPort(),
          options.token,
          options.secureSessionBootstrap,
        )
      : buildOptionalRemoteAccessUrl(host, options.getPort(), options.token);
  }

  function getServerInfo(): BrowserServerInfo {
    const { wifi, tailscale } = options.networkAccessible
      ? getNetworkIps()
      : { wifi: null, tailscale: null };
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
