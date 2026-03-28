import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const TEST_FILE = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(TEST_FILE), '..', '..');

async function loadTerminalUiFluidityGateRunnerModule(): Promise<
  typeof import('../../scripts/run-terminal-ui-fluidity-gate.mjs')
> {
  return import(
    pathToFileURL(path.resolve(ROOT_DIR, 'scripts', 'run-terminal-ui-fluidity-gate.mjs')).href
  );
}

describe('run-terminal-ui-fluidity-gate', () => {
  it('builds the default shared gate matrix args', async () => {
    const gateRunner = await loadTerminalUiFluidityGateRunnerModule();

    expect(gateRunner.buildTerminalUiFluidityGateMatrixArgs()).toEqual([
      path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-matrix.mjs'),
      '--skip-build',
      '--variants',
      'product_default,high_load_mode_product',
      '--profiles',
      'recent_hidden_switch,interactive_verbose,bulk_text',
      '--visible-terminal-counts',
      '1,2,4',
    ]);
  });

  it('switches to the dense visible-count gate when requested', async () => {
    const gateRunner = await loadTerminalUiFluidityGateRunnerModule();

    expect(
      gateRunner.buildTerminalUiFluidityGateMatrixArgs({
        dense: true,
        extraArgs: ['--trace'],
      }),
    ).toEqual([
      path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-matrix.mjs'),
      '--skip-build',
      '--variants',
      'product_default,high_load_mode_product',
      '--profiles',
      'recent_hidden_switch,interactive_verbose,bulk_text',
      '--visible-terminal-counts',
      '4',
      '--trace',
    ]);
  });
});
