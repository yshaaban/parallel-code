import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const terminalSessionSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/terminal-view/terminal-session.ts'),
  'utf8',
);

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
});
