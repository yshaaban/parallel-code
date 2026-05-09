import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const terminalSessionSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/terminal-view/terminal-session.ts'),
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
});
