import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const TEST_FILE = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(TEST_FILE), '..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.resolve(ROOT_DIR, relativePath), 'utf8');
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const packageJsonText = await readRepoFile('package.json');
  const packageJson = JSON.parse(packageJsonText) as {
    scripts: Record<string, string>;
  };
  return packageJson.scripts;
}

async function loadTerminalUiFluidityGateModule(): Promise<
  typeof import('../scripts/terminal-ui-fluidity-gate.mjs')
> {
  return import(
    pathToFileURL(path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-gate.mjs')).href
  );
}

async function loadTerminalUiFluidityMatrixModule(): Promise<
  typeof import('../scripts/terminal-ui-fluidity-matrix.mjs')
> {
  return import(
    pathToFileURL(path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-matrix.mjs')).href
  );
}

async function loadTerminalUiFluidityGateRunnerModule(): Promise<
  typeof import('../scripts/run-terminal-ui-fluidity-gate.mjs')
> {
  return import(
    pathToFileURL(path.resolve(ROOT_DIR, 'scripts', 'run-terminal-ui-fluidity-gate.mjs')).href
  );
}

function expectScriptToContainFlags(command: string, flags: readonly string[]): void {
  for (const flag of flags) {
    expect(command).toContain(flag);
  }
}

function expectScriptsToBeUndefined(
  scripts: Readonly<Record<string, string>>,
  scriptNames: readonly string[],
): void {
  for (const scriptName of scriptNames) {
    expect(scripts[scriptName]).toBeUndefined();
  }
}

describe('terminal ui fluidity gate consistency', () => {
  it('keeps the shared gate profiles and visible counts on the documented browser proof', async () => {
    const gateModule = await loadTerminalUiFluidityGateModule();

    expect(gateModule.DEFAULT_TERMINAL_UI_FLUIDITY_GATE_PROFILES).toEqual([
      'recent_hidden_switch',
      'interactive_verbose',
      'bulk_text',
    ]);
    expect(gateModule.DEFAULT_TERMINAL_UI_FLUIDITY_GATE_VISIBLE_TERMINAL_COUNTS).toEqual([1, 2, 4]);
  });

  it('keeps the profiler and matrix defaults wired to the shared gate module', async () => {
    const profilerScript = await readRepoFile('scripts/profile-terminal-ui-fluidity.mjs');
    const matrixScript = await readRepoFile('scripts/terminal-ui-fluidity-matrix.mjs');

    expect(profilerScript).toContain("from './terminal-ui-fluidity-gate.mjs'");
    expect(matrixScript).toContain("from './terminal-ui-fluidity-gate.mjs'");
  });

  it('keeps the gate runner aligned with the shared gate defaults', async () => {
    const scripts = await readPackageScripts();
    const gateModule = await loadTerminalUiFluidityGateModule();
    const gateRunnerModule = await loadTerminalUiFluidityGateRunnerModule();
    const expectedMatrixVariants = gateModule.formatTerminalUiFluidityMatrixGateVariants();

    expect(gateRunnerModule.buildTerminalUiFluidityGateMatrixArgs()).toEqual([
      path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-matrix.mjs'),
      '--skip-build',
      '--variants',
      gateModule.formatTerminalUiFluidityMatrixGateVariants(),
      '--profiles',
      gateModule.formatTerminalUiFluidityGateProfiles(),
      '--visible-terminal-counts',
      gateModule.formatTerminalUiFluidityGateVisibleTerminalCounts(),
    ]);
    expect(
      gateRunnerModule.buildTerminalUiFluidityGateMatrixArgs({
        dense: true,
        extraArgs: [],
      }),
    ).toEqual([
      path.resolve(ROOT_DIR, 'scripts', 'terminal-ui-fluidity-matrix.mjs'),
      '--skip-build',
      '--variants',
      gateModule.formatTerminalUiFluidityMatrixGateVariants(),
      '--profiles',
      gateModule.formatTerminalUiFluidityGateProfiles(),
      '--visible-terminal-counts',
      gateModule.formatTerminalUiFluidityDenseGateVisibleTerminalCounts(),
    ]);
    expect(scripts['profile:terminal:ui-fluidity:gate:run']).toBe(
      'node scripts/run-terminal-ui-fluidity-gate.mjs',
    );
    expect(scripts['profile:terminal:ui-fluidity:gate']).toBe(
      'npm run profile:terminal:ui-fluidity:gate:run --',
    );
    expect(scripts['profile:terminal:ui-fluidity:dense-gate']).toBe(
      'npm run profile:terminal:ui-fluidity:gate:run -- --dense',
    );
    expect(scripts['profile:terminal:ui-fluidity:matrix:gate']).toBe(
      'npm run profile:terminal:ui-fluidity:gate --',
    );
    expectScriptToContainFlags(scripts['lab:terminal:ui-fluidity:hidden-render-wake'], [
      `--variant ${gateModule.DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_RENDER_WAKE_VARIANT}`,
    ]);
    expectScriptToContainFlags(scripts['lab:terminal:ui-fluidity:hidden-session-wake'], [
      `--variant ${gateModule.DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_SESSION_WAKE_VARIANT}`,
    ]);
    expectScriptToContainFlags(scripts['lab:terminal:ui-fluidity:hidden-switch'], [
      `--variant ${gateModule.DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_SWITCH_VARIANT}`,
      '--profiles recent_hidden_switch',
    ]);
    expectScriptToContainFlags(scripts['lab:terminal:ui-fluidity:hidden-switch:matrix'], [
      `--variants ${expectedMatrixVariants}`,
    ]);
    expectScriptToContainFlags(scripts['lab:terminal:ui-fluidity:matrix:hidden-lifecycle'], [
      '--allow-partial-profiles',
    ]);
  });

  it('keeps duplicated browser and gate entrypoints as aliases instead of duplicated commands', async () => {
    const scripts = await readPackageScripts();

    expect(scripts['test:browser:file']).toBe('npm run test:browser:run --');
    expect(scripts['test:browser:e2e']).toBe('npm run test:browser:file --');
    expect(scripts['profile:terminal:ui-fluidity:matrix:gate']).toBe(
      'npm run profile:terminal:ui-fluidity:gate --',
    );
  });

  it('keeps exploratory browser-fluidity entrypoints explicitly labeled as lab-only', async () => {
    const scripts = await readPackageScripts();
    expectScriptsToBeUndefined(scripts, [
      'profile:terminal:ui-fluidity:matrix',
      'profile:terminal:ui-fluidity:experiments',
      'profile:terminal:ui-fluidity:hidden-render-wake',
      'profile:terminal:ui-fluidity:hidden-session-wake',
      'profile:terminal:ui-fluidity:hidden-switch',
      'profile:terminal:ui-fluidity:hidden-switch:matrix',
      'profile:terminal:ui-fluidity:matrix:hidden-lifecycle',
      'profile:terminal:ui-fluidity:matrix:bulk-bursts',
      'profile:terminal:ui-fluidity:matrix:visible-shapes',
      'profile:terminal:ui-fluidity:trace',
    ]);

    expect(scripts['lab:terminal:ui-fluidity:matrix']).toContain(
      'scripts/terminal-ui-fluidity-matrix.mjs',
    );
    expect(scripts['lab:terminal:ui-fluidity:experiments']).toContain('--repeats 3');
    expect(scripts['lab:terminal:ui-fluidity:trace']).toContain('--trace');
  });

  it('keeps the profiler ready checks tied to the live render ready signal', async () => {
    const profilerScript = await readRepoFile('scripts/profile-terminal-ui-fluidity.mjs');

    expect(profilerScript).toContain('data-terminal-live-render-ready');
    expect(profilerScript).toContain('data-terminal-loading-overlay');
    expect(profilerScript).not.toContain('Connecting to terminal…');
    expect(profilerScript).not.toContain('Attaching terminal…');
    expect(profilerScript).not.toContain('Restoring terminal output…');
  });

  it('fails partial hidden-wake profile coverage by default and exposes exploratory opt-in', async () => {
    const matrixModule = await loadTerminalUiFluidityMatrixModule();

    expect(
      matrixModule.getIncompatibleProfilesForVariant(
        [
          'recent_hidden_switch',
          'interactive_verbose',
          'hidden_render_wake',
          'hidden_session_wake',
        ],
        'baseline',
      ),
    ).toEqual(['hidden_render_wake', 'hidden_session_wake']);
    expect(
      matrixModule.getIncompatibleProfilesForVariant(
        [
          'recent_hidden_switch',
          'interactive_verbose',
          'hidden_render_wake',
          'hidden_session_wake',
        ],
        'render_freeze',
      ),
    ).toEqual(['hidden_session_wake']);
    expect(
      matrixModule.getIncompatibleProfilesForVariant(
        [
          'recent_hidden_switch',
          'interactive_verbose',
          'hidden_render_wake',
          'hidden_session_wake',
        ],
        'hidden_session_dormancy',
      ),
    ).toEqual(['hidden_render_wake']);
  });
});
