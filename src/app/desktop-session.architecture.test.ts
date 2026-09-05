import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopSessionPath = path.resolve(process.cwd(), 'src/app/desktop-session.ts');
const desktopSessionStartupPath = path.resolve(process.cwd(), 'src/app/desktop-session-startup.ts');
const browserWorkspaceRecoveryPath = path.resolve(
  process.cwd(),
  'src/app/browser-workspace-cold-start-recovery.ts',
);
const persistenceLoadPath = path.resolve(process.cwd(), 'src/store/persistence-load.ts');
const browserColdBootstrapProjectionPath = path.resolve(
  process.cwd(),
  'src/store/browser-cold-bootstrap-projection.ts',
);
const browserStateSyncControllerPath = path.resolve(
  process.cwd(),
  'src/runtime/browser-state-sync-controller.ts',
);
const desktopSessionSource = readFileSync(desktopSessionPath, 'utf8');
const desktopSessionStartupSource = readFileSync(desktopSessionStartupPath, 'utf8');
const browserWorkspaceRecoverySource = readFileSync(browserWorkspaceRecoveryPath, 'utf8');
const browserStateSyncControllerSource = readFileSync(browserStateSyncControllerPath, 'utf8');
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

  it('delegates browser workspace recovery without absorbing its fallback policy', () => {
    expect(desktopSessionStartupSource).toContain('startBrowserWorkspaceColdStartRecovery');
    for (const forbiddenPolicy of [
      'fetchBrowserColdBootstrap',
      'takeBrowserColdBootstrapHandoffProjection',
      'loadWorkspaceState',
      'BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS',
      'BROWSER_COLD_BOOTSTRAP_RECOVERY_DELAYS_MS',
      'applyBrowserColdBootstrapWorkspaceProjection',
    ]) {
      expect(desktopSessionStartupSource).not.toContain(forbiddenPolicy);
    }
  });

  it('keeps cold-start recovery separate from reconnect and Electron restore policy', () => {
    for (const forbiddenPolicy of [
      'GetBrowserReconnectSnapshot',
      'syncBrowserStateFromReconnectSnapshot',
      'beginBrowserReconnectRestore',
      'setBrowserStartupTier',
      'electronRuntime',
    ]) {
      expect(browserWorkspaceRecoverySource).not.toContain(forbiddenPolicy);
    }
    expect(browserWorkspaceRecoverySource).not.toMatch(/\bloadState\s*\(/);
  });

  it('routes removed-task persistence cleanup through the shared task cleanup owner', () => {
    for (const [sourcePath, source] of persistenceApplySources) {
      expect(source, sourcePath).not.toContain('clearRemovedTaskCommandLeaseState');
      expect(source, sourcePath).not.toContain('clearTerminalStartupEntriesForTask');
    }
  });

  it('runs retained merge status recovery only after host-owned state reconciliation', () => {
    expect(desktopSessionStartupSource).toContain(
      "import { reconcileRetainedTaskMergeOperations } from './task-merge-operation-recovery'",
    );
    expect(
      desktopSessionStartupSource.match(/void reconcileRetainedTaskMergeOperations\(\);/g),
    ).toHaveLength(1);
    const startupRecoveryIndex = desktopSessionStartupSource.indexOf(
      'void reconcileRetainedTaskMergeOperations();',
    );
    expect(startupRecoveryIndex).toBeGreaterThan(
      desktopSessionStartupSource.indexOf('await loadState();'),
    );
    expect(startupRecoveryIndex).toBeGreaterThan(
      desktopSessionStartupSource.indexOf(').restore();'),
    );
    expect(browserStateSyncControllerSource).toContain(
      "import { reconcileRetainedTaskMergeOperations } from '../app/task-merge-operation-recovery'",
    );
    expect(
      browserStateSyncControllerSource.match(/void reconcileRetainedTaskMergeOperations\(\);/g),
    ).toHaveLength(1);
    expect(
      browserStateSyncControllerSource.indexOf('void reconcileRetainedTaskMergeOperations();'),
    ).toBeGreaterThan(
      browserStateSyncControllerSource.indexOf('const stateChanged = await readStateChange();'),
    );
    for (const [sourcePath, source] of persistenceApplySources) {
      expect(source, sourcePath).not.toContain('task-merge-operation-recovery');
    }
  });
});
