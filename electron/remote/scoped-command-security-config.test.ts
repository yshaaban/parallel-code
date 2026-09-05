import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REMOTE_SECURITY_ENV_KEYS,
  loadRemoteScopedCommandSecurityConfig,
} from './scoped-command-security-config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-remote-security-'));
  temporaryDirectories.push(directory);
  const certificatePath = path.join(directory, 'certificate.pem');
  const keyPath = path.join(directory, 'key.pem');
  fs.writeFileSync(certificatePath, 'certificate', { mode: 0o644 });
  fs.writeFileSync(keyPath, 'private-key', { mode: 0o600 });
  return {
    [REMOTE_SECURITY_ENV_KEYS.accessToken]: 'standalone-scoped-access-secret',
    [REMOTE_SECURITY_ENV_KEYS.certificatePath]: certificatePath,
    [REMOTE_SECURITY_ENV_KEYS.grants]: 'catalog:read,terminal:read,terminal:control',
    [REMOTE_SECURITY_ENV_KEYS.interfaces]: 'tailscale0',
    [REMOTE_SECURITY_ENV_KEYS.keyPath]: keyPath,
    [REMOTE_SECURITY_ENV_KEYS.peerRanges]: '100.64.0.0/10',
  };
}

describe('loadRemoteScopedCommandSecurityConfig', () => {
  it('stays disabled when no secure transport configuration exists', () => {
    expect(loadRemoteScopedCommandSecurityConfig({})).toEqual({ kind: 'disabled' });
  });

  it('loads a complete bounded TLS, peer, and grant configuration', () => {
    const result = loadRemoteScopedCommandSecurityConfig(fixture());
    expect(result).toMatchObject({
      accessToken: 'standalone-scoped-access-secret',
      grants: new Set(['catalog:read', 'terminal:read', 'terminal:control']),
      kind: 'configured',
      peerTrustPolicy: {
        allowedInterfaces: ['tailscale0'],
        allowedPeerRanges: ['100.64.0.0/10'],
      },
    });
    if (result.kind === 'configured') {
      expect(result.tls.cert.toString()).toBe('certificate');
      expect(result.tls.key.toString()).toBe('private-key');
    }
  });

  it('fails closed for partial config, broad key permissions, malformed ranges, and unknown grants', () => {
    const complete = fixture();
    expect(
      loadRemoteScopedCommandSecurityConfig({
        [REMOTE_SECURITY_ENV_KEYS.certificatePath]:
          complete[REMOTE_SECURITY_ENV_KEYS.certificatePath],
      }),
    ).toEqual({ code: 'incomplete', kind: 'invalid' });
    expect(
      loadRemoteScopedCommandSecurityConfig({
        [REMOTE_SECURITY_ENV_KEYS.accessToken]: 'orphaned-access-token',
      }),
    ).toEqual({ code: 'incomplete', kind: 'invalid' });

    const keyPath = complete[REMOTE_SECURITY_ENV_KEYS.keyPath];
    if (!keyPath) throw new Error('Missing fixture key');
    fs.chmodSync(keyPath, 0o644);
    expect(loadRemoteScopedCommandSecurityConfig(complete)).toEqual({
      code: 'invalid-key',
      kind: 'invalid',
    });
    fs.chmodSync(keyPath, 0o600);

    expect(
      loadRemoteScopedCommandSecurityConfig({
        ...complete,
        [REMOTE_SECURITY_ENV_KEYS.peerRanges]: '100.64.0.0/99',
      }),
    ).toEqual({ code: 'invalid-peer-policy', kind: 'invalid' });
    expect(
      loadRemoteScopedCommandSecurityConfig({
        ...complete,
        [REMOTE_SECURITY_ENV_KEYS.grants]: 'catalog:read,local-admin',
      }),
    ).toEqual({ code: 'invalid-grants', kind: 'invalid' });
  });
});
