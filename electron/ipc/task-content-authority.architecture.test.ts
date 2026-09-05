import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('task content authority architecture', () => {
  it('keeps renderer task-content requests free of caller-selected roots and classes', () => {
    const rendererInvoke = source('src/domain/renderer-invoke.ts');
    const requestSection = rendererInvoke.slice(
      rendererInvoke.indexOf('[IPC.ReadPlanContent]:'),
      rendererInvoke.indexOf('[IPC.ResolveClipboardPaste]:'),
    );
    expect(requestSection).toContain('taskId: string');
    expect(requestSection).toContain('agentId?: string');
    expect(requestSection).not.toContain('worktreePath: string');
    expect(rendererInvoke).not.toContain('contentAuthorityClass');
  });

  it('composes one coordinator before exposing restored task and PTY authority', () => {
    const handlers = source('electron/ipc/handlers.ts');
    const restoreIndex = handlers.indexOf('taskRegistry.restoreAuthorizedTaskRoots(');
    const metadataSyncIndex = handlers.indexOf('taskRegistry.syncFromSavedState(');
    const ptyIndex = handlers.indexOf('configurePtyContentAuthorityCoordinator(');
    const authorityIndex = handlers.indexOf('createTerminalContentRootAuthority(');
    const returnIndex = handlers.indexOf('return {');

    expect(restoreIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeLessThan(metadataSyncIndex);
    expect(metadataSyncIndex).toBeLessThan(ptyIndex);
    expect(ptyIndex).toBeLessThan(authorityIndex);
    expect(authorityIndex).toBeLessThan(returnIndex);
  });

  it('binds identity, rechecks the path, commits authority, then reads bounded bytes', () => {
    const fileAccess = source('electron/ipc/task-file-access.ts');
    const asyncRead = fileAccess.slice(fileAccess.indexOf('export async function readBounded'));
    const openIndex = asyncRead.indexOf('fs.promises.open(');
    const descriptorIdentityIndex = asyncRead.indexOf('handle.stat(');
    const postPathIndex = asyncRead.indexOf('verifyPostOpenPath(');
    const commitIndex = asyncRead.indexOf('commitAfterDescriptorBind()');
    const readIndex = asyncRead.indexOf('readDescriptorBounded(');

    expect(openIndex).toBeLessThan(descriptorIdentityIndex);
    expect(descriptorIdentityIndex).toBeLessThan(postPathIndex);
    expect(postPathIndex).toBeLessThan(commitIndex);
    expect(commitIndex).toBeLessThan(readIndex);
  });

  it('routes Markdown and every plan-content path through the shared bounded primitive', () => {
    expect(source('electron/ipc/markdown-files.ts')).toContain('readBoundedTaskTextFile({');
    const plans = source('electron/ipc/plans.ts');
    expect(plans).toContain('readBoundedTaskTextFileSync({');
    expect(plans).not.toContain('fs.readFileSync(path.join(plansDir');
  });

  it('withdraws task authority before user and coordinator teardown workflows', () => {
    const taskHandlers = source('electron/ipc/task-git-handlers.ts');
    const deleteHandler = taskHandlers.slice(
      taskHandlers.indexOf('[IPC.DeleteTask]:'),
      taskHandlers.indexOf('[IPC.CleanupTaskRuntime]:'),
    );
    expect(deleteHandler).toContain('markTaskClosing');
    expect(deleteHandler).toContain('deleteTaskWorkflow');
    expect(deleteHandler.indexOf('markTaskClosing')).toBeLessThan(
      deleteHandler.indexOf('deleteTaskWorkflow'),
    );

    const gateway = source('electron/coordinator/tool-gateway.ts');
    const landingCleanup = gateway.slice(gateway.lastIndexOf("status: 'cleanup' as const"));
    expect(landingCleanup).toContain('markTaskClosing');
    expect(landingCleanup).toContain('deleteTaskWorkflow');
    expect(landingCleanup.indexOf('markTaskClosing')).toBeLessThan(
      landingCleanup.indexOf('deleteTaskWorkflow'),
    );
  });

  it('derives explicit-transient classification only from a consumed Arena capability', () => {
    const agentHandlers = source('electron/ipc/agent-handlers.ts');
    expect(agentHandlers).toContain('consumeArenaTerminalLaunch({');
    expect(agentHandlers).toContain("contentAuthorityClass = 'explicit-transient'");
    expect(agentHandlers).toContain('contentAuthorityRoot = arenaLaunch.root');
    expect(agentHandlers).not.toContain('request.contentAuthorityClass');

    const workflows = source('electron/ipc/task-workflows.ts');
    expect(workflows).toContain('path.resolve(spawnCwd) !== request.contentAuthorityRoot');
  });

  it('withdraws PTY authority before every active termination path can yield or kill', () => {
    const pty = source('electron/ipc/pty.ts');
    const dispose = pty.slice(
      pty.indexOf('function disposeSessionResources('),
      pty.indexOf('function cleanupSessionResources('),
    );
    expect(dispose.indexOf('revokeSessionContentAuthority(')).toBeLessThan(
      dispose.indexOf('session.disposed = true'),
    );

    const terminate = pty.slice(
      pty.indexOf('function terminateSessionAndWait('),
      pty.indexOf('async function terminateSessionAndCleanup('),
    );
    expect(terminate.indexOf('revokeSessionContentAuthority(')).toBeLessThan(
      terminate.indexOf('performSessionTermination('),
    );

    const onExit = pty.slice(pty.indexOf('proc.onExit('), pty.indexOf('recordAgentSpawn({'));
    expect(onExit.indexOf('revokeSessionContentAuthority(')).toBeLessThan(
      onExit.indexOf('session.resolveExit()'),
    );
    expect(onExit).not.toContain('session.exited = true');

    const killAgent = pty.slice(
      pty.indexOf('export function killAgent('),
      pty.indexOf('export async function killAgentAndWaitForRunnerCleanup('),
    );
    expect(killAgent.indexOf('revokeAgentContentAuthority(')).toBeLessThan(
      killAgent.indexOf('session.proc.kill()'),
    );

    const killAll = pty.slice(
      pty.indexOf('export function killAllAgents('),
      pty.indexOf('// --- Subscriber helpers'),
    );
    expect(killAll.indexOf('revokeAllAgentContentAuthorities(')).toBeLessThan(
      killAll.indexOf('session.proc.kill()'),
    );

    const workflows = source('electron/ipc/task-workflows.ts');
    const stopOne = workflows.slice(
      workflows.indexOf('export function stopTaskAgentWorkflow('),
      workflows.indexOf('export function stopAllTaskAgentWorkflows('),
    );
    expect(stopOne.indexOf('revokeAgentContentAuthority(')).toBeLessThan(
      stopOne.indexOf('Promise.resolve()'),
    );
    const stopAll = workflows.slice(
      workflows.indexOf('export function stopAllTaskAgentWorkflows('),
      workflows.indexOf('export function countRunningAndPendingTaskAgents('),
    );
    expect(stopAll.indexOf('revokeAllAgentContentAuthorities(')).toBeLessThan(
      stopAll.indexOf('const stopPromise'),
    );
  });
});
