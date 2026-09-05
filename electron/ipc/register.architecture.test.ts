import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const registerPath = path.resolve(process.cwd(), 'electron/ipc/register.ts');
const registerSource = readFileSync(registerPath, 'utf8');
const mainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
const applicationSource = readFileSync(
  path.resolve(process.cwd(), 'electron/application.ts'),
  'utf8',
);
const ipcDirectory = path.resolve(process.cwd(), 'electron/ipc');
const sourceRoots = ['electron', 'server', 'src'].map((directory) =>
  path.resolve(process.cwd(), directory),
);

function readIpcSource(fileName: string): string {
  return readFileSync(path.join(ipcDirectory, fileName), 'utf8');
}

function listProductionTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listProductionTypeScriptSources(entryPath);
    }
    if (
      !entry.name.match(/\.tsx?$/u) ||
      entry.name.match(/\.(?:bench|benchmark|spec|test|test-helper)\./u)
    ) {
      return [];
    }
    return [entryPath];
  });
}

describe('electron handler registration architecture guardrails', () => {
  // The coordinator IPC handlers bind lazily, so nothing on the Electron IPC
  // path hydrates coordinator-state.json by itself. The Electron shell must
  // keep the eager hydration call so the renderer's first
  // GetServerStateBootstrap sees restored coordinator runs after an app
  // restart (the browser shell owns the equivalent post-listen load through
  // server/coordinator-runtime-loader.ts).
  it('hydrates persisted coordinator state before binding IPC handlers', () => {
    const ensureIndex = registerSource.indexOf('ensureCoordinatorServiceLoaded({');
    const handlersIndex = registerSource.indexOf('const handlers = createIpcHandlers(');

    expect(ensureIndex).toBeGreaterThan(-1);
    expect(handlersIndex).toBeGreaterThan(-1);
    expect(ensureIndex).toBeLessThan(handlersIndex);
  });

  it('returns window-owned cleanup before the fallback runner stop in the shutdown aggregate', () => {
    expect(registerSource).toContain('export interface RegisteredIpcRuntime');
    expect(registerSource).toContain('return { cleanup: cleanupWindowRuntime };');
    expect(registerSource).toContain("label: 'task experience'");
    expect(registerSource).toContain("label: 'workspace storage'");
    expect(registerSource).not.toContain('.catch(() => undefined)');
    expect(applicationSource).toContain(
      'mainWindowRuntime = registerAllHandlers(mainWindow, options)',
    );
    const windowCleanup = applicationSource.indexOf(
      'const windowRuntimeCleanup = mainWindowRuntime?.cleanup() ?? Promise.resolve();',
    );
    const runnerFallback = applicationSource.indexOf(
      'const agentRunnerFallbackCleanup = stopAgentRunnersAfterTaskExperience(windowRuntimeCleanup);',
    );
    expect(windowCleanup).toBeGreaterThan(-1);
    expect(runnerFallback).toBeGreaterThan(windowCleanup);
    expect(applicationSource).toContain('cleanup: windowRuntimeCleanup');
    expect(applicationSource).toContain('cleanup: agentRunnerFallbackCleanup');
    expect(applicationSource).toContain("label: 'window runtime'");
    expect(applicationSource).toContain("label: 'agent runner'");
    expect(mainSource).toContain('startElectronApplication();');
  });
});

describe('worktree symlink architecture guardrails', () => {
  it('keeps the canonical V1 encoder in one backend owner', () => {
    const declarations = sourceRoots
      .flatMap(listProductionTypeScriptSources)
      .filter((filePath) =>
        /function encodeTaskWorktreeLinkRequestV1\s*\(/u.test(readFileSync(filePath, 'utf8')),
      )
      .map((filePath) => path.relative(process.cwd(), filePath));

    expect(declarations).toEqual(['electron/ipc/git-worktree-symlinks.ts']);
  });

  it('keeps worktree link creation behind the policy owner', () => {
    const worktreeSource = readIpcSource('git-worktree.ts');

    expect(worktreeSource).toContain('applyRequestedWorktreeSymlinks(');
    expect(worktreeSource).toContain('assertTaskWorktreeLinkRequestV1(worktreeLinkRequest);');
    expect(worktreeSource).not.toMatch(/\bsymlink(?:Sync)?\s*\(/u);
    expect(worktreeSource).not.toContain('SYMLINK_CANDIDATES');
  });

  it('fingerprints only owner-returned V1 bytes after synchronous preflight', () => {
    const workflowSource = readIpcSource('task-workflows.ts');
    const fingerprintStart = workflowSource.indexOf(
      'function getTaskCreationOperationFingerprint(',
    );
    const fingerprintEnd = workflowSource.indexOf(
      'function rememberTaskCreationOperation(',
      fingerprintStart,
    );
    const fingerprintSource = workflowSource.slice(fingerprintStart, fingerprintEnd);
    const workflowStart = workflowSource.indexOf('export async function createTaskWorkflow(');
    const encodeIndex = workflowSource.indexOf(
      'encodeTaskWorktreeLinkRequestV1(request.symlinkDirs)',
      workflowStart,
    );
    const operationLookupIndex = workflowSource.indexOf(
      'taskCreationOperationsById.get(operationId)',
      workflowStart,
    );

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(fingerprintEnd).toBeGreaterThan(fingerprintStart);
    expect(fingerprintSource).toContain('worktreeLinkRequest.encodedBytes');
    expect(fingerprintSource).not.toContain('request.symlinkDirs');
    expect(encodeIndex).toBeGreaterThan(workflowStart);
    expect(encodeIndex).toBeLessThan(operationLookupIndex);
  });

  it('canonicalizes Arena link hints before the shared worktree creator', () => {
    const handlerSource = readIpcSource('task-git-handlers.ts');
    const arenaStart = handlerSource.indexOf('[IPC.CreateArenaWorktree]');
    const arenaEnd = handlerSource.indexOf('[IPC.RemoveArenaWorktree]', arenaStart);
    const arenaSource = handlerSource.slice(arenaStart, arenaEnd);

    expect(arenaStart).toBeGreaterThan(-1);
    expect(arenaEnd).toBeGreaterThan(arenaStart);
    expect(arenaSource).toContain('encodeTaskWorktreeLinkRequestV1(request.symlinkDirs ?? [])');
    expect(arenaSource).toContain('await createWorktree(');
  });
});
