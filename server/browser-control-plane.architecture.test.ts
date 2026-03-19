import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const browserControlPlanePath = path.resolve(process.cwd(), 'server/browser-control-plane.ts');
const browserControlPlaneSource = readFileSync(browserControlPlanePath, 'utf8');

describe('browser control plane architecture guardrails', () => {
  it('keeps replay-state ownership behind browser-control-state', () => {
    expect(browserControlPlaneSource).toContain('createBrowserControlState');
    expect(browserControlPlaneSource).not.toContain('getServerStateBootstrap');
    expect(browserControlPlaneSource).not.toContain('removeGitStatusSnapshot');
  });

  it('keeps delayed sends, peer presence, and takeovers behind focused owners', () => {
    expect(browserControlPlaneSource).toContain('createBrowserControlDelayedSends');
    expect(browserControlPlaneSource).toContain('createBrowserPeerPresence');
    expect(browserControlPlaneSource).toContain('createBrowserTaskCommandTakeovers');
    expect(browserControlPlaneSource).not.toContain('const delayedClientSends = new WeakMap');
    expect(browserControlPlaneSource).not.toContain('const peerSessions = new Map');
    expect(browserControlPlaneSource).not.toContain(
      'const pendingTaskCommandTakeoverRequests = new Map',
    );
  });
});
