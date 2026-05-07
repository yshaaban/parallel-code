import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopSessionPath = path.resolve(process.cwd(), 'src/app/desktop-session.ts');
const desktopSessionStartupPath = path.resolve(process.cwd(), 'src/app/desktop-session-startup.ts');
const persistenceLoadPath = path.resolve(process.cwd(), 'src/store/persistence-load.ts');
const browserColdBootstrapProjectionPath = path.resolve(
  process.cwd(),
  'src/store/browser-cold-bootstrap-projection.ts',
);
const desktopSessionSource = readFileSync(desktopSessionPath, 'utf8');
const desktopSessionStartupSource = readFileSync(desktopSessionStartupPath, 'utf8');
const persistenceApplySources = [
  ['src/store/persistence-load.ts', readFileSync(persistenceLoadPath, 'utf8')],
  [
    'src/store/browser-cold-bootstrap-projection.ts',
    readFileSync(browserColdBootstrapProjectionPath, 'utf8'),
  ],
] as const;
const desktopSessionSources = [
  ['src/app/desktop-session.ts', desktopSessionSource],
  ['src/app/desktop-session-startup.ts', desktopSessionStartupSource],
] as const;

describe('desktop session architecture guardrails', () => {
  it('routes startup category wiring through the session bootstrap controller', () => {
    expect(desktopSessionSource).toContain('createSessionBootstrapController');
    for (const [sourcePath, source] of desktopSessionSources) {
      expect(source, sourcePath).not.toContain('fetchServerStateBootstrap');
    }
  });

  it('does not attach ad hoc server-owned startup listeners directly', () => {
    for (const [sourcePath, source] of desktopSessionSources) {
      expect(source, sourcePath).not.toContain('listenServerMessage');
      expect(source, sourcePath).not.toContain('listenGitStatusChanged');
      expect(source, sourcePath).not.toContain('listenTaskPortsChanged');
      expect(source, sourcePath).not.toContain('listenTaskReviewChanged');
      expect(source, sourcePath).not.toContain('listenTaskConvergenceChanged');
      expect(source, sourcePath).not.toContain('listenAgentSupervisionChanged');
      expect(source, sourcePath).not.toContain('listenRemoteStatusChanged');
    }
  });

  it('routes removed-task persistence cleanup through the shared task cleanup owner', () => {
    for (const [sourcePath, source] of persistenceApplySources) {
      expect(source, sourcePath).not.toContain('clearRemovedTaskCommandLeaseState');
      expect(source, sourcePath).not.toContain('clearTerminalStartupEntriesForTask');
    }
  });
});
