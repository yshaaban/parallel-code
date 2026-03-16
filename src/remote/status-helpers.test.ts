import { describe, expect, it } from 'vitest';
import {
  getConnectionBannerText,
  isRecoveringConnectionStatus,
  shouldShowConnectionSkeleton,
} from './status-helpers';

describe('remote connection status helpers', () => {
  it('maps connection statuses to banner text exhaustively', () => {
    expect(getConnectionBannerText('connecting')).toBe('Connecting...');
    expect(getConnectionBannerText('connected')).toBeNull();
    expect(getConnectionBannerText('disconnected')).toBe('Disconnected - check your network');
    expect(getConnectionBannerText('reconnecting')).toBe('Reconnecting...');
  });

  it('tracks recovering and skeleton states without string fallbacks', () => {
    expect(isRecoveringConnectionStatus('connecting')).toBe(true);
    expect(isRecoveringConnectionStatus('connected')).toBe(false);
    expect(isRecoveringConnectionStatus('disconnected')).toBe(false);
    expect(isRecoveringConnectionStatus('reconnecting')).toBe(true);

    expect(shouldShowConnectionSkeleton('connecting')).toBe(true);
    expect(shouldShowConnectionSkeleton('connected')).toBe(false);
    expect(shouldShowConnectionSkeleton('disconnected')).toBe(false);
    expect(shouldShowConnectionSkeleton('reconnecting')).toBe(false);
  });
});
