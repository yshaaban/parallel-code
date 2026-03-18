import type { ConnectionStatus } from './ws';

interface ConnectionStatusMetadata {
  badgeLabel: string;
  bannerText: string | null;
  bannerTone: {
    background: string;
    color: string;
  };
  recovering: boolean;
  showSkeleton: boolean;
  tone: 'danger' | 'success' | 'warning';
}

const CONNECTION_STATUS_METADATA: Record<ConnectionStatus, ConnectionStatusMetadata> = {
  connecting: {
    badgeLabel: 'Connecting',
    bannerText: 'Connecting...',
    bannerTone: {
      background: '#78350f',
      color: '#fde68a',
    },
    recovering: true,
    showSkeleton: true,
    tone: 'warning',
  },
  connected: {
    badgeLabel: 'Connected',
    bannerText: null,
    bannerTone: {
      background: 'transparent',
      color: 'var(--text-primary)',
    },
    recovering: false,
    showSkeleton: false,
    tone: 'success',
  },
  disconnected: {
    badgeLabel: 'Offline',
    bannerText: 'Disconnected - check your network',
    bannerTone: {
      background: '#7f1d1d',
      color: '#fca5a5',
    },
    recovering: false,
    showSkeleton: false,
    tone: 'danger',
  },
  reconnecting: {
    badgeLabel: 'Reconnecting',
    bannerText: 'Reconnecting...',
    bannerTone: {
      background: '#78350f',
      color: '#fde68a',
    },
    recovering: true,
    showSkeleton: false,
    tone: 'warning',
  },
};

export function getConnectionBannerText(status: ConnectionStatus): string | null {
  return CONNECTION_STATUS_METADATA[status].bannerText;
}

export function getConnectionBadgeLabel(status: ConnectionStatus): string {
  return CONNECTION_STATUS_METADATA[status].badgeLabel;
}

export function getConnectionTone(status: ConnectionStatus): 'danger' | 'success' | 'warning' {
  return CONNECTION_STATUS_METADATA[status].tone;
}

export function getConnectionBannerTone(
  status: ConnectionStatus,
): ConnectionStatusMetadata['bannerTone'] {
  return CONNECTION_STATUS_METADATA[status].bannerTone;
}

export function isRecoveringConnectionStatus(status: ConnectionStatus): boolean {
  return CONNECTION_STATUS_METADATA[status].recovering;
}

export function shouldShowConnectionSkeleton(status: ConnectionStatus): boolean {
  return CONNECTION_STATUS_METADATA[status].showSkeleton;
}
