import { describe, expect, it } from 'vitest';
import {
  getConnectionBadgeLabel,
  getConnectionBannerText,
  getConnectionBannerTone,
  getConnectionTone,
  isRecoveringConnectionStatus,
  shouldShowConnectionSkeleton,
} from './status-helpers';

describe('remote connection status helpers', () => {
  it('maps connection statuses to banner text and badge labels exhaustively', () => {
    expect(getConnectionBannerText('connecting')).toBe('Connecting...');
    expect(getConnectionBadgeLabel('connecting')).toBe('Connecting');
    expect(getConnectionBannerText('connected')).toBeNull();
    expect(getConnectionBadgeLabel('connected')).toBe('Connected');
    expect(getConnectionBannerText('disconnected')).toBe('Disconnected - check your network');
    expect(getConnectionBadgeLabel('disconnected')).toBe('Offline');
    expect(getConnectionBannerText('reconnecting')).toBe('Reconnecting...');
    expect(getConnectionBadgeLabel('reconnecting')).toBe('Reconnecting');
  });

  it('tracks recovering, skeleton, and tone states without string fallbacks', () => {
    expect(isRecoveringConnectionStatus('connecting')).toBe(true);
    expect(isRecoveringConnectionStatus('connected')).toBe(false);
    expect(isRecoveringConnectionStatus('disconnected')).toBe(false);
    expect(isRecoveringConnectionStatus('reconnecting')).toBe(true);

    expect(shouldShowConnectionSkeleton('connecting')).toBe(true);
    expect(shouldShowConnectionSkeleton('connected')).toBe(false);
    expect(shouldShowConnectionSkeleton('disconnected')).toBe(false);
    expect(shouldShowConnectionSkeleton('reconnecting')).toBe(false);

    expect(getConnectionTone('connecting')).toBe('warning');
    expect(getConnectionTone('connected')).toBe('success');
    expect(getConnectionTone('disconnected')).toBe('danger');
    expect(getConnectionTone('reconnecting')).toBe('warning');

    expect(getConnectionBannerTone('connecting')).toEqual({
      background: '#78350f',
      color: '#fde68a',
    });
    expect(getConnectionBannerTone('disconnected')).toEqual({
      background: '#7f1d1d',
      color: '#fca5a5',
    });
  });
});
