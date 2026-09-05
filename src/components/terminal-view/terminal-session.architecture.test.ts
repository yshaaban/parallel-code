import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(PROJECT_ROOT, relativePath), 'utf8');
}

function expectSourceNotToContain(sourceName: string, source: string, forbiddenTerms: string[]) {
  for (const term of forbiddenTerms) {
    expect(source, `${sourceName} should not contain ${term}`).not.toContain(term);
  }
}

function listProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionSources(entryPath);
    return /\.tsx?$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name) ? [entryPath] : [];
  });
}

const terminalContractSource = readRepoFile('docs/TERMINAL-CONTRACT.md');
const architectureSource = readRepoFile('docs/ARCHITECTURE.md');
const terminalDevelopmentGuideSource = readRepoFile('docs/TERMINAL-DEVELOPMENT-GUIDE.md');
const terminalSessionSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/terminal-view/terminal-session.ts'),
  'utf8',
);
const terminalSessionLoaderSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/terminal-view/terminal-session-loader.ts'),
  'utf8',
);
const terminalViewSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/TerminalView.tsx'),
  'utf8',
);
const remoteAgentDetailSource = readRepoFile('src/remote/AgentDetail.tsx');
const appShortcutsSource = readRepoFile('src/runtime/app-shortcuts.ts');
const webglPoolSource = readFileSync(path.resolve(process.cwd(), 'src/lib/webglPool.ts'), 'utf8');
const terminalLinksSource = readRepoFile('src/lib/terminal-links.ts');
const terminalSearchRuntimeSource = readRepoFile(
  'src/components/terminal-view/terminal-search-runtime.ts',
);
const terminalSearchOverlaySource = readRepoFile('src/components/TerminalSearchOverlay.tsx');
const frontendViteConfigSource = readRepoFile('electron/vite.config.electron.ts');
const compressionScriptSource = readRepoFile('scripts/compress-dist-assets.mjs');
const terminalRecoveryRuntimeSource = readRepoFile(
  'src/components/terminal-view/terminal-recovery-runtime.ts',
);
const terminalOutputPipelineSource = readRepoFile(
  'src/components/terminal-view/terminal-output-pipeline.ts',
);
const terminalShortcutsSource = readRepoFile('src/lib/terminal-shortcuts.ts');
const ptySource = readRepoFile('electron/ipc/pty.ts');
const agentHandlersSource = readRepoFile('electron/ipc/agent-handlers.ts');
const systemHandlersSource = readRepoFile('electron/ipc/system-handlers.ts');
const browserChannelsSource = readRepoFile('server/browser-channels.ts');
const browserWebSocketSource = readRepoFile('server/browser-websocket.ts');
const browserAgentCommandExecutorSource = readRepoFile('server/browser-agent-command-executor.ts');
const browserChannelClientSource = readRepoFile('src/lib/browser-channel-client.ts');
const remoteWsSource = readRepoFile('src/remote/ws.ts');
const taskAiTerminalSectionSource = readRepoFile(
  'src/components/task-panel/TaskAiTerminalSection.tsx',
);
const taskShellSectionSource = readRepoFile('src/components/task-panel/TaskShellSection.tsx');
const terminalPanelSource = readRepoFile('src/components/TerminalPanel.tsx');
const arenaBattleSource = readRepoFile('src/arena/BattleScreen.tsx');
const electronRegisterSource = readRepoFile('electron/ipc/register.ts');
const browserServerSource = readRepoFile('server/browser-server.ts');

