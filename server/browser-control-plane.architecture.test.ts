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
});
