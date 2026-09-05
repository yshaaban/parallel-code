import fs from 'fs';
import { REMOTE_GRANTS, type RemoteGrant } from '../ipc/remote-command-gateway.js';
import { isValidRemotePeerTrustPolicy, type RemotePeerTrustPolicy } from './network.js';

const CERT_MAX_BYTES = 1024 * 1024;
const KEY_MAX_BYTES = 1024 * 1024;

export const REMOTE_SECURITY_ENV_KEYS = Object.freeze({
  accessToken: 'PARALLEL_CODE_REMOTE_ACCESS_TOKEN',
  certificatePath: 'PARALLEL_CODE_REMOTE_TLS_CERT_PATH',
  grants: 'PARALLEL_CODE_REMOTE_GRANTS',
  interfaces: 'PARALLEL_CODE_REMOTE_TRUSTED_INTERFACES',
  keyPath: 'PARALLEL_CODE_REMOTE_TLS_KEY_PATH',
  peerRanges: 'PARALLEL_CODE_REMOTE_TRUSTED_PEER_RANGES',
});

export type RemoteScopedCommandSecurityConfigResult =
  | { kind: 'disabled' }
  | {
      accessToken: string | null;
      grants: ReadonlySet<RemoteGrant>;
      kind: 'configured';
      peerTrustPolicy: RemotePeerTrustPolicy;
      tls: { cert: Buffer; key: Buffer };
    }
  | {
      code:
        | 'incomplete'
        | 'invalid-certificate'
        | 'invalid-grants'
        | 'invalid-key'
        | 'invalid-peer-policy';
      kind: 'invalid';
    };

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  requireOwnerOnly: boolean,
): Buffer | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return null;
    if (requireOwnerOnly && (stat.mode & 0o077) !== 0) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/** Loads the explicit administrator-owned secure remote transport boundary. */
export function loadRemoteScopedCommandSecurityConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteScopedCommandSecurityConfigResult {
  const accessToken = environment[REMOTE_SECURITY_ENV_KEYS.accessToken]?.trim() || null;
  const certificatePath = environment[REMOTE_SECURITY_ENV_KEYS.certificatePath]?.trim();
  const keyPath = environment[REMOTE_SECURITY_ENV_KEYS.keyPath]?.trim();
  const interfaces = environment[REMOTE_SECURITY_ENV_KEYS.interfaces]?.trim();
  const peerRanges = environment[REMOTE_SECURITY_ENV_KEYS.peerRanges]?.trim();
  const grantsValue = environment[REMOTE_SECURITY_ENV_KEYS.grants]?.trim();
  const requiredValues = [certificatePath, keyPath, interfaces, peerRanges];
  if (![accessToken, grantsValue, ...requiredValues].some(Boolean)) return { kind: 'disabled' };
  if (
    !requiredValues.every(Boolean) ||
    !certificatePath ||
    !keyPath ||
    !interfaces ||
    !peerRanges
  ) {
    return { code: 'incomplete', kind: 'invalid' };
  }

  const cert = readBoundedRegularFile(certificatePath, CERT_MAX_BYTES, false);
  if (!cert) return { code: 'invalid-certificate', kind: 'invalid' };
  const key = readBoundedRegularFile(keyPath, KEY_MAX_BYTES, true);
  if (!key) return { code: 'invalid-key', kind: 'invalid' };

  const peerTrustPolicy: RemotePeerTrustPolicy = {
    allowedInterfaces: splitList(interfaces),
    allowedPeerRanges: splitList(peerRanges),
  };
  if (!isValidRemotePeerTrustPolicy(peerTrustPolicy)) {
    return { code: 'invalid-peer-policy', kind: 'invalid' };
  }

  const requestedGrants = splitList(grantsValue ?? 'catalog:read,terminal:read');
  const allowedGrants = new Set<string>(REMOTE_GRANTS);
  if (
    requestedGrants.length === 0 ||
    new Set(requestedGrants).size !== requestedGrants.length ||
    requestedGrants.some((grant) => !allowedGrants.has(grant))
  ) {
    return { code: 'invalid-grants', kind: 'invalid' };
  }
  return {
    accessToken,
    grants: new Set(requestedGrants as RemoteGrant[]),
    kind: 'configured',
    peerTrustPolicy,
    tls: { cert, key },
  };
}