describe('terminal session architecture guardrails', () => {
  it('keeps the durable terminal contract discoverable and scoped to terminal boundaries', () => {
    const requiredContractHeadings = [
      '## PTY Byte Fidelity',
      '## Terminal Stream Messages',
      '## Input And Resize Ordering',
      '## Recovery Kinds',
      '## Cursor, Readiness, And Presentation',
      '## Flow Control',
      '## Scrollback And Budget Owners',
      '## Desktop, Browser, And Mobile Parity',
      '## Desktop Terminal Capabilities',
      '## Platform Degraded Behavior',
    ];

    for (const heading of requiredContractHeadings) {
      expect(terminalContractSource).toContain(heading);
    }

    for (const recoveryKind of ['`noop`', '`delta`', '`snapshot`', '`terminal-state`']) {
      expect(terminalContractSource).toContain(recoveryKind);
    }

    expect(terminalContractSource).toContain('`electron/ipc/pty.ts` owns real PTY state');
    expect(architectureSource).toContain('[TERMINAL-CONTRACT.md](./TERMINAL-CONTRACT.md)');
    expect(terminalDevelopmentGuideSource).toContain(
      '[TERMINAL-CONTRACT.md](./TERMINAL-CONTRACT.md)',
    );
  });

  it('keeps input, output, and recovery behind named terminal-view owners', () => {
    expect(terminalSessionSource).toContain('createTerminalInputPipeline');
    expect(terminalSessionSource).toContain('createTerminalOutputPipeline');
    expect(terminalSessionSource).toContain('createTerminalRecoveryRuntime');
  });

  it('keeps transport-aware lifecycle logic visible in the public terminal facade', () => {
    expect(terminalSessionSource).toContain('outputChannel.onmessage');
    expect(terminalSessionSource).toContain('IPC.AttachTerminalSession');
    expect(terminalSessionSource).not.toContain('IPC.SpawnAgent');
    expect(terminalSessionSource).toContain('onBrowserTransportEvent');
  });

  it('keeps production terminal lifecycle ownership explicit at every surface', () => {
    expect(taskAiTerminalSectionSource).toContain('sessionOwner="managed-agent"');
    expect(taskShellSectionSource).toContain("ownership?.kind === 'managed-terminal-v1'");
    expect(taskShellSectionSource).toContain('ownership.sessionId === shellId');
    expect(terminalPanelSource).toContain('sessionOwner="compatibility-shell"');
    expect(arenaBattleSource).toContain('sessionOwner="arena-transient"');
    expect(terminalSessionSource).toContain(
      "sessionOwner === 'managed-agent' || sessionOwner === 'managed-task-shell'",
    );
  });

  it('keeps compatibility creation intent process-local and minted only by creation owners', () => {
    const markerCallers = listProductionSources(path.resolve(PROJECT_ROOT, 'src'))
      .filter((filePath) =>
        readFileSync(filePath, 'utf8').includes('markCompatibilityTerminalCreationPending('),
      )
      .map((filePath) => path.relative(PROJECT_ROOT, filePath))
      .sort();

    expect(markerCallers).toEqual([
      'src/app/task-shell-workflows.ts',
      'src/runtime/compatibility-terminal-creation.ts',
      'src/store/terminals.ts',
    ]);
    expect(terminalSessionSource).toContain('isCompatibilityTerminalCreationPending(');
    expect(terminalSessionSource).toContain('completeCompatibilityTerminalCreation(');
    expect(terminalSessionSource).not.toContain('markCompatibilityTerminalCreationPending(');
  });

  it('forwards compatibility creation provenance through desktop and browser compositions', () => {
    for (const source of [electronRegisterSource, browserServerSource]) {
      expect(source).toContain('restoreCanonicalTaskShellSession = async (request, options) =>');
      expect(source).toContain('restoreCanonicalTaskShellSession(request, options)');
    }
  });

  it('keeps optional terminal addons out of the eager startup chunk', () => {
    expect(terminalSessionSource).toContain("import('@xterm/addon-web-links')");
    expect(terminalSessionSource).not.toMatch(/import\s+\{[^}]*WebLinksAddon/u);

    expect(webglPoolSource).toContain("import('@xterm/addon-webgl')");
    expect(webglPoolSource).toContain("import type { WebglAddon } from '@xterm/addon-webgl'");
    expect(webglPoolSource).not.toMatch(/import\s+\{[^}]*WebglAddon/u);
  });

  it('keeps terminal search lazy, session-owned, and presentation-only at the view edge', () => {
    expect(terminalSearchRuntimeSource).toContain("import('@xterm/addon-search')");
    expect(terminalSearchRuntimeSource).not.toMatch(
      /import\s+\{[^}]*SearchAddon[^}]*\}\s+from\s+['"]@xterm\/addon-search['"]/u,
    );
    expect(terminalSessionSource).toContain('createTerminalSearchRuntime');
    expect(terminalSessionSource).toContain("case 'find':");
    expect(terminalViewSource).toContain('<TerminalSearchOverlay');
    expectSourceNotToContain('TerminalView', terminalViewSource, [
      '@xterm/addon-search',
      'createTerminalSearchRuntime',
      'findNext(',
      'findPrevious(',
    ]);
    expectSourceNotToContain('TerminalSearchOverlay', terminalSearchOverlaySource, [
      '@xterm/',
      '../store/',
      'findNext(',
      'findPrevious(',
    ]);
  });

  it('prefetches only startup-critical terminal addons and excludes search from eager links', () => {
    expect(frontendViteConfigSource).toContain("new Set(['addon-web-links', 'addon-webgl'])");
    expect(frontendViteConfigSource).not.toContain("startsWith('addon-')");
    expect(compressionScriptSource).toContain(
      'must not preload or prefetch the terminal search addon',
    );
  });

  it('keeps bounded terminal link policy in its pure owner', () => {
    expect(terminalLinksSource).toContain('export function computeTerminalMarkdownLinks');
    expect(terminalLinksSource).toContain('maxCells: 4_096');
    expect(terminalLinksSource).toContain('maxRows: 128');
    expect(terminalSessionSource).toContain('computeTerminalMarkdownLinks(');
    expectSourceNotToContain('terminal-session', terminalSessionSource, [
      'TERMINAL_MARKDOWN_LINK_PATTERN',
      'getMarkdownViewerRelativePath',
      'stripTerminalMarkdownLinkSuffix',
      '.getCell(',
      '.isWrapped',
    ]);
  });

  it('keeps WebGL atlas repair in the pool and the manual shortcut lazy', () => {
    expect(webglPoolSource).toContain('export function requestVisibleWebglAtlasRepair');
    expect(webglPoolSource).toContain('entry.addon.clearTextureAtlas()');
    expect(appShortcutsSource).toContain("import('../lib/webglPool')");
    expect(appShortcutsSource).not.toMatch(/import\s+[^;]+\s+from\s+['"]\.\.\/lib\/webglPool['"]/u);
    expectSourceNotToContain('TerminalView', terminalViewSource, [
      'clearTextureAtlas',
      'requestVisibleWebglAtlasRepair',
    ]);
  });

  it('keeps the terminal implementation behind an explicit startup loader', () => {
    expect(terminalViewSource).toContain("from './terminal-view/terminal-session-loader'");
    expect(terminalViewSource).toContain('TerminalSession');
    expect(terminalViewSource).toContain('TerminalAttachMilestone');
    expect(terminalViewSource).not.toContain(
      "import { startTerminalSession } from './terminal-view/terminal-session'",
    );
    expect(terminalSessionLoaderSource).toContain("import('./terminal-session')");
    expect(terminalSessionLoaderSource).toContain('emitStartupBreadcrumb');
    expect(terminalSessionLoaderSource).toContain('import type {');
    expect(terminalSessionLoaderSource).toContain('StartTerminalSessionOptions');
    expect(terminalSessionLoaderSource).toContain('TerminalSession');
  });

  it('prebinds browser output channels while the lazy terminal module loads', () => {
    expect(terminalSessionLoaderSource).toContain('new Channel<PtyOutput>()');
    expect(terminalSessionLoaderSource).toContain('outputChannel.dispose()');
    expect(terminalSessionSource).toContain('outputChannel?: Channel<PtyOutput>');
    expect(terminalSessionSource).toContain(
      'const outputChannel = options.outputChannel ?? new Channel<PtyOutput>()',
    );
  });

  it('keeps PTY bytes, recovery payloads, and pause truth behind the backend PTY owner', () => {
    expect(ptySource).toContain('scrollback: RingBuffer');
    expect(ptySource).toContain('terminalStateMirror: TerminalStateMirror');
    expect(ptySource).toContain('outputCursor: number');
    expect(ptySource).toContain('session.outputCursor += toCopy');
    expect(ptySource).toContain("sendToAttachedChannels(session, { type: 'Data', data: encoded })");
    expect(ptySource).toContain('export function getAgentTerminalRecovery');
    expect(ptySource).toContain('export async function getAgentTerminalStartupRecovery');
    expect(ptySource).toContain('export function pauseAgent');
    expect(ptySource).toContain('export function resumeAgent');

    expect(agentHandlersSource).toContain('serializeTerminalRecoveryEntry');
    expect(agentHandlersSource).toContain('getAgentTerminalRecovery(');
    expect(agentHandlersSource).toContain('getAgentTerminalStartupRecovery(');
    expect(agentHandlersSource).toContain('assertBase64String');
    expectSourceNotToContain('agent-handlers', agentHandlersSource, [
      'new TerminalStateMirror',
      'new RingBuffer',
      'buildAgentTerminalRecovery',
      'session.outputCursor +=',
      'proc.onData',
    ]);
  });

  it('keeps browser transport focused on validation, routing, and degradation', () => {
    expect(browserChannelsSource).toContain('createQueuedChannelMessage');
    expect(browserChannelsSource).toContain("type: 'RecoveryRequired'");
    expect(browserChannelsSource).toContain('markClientChannelRecoveryRequired');
    expect(browserChannelClientSource).toContain('parseBrowserBinaryChannelFrame');
    expect(browserChannelClientSource).toContain("type: 'Data'");
    expect(browserWebSocketSource).toContain('dispatchByType');
    expect(browserWebSocketSource).toContain('hasBrowserTaskControlForMessage');
    expect(browserWebSocketSource).toContain('writeBrowserAgentInput');
    expect(browserWebSocketSource).toContain('resizeBrowserAgent');
    expect(browserWebSocketSource).toContain('getBrowserAgentTerminalRecoveryEntry');
    expect(browserWebSocketSource).toContain('getBrowserAgentTerminalStartupRecoveryEntry');
    expect(browserAgentCommandExecutorSource).toContain("from '../electron/ipc/pty.js'");

    for (const [sourceName, source] of [
      ['browser-channels', browserChannelsSource],
      ['browser-websocket', browserWebSocketSource],
      ['browser-channel-client', browserChannelClientSource],
    ] as const) {
      expectSourceNotToContain(sourceName, source, [
        'getAgentTerminalRecovery',
        'getAgentTerminalStartupRecovery',
        'TerminalStateMirror',
        'new RingBuffer',
        'getAgentScrollback(',
      ]);
    }
  });

  it('keeps desktop and mobile shells consuming terminal contracts instead of owning recovery', () => {
    expect(terminalViewSource).toContain('startLoadedTerminalSession');
    expect(terminalViewSource).toContain('data-terminal-status');
    expect(terminalViewSource).toContain('data-terminal-presentation-mode');
    expect(terminalRecoveryRuntimeSource).toContain('requestStartupTerminalRecovery');
    expect(terminalRecoveryRuntimeSource).toContain('isFullStateRecovery');
    expect(terminalRecoveryRuntimeSource).toContain('shouldShowBlockingRestoreUI');
    expect(remoteWsSource).toContain('RemoteHandledServerMessageType');
    expect(remoteWsSource).toContain('handleScrollbackMessage');
    expect(remoteWsSource).toContain('handleTerminalStreamMessage');
    expect(remoteWsSource).toContain('handleTerminalRecoveryResultMessage');
    expect(remoteAgentDetailSource).toContain('onTerminalStream');
    expect(remoteAgentDetailSource).toContain('onTerminalRecoveryResult');

    expectSourceNotToContain('TerminalView', terminalViewSource, [
      'GetTerminalRecoveryBatch',
      'GetTerminalStartupRecoveryBatch',
      'RecoveryRequired',
      'terminal-state',
      'requestTerminalRecovery(',
      'requestStartupTerminalRecovery(',
      'restoreTerminalOutput(',
    ]);

    for (const [sourceName, source] of [
      ['remote ws', remoteWsSource],
      ['remote AgentDetail', remoteAgentDetailSource],
    ] as const) {
      expectSourceNotToContain(sourceName, source, [
        'GetTerminalRecoveryBatch',
        'GetTerminalStartupRecoveryBatch',
        'getAgentTerminalRecovery',
        'getAgentTerminalStartupRecovery',
        'TerminalStateMirror',
        'new RingBuffer',
        'restoreTerminalOutput(',
      ]);
    }
  });

  it('keeps terminal shortcuts and clipboard-image capability behind shared owners', () => {
    expect(terminalShortcutsSource).toContain('export function getTerminalShortcutAction');
    expect(terminalSessionSource).toContain("from '../../lib/terminal-shortcuts'");
    expect(terminalSessionSource).toContain('getTerminalShortcutAction(event');
    expect(terminalSessionSource).not.toMatch(
      /\bkey\s*===\s*['"](?:c|v|f|enter|arrowleft|arrowright|arrowup|arrowdown|pageup|pagedown)['"]/iu,
    );

    expect(terminalSessionSource).toContain('IPC.ResolveClipboardPaste');
    expect(systemHandlersSource).toContain('[IPC.ResolveClipboardPaste]');
    expect(systemHandlersSource).toContain('[IPC.SaveClipboardImage]');
    expectSourceNotToContain('terminal-session', terminalSessionSource, ['IPC.SaveClipboardImage']);
    expectSourceNotToContain('TerminalView', terminalViewSource, [
      'getTerminalShortcutAction',
      'ResolveClipboardPaste',
      'SaveClipboardImage',
      'navigator.clipboard',
    ]);
  });

  it('keeps terminal recovery independent of control-plane replay-truncated signals', () => {
    // Terminal recovery ('reconnect' reason) is driven by channel-level
    // recovery and the restore lifecycle. The control-plane replay-truncated
    // signal only gates the world resync in src/runtime/browser-session.ts;
    // delta-resync may downgrade it without touching terminal recovery.
    const scrollbackRestoreSource = readRepoFile('src/lib/scrollbackRestore.ts');
    expectSourceNotToContain('terminal-recovery-runtime', terminalRecoveryRuntimeSource, [
      'replay-truncated',
      'replayTruncated',
      'hasReplayTruncatedSinceDisconnect',
    ]);
    expectSourceNotToContain('scrollbackRestore', scrollbackRestoreSource, [
      'replay-truncated',
      'replayTruncated',
      'hasReplayTruncatedSinceDisconnect',
    ]);
    expectSourceNotToContain('terminal-session', terminalSessionSource, [
      'replay-truncated',
      'replayTruncated',
      'hasReplayTruncatedSinceDisconnect',
    ]);
  });

  it('keeps renderer flow-control accounting in the terminal output owner', () => {
    expect(terminalOutputPipelineSource).toContain('const FLOW_HIGH');
    expect(terminalOutputPipelineSource).toContain('const FLOW_LOW');
    expect(terminalOutputPipelineSource).toContain('suppressedWatermark += chunk.length');
    expect(terminalOutputPipelineSource).toContain("reason: 'flow-control'");
    expect(terminalSessionSource).toContain('outputPipeline.recoverFlowControlIfIdle');
    expect(terminalViewSource).not.toContain('FLOW_HIGH');
    expect(terminalViewSource).not.toContain('suppressedWatermark');
  });
});
