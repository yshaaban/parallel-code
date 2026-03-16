import type { ConnectionStatus } from './ws';

interface ConnectionStatusMetadata {
  bannerText: string | null;
  recovering: boolean;
  showSkeleton: boolean;
}

const CONNECTION_STATUS_METADATA: Record<ConnectionStatus, ConnectionStatusMetadata> = {
  connecting: {
    bannerText: 'Connecting...',
    recovering: true,
    showSkeleton: true,
  },
  connected: {
    bannerText: null,
    recovering: false,
    showSkeleton: false,
  },
  disconnected: {
    bannerText: 'Disconnected - check your network',
    recovering: false,
    showSkeleton: false,
  },
  reconnecting: {
    bannerText: 'Reconnecting...',
    recovering: true,
    showSkeleton: false,
  },
};

export function getConnectionBannerText(status: ConnectionStatus): string | null {
  return CONNECTION_STATUS_METADATA[status].bannerText;
}

export function isRecoveringConnectionStatus(status: ConnectionStatus): boolean {
  return CONNECTION_STATUS_METADATA[status].recovering;
}

export function shouldShowConnectionSkeleton(status: ConnectionStatus): boolean {
  return CONNECTION_STATUS_METADATA[status].showSkeleton;
}
