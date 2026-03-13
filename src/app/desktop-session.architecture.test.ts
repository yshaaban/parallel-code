import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopSessionPath = path.resolve(process.cwd(), 'src/app/desktop-session.ts');
const desktopSessionSource = readFileSync(desktopSessionPath, 'utf8');

describe('desktop session architecture guardrails', () => {
  it('routes startup category wiring through the session bootstrap controller', () => {
    expect(desktopSessionSource).toContain('createSessionBootstrapController');
    expect(desktopSessionSource).not.toContain('fetchServerStateBootstrap');
  });

  it('does not attach ad hoc server-owned startup listeners directly', () => {
    expect(desktopSessionSource).not.toContain('listenServerMessage');
    expect(desktopSessionSource).not.toContain('listenGitStatusChanged');
    expect(desktopSessionSource).not.toContain('listenTaskPortsChanged');
    expect(desktopSessionSource).not.toContain('listenTaskReviewChanged');
    expect(desktopSessionSource).not.toContain('listenTaskConvergenceChanged');
    expect(desktopSessionSource).not.toContain('listenAgentSupervisionChanged');
    expect(desktopSessionSource).not.toContain('listenRemoteStatusChanged');
  });
});
