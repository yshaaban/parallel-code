import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
const webglPoolSource = readFileSync(path.resolve(process.cwd(), 'src/lib/webglPool.ts'), 'utf8');

describe('terminal session architecture guardrails', () => {
  it('keeps input, output, and recovery behind named terminal-view owners', () => {
    expect(terminalSessionSource).toContain('createTerminalInputPipeline');
    expect(terminalSessionSource).toContain('createTerminalOutputPipeline');
    expect(terminalSessionSource).toContain('createTerminalRecoveryRuntime');
  });

  it('keeps transport-aware lifecycle logic visible in the public terminal facade', () => {
    expect(terminalSessionSource).toContain('outputChannel.onmessage');
    expect(terminalSessionSource).toContain('invoke(IPC.SpawnAgent');
    expect(terminalSessionSource).toContain('onBrowserTransportEvent');
  });

  it('keeps optional terminal addons out of the eager startup chunk', () => {
    expect(terminalSessionSource).toContain("import('@xterm/addon-web-links')");
    expect(terminalSessionSource).not.toMatch(/import\s+\{[^}]*WebLinksAddon/u);

    expect(webglPoolSource).toContain("import('@xterm/addon-webgl')");
    expect(webglPoolSource).toContain("import type { WebglAddon } from '@xterm/addon-webgl'");
    expect(webglPoolSource).not.toMatch(/import\s+\{[^}]*WebglAddon/u);
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
});
