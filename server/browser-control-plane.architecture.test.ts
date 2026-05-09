import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const browserControlPlanePath = path.resolve(process.cwd(), 'server/browser-control-plane.ts');
const browserIpcPath = path.resolve(process.cwd(), 'server/browser-ipc.ts');
const browserIpcCommandSideEffectsPath = path.resolve(
  process.cwd(),
  'server/browser-ipc-command-side-effects.ts',
);
const browserWebSocketPath = path.resolve(process.cwd(), 'server/browser-websocket.ts');
const browserWebSocketTaskControlPath = path.resolve(
  process.cwd(),
  'server/browser-websocket-task-control.ts',
);
const browserAgentCommandResultsPath = path.resolve(
  process.cwd(),
  'server/browser-agent-command-results.ts',
);
const browserAgentOutputSubscriptionsPath = path.resolve(
  process.cwd(),
  'server/browser-agent-output-subscriptions.ts',
);
const browserAgentCommandRunnerPath = path.resolve(
  process.cwd(),
  'server/browser-agent-command-runner.ts',
);
const browserAgentCommandExecutorPath = path.resolve(
  process.cwd(),
  'server/browser-agent-command-executor.ts',
);
const browserTerminalInputTracingPath = path.resolve(
  process.cwd(),
  'server/browser-terminal-input-tracing.ts',
);
const browserControlPlaneSource = readFileSync(browserControlPlanePath, 'utf8');
const browserIpcSource = readFileSync(browserIpcPath, 'utf8');
const browserIpcCommandSideEffectsSource = readFileSync(browserIpcCommandSideEffectsPath, 'utf8');
const browserWebSocketSource = readFileSync(browserWebSocketPath, 'utf8');
const browserWebSocketTaskControlSource = readFileSync(browserWebSocketTaskControlPath, 'utf8');
const browserAgentCommandResultsSource = readFileSync(browserAgentCommandResultsPath, 'utf8');
const browserAgentOutputSubscriptionsSource = readFileSync(
  browserAgentOutputSubscriptionsPath,
  'utf8',
);
const browserAgentCommandRunnerSource = readFileSync(browserAgentCommandRunnerPath, 'utf8');
const browserAgentCommandExecutorSource = readFileSync(browserAgentCommandExecutorPath, 'utf8');
const browserTerminalInputTracingSource = readFileSync(browserTerminalInputTracingPath, 'utf8');

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

  it('keeps browser HTTP IPC route policy behind the command side-effect owner', () => {
    expect(browserIpcSource).toContain('runBrowserIpcCommandSideEffects');
    expect(browserIpcSource).toContain('normalizeBrowserIpcTaskCommandArgs');
    expect(browserIpcSource).not.toContain('getAgentMeta');
    expect(browserIpcSource).not.toContain('createGitStatusSyncRefreshEvent');
    expect(browserIpcSource).not.toContain('registerCreatedTask');
    expect(browserIpcSource).not.toContain("type: 'task-event'");
    expect(browserIpcCommandSideEffectsSource).toContain('createGitStatusSyncRefreshEvent');
    expect(browserIpcCommandSideEffectsSource).toContain('registerCreatedTask');
    expect(browserIpcCommandSideEffectsSource).toContain("type: 'task-event'");
  });

  it('keeps browser websocket task-control policy behind the task-control owner', () => {
    expect(browserWebSocketSource).toContain('hasBrowserTaskControlForMessage');
    expect(browserWebSocketSource).not.toContain('browserAgentControllerStillOwnsTask');
    expect(browserWebSocketSource).not.toContain('getAgentMeta');
    expect(browserWebSocketSource).not.toContain('canResizeTaskTerminal');
    expect(browserWebSocketTaskControlSource).toContain('getAgentMeta');
    expect(browserWebSocketTaskControlSource).toContain('canResizeTaskTerminal');
    expect(browserAgentCommandRunnerSource).toContain('browserAgentControllerStillOwnsTask');
  });

  it('keeps browser websocket command-result caching behind the cache owner', () => {
    expect(browserWebSocketSource).toContain('createBrowserAgentCommandResultCache');
    expect(browserWebSocketSource).not.toContain('cachedAgentCommandResults');
    expect(browserWebSocketSource).not.toContain('AGENT_COMMAND_RESULT_CACHE_TTL_MS');
    expect(browserAgentCommandResultsSource).toContain('cachedAgentCommandResults');
    expect(browserAgentCommandResultsSource).toContain('DEFAULT_AGENT_COMMAND_RESULT_CACHE_TTL_MS');
  });

  it('keeps browser websocket output subscriptions behind the subscription owner', () => {
    expect(browserWebSocketSource).toContain('createBrowserAgentOutputSubscriptions');
    expect(browserWebSocketSource).not.toContain('getAgentScrollback');
    expect(browserWebSocketSource).not.toContain('subscribeToAgent');
    expect(browserWebSocketSource).not.toContain('unsubscribeFromAgent');
    expect(browserAgentOutputSubscriptionsSource).toContain('getAgentScrollback');
    expect(browserAgentOutputSubscriptionsSource).toContain('subscribeToAgent');
    expect(browserAgentOutputSubscriptionsSource).toContain('unsubscribeFromAgent');
  });

  it('keeps browser websocket command execution behind the command runner owner', () => {
    expect(browserWebSocketSource).toContain('createBrowserAgentCommandRunner');
    expect(browserWebSocketSource).not.toContain('getClaimAgentControlErrorMessage');
    expect(browserWebSocketSource).not.toContain('TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE');
    expect(browserAgentCommandRunnerSource).toContain('getClaimAgentControlErrorMessage');
    expect(browserAgentCommandRunnerSource).toContain('TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE');
  });

  it('keeps browser websocket PTY mutations behind the command executor owner', () => {
    expect(browserWebSocketSource).toContain('writeBrowserAgentInput');
    expect(browserWebSocketSource).not.toContain('writeToAgent');
    expect(browserWebSocketSource).not.toContain('resizeAgent');
    expect(browserWebSocketSource).not.toContain('pauseAgent');
    expect(browserWebSocketSource).not.toContain('resumeAgent');
    expect(browserWebSocketSource).not.toContain('killAgent');
    expect(browserAgentCommandExecutorSource).toContain('writeToAgent');
    expect(browserAgentCommandExecutorSource).toContain('resizeAgent');
    expect(browserAgentCommandExecutorSource).toContain('pauseAgent');
    expect(browserAgentCommandExecutorSource).toContain('resumeAgent');
    expect(browserAgentCommandExecutorSource).toContain('killAgent');
  });

  it('keeps browser terminal input trace diagnostics behind the trace owner', () => {
    expect(browserWebSocketSource).toContain('recordBrowserTerminalInputServerReceived');
    expect(browserWebSocketSource).toContain('createBrowserTerminalInputTraceClockSyncMessage');
    expect(browserWebSocketSource).not.toContain('recordTerminalInputTraceServerReceived');
    expect(browserWebSocketSource).not.toContain('recordTerminalInputTraceFailure');
    expect(browserWebSocketSource).not.toContain('recordTerminalInputTraceClientUpdate');
    expect(browserTerminalInputTracingSource).toContain('recordTerminalInputTraceServerReceived');
    expect(browserTerminalInputTracingSource).toContain('recordTerminalInputTraceFailure');
    expect(browserTerminalInputTracingSource).toContain('recordTerminalInputTraceClientUpdate');
  });
});
