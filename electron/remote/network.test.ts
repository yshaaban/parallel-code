import { networkInterfaces } from 'os';
import { describe, expect, it, vi } from 'vitest';
import { buildSecureSessionBootstrapUrl, validateRemotePeerSocket } from './network.js';

vi.mock('os', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('os')>();
  return {
    ...original,
    networkInterfaces: vi.fn(),
  };
});

const mockedNetworkInterfaces = vi.mocked(networkInterfaces);

describe('validateRemotePeerSocket', () => {
  it('requires an exact current interface and an allowed direct peer range', () => {
    mockedNetworkInterfaces.mockReturnValue({
      tailscale0: [
        {
          address: '100.64.0.1',
          cidr: '100.64.0.1/32',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.255',
        },
      ],
    });
    const policy = {
      allowedInterfaces: ['tailscale0'],
      allowedPeerRanges: ['100.64.0.0/10'],
    };

    expect(
      validateRemotePeerSocket(
        { localAddress: '100.64.0.1', remoteAddress: '100.100.2.3' },
        policy,
      ),
    ).toBe(true);
    expect(
      validateRemotePeerSocket(
        { localAddress: '100.64.0.1', remoteAddress: '192.168.1.2' },
        policy,
      ),
    ).toBe(false);
    expect(
      validateRemotePeerSocket(
        { localAddress: '100.64.0.2', remoteAddress: '100.100.2.3' },
        policy,
      ),
    ).toBe(false);
  });

  it('rejects mapped, zone-ambiguous, malformed, and unconfigured addresses', () => {
    mockedNetworkInterfaces.mockReturnValue({
      secure0: [
        {
          address: 'fd00::1',
          cidr: 'fd00::1/128',
          family: 'IPv6',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          scopeid: 0,
        },
      ],
    });
    const policy = { allowedInterfaces: ['secure0'], allowedPeerRanges: ['fd00::/64'] };

    expect(
      validateRemotePeerSocket({ localAddress: 'fd00::1', remoteAddress: 'fd00::2' }, policy),
    ).toBe(true);
    expect(
      validateRemotePeerSocket(
        { localAddress: 'fd00::1', remoteAddress: '::ffff:100.64.0.2' },
        policy,
      ),
    ).toBe(false);
    expect(
      validateRemotePeerSocket(
        { localAddress: 'fd00::1%secure0', remoteAddress: 'fd00::2' },
        policy,
      ),
    ).toBe(false);
    expect(
      validateRemotePeerSocket({ localAddress: 'fd00::1', remoteAddress: 'fd00::2' }, null),
    ).toBe(false);
    expect(
      validateRemotePeerSocket(
        { localAddress: 'fd00::1', remoteAddress: 'fd00::2' },
        { ...policy, allowedPeerRanges: ['broken/129'] },
      ),
    ).toBe(false);
  });
});

describe('buildSecureSessionBootstrapUrl', () => {
  it('lets a composed host target its namespaced auth route and remote shell', () => {
    const url = new URL(
      buildSecureSessionBootstrapUrl('100.64.0.2', 7777, 'scoped-secret', {
        bootstrapPath: '/remote/auth/bootstrap',
        nextPath: '/remote/',
      }),
    );

    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/remote/auth/bootstrap');
    expect(url.searchParams.get('token')).toBe('scoped-secret');
    expect(url.searchParams.get('next')).toBe('/remote/');
  });
});
