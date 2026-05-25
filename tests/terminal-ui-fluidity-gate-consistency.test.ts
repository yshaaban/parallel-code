import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

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
    expect(profilerScript).toContain('alignViewportToVisibleTerminalCount');
    expect(profilerScript).toContain('terminal input buffered');
    expect(profilerScript).toContain('terminal input split lease-wait');
    expect(profilerScript).toContain('command-result p50');
    expect(profilerScript).toContain('accepted-settle p95');
    expect(profilerScript).toContain('renderer terminal-input buffered-chars-max');
    expect(profilerScript).toContain('browser control-client sends');
    expect(profilerScript).toContain('BROWSER_CONTROL_CLIENT_DETAIL_TYPES');
    expect(profilerScript).toContain('nonzero-buffered');
    expect(profilerScript).toContain('post-buffered-max');
    expect(profilerScript).toContain('send-duration-p95');
    expect(profilerScript).toContain('terminal flow-control pauses');
    expect(profilerScript).toContain('backend input trace completed');
    expect(profilerScript).toContain('backend-output-buffer-p95');
    expect(profilerScript).toContain('browser-delivery-p95');
    expect(profilerScript).toContain('browser-transport-delivery-p95');
    expect(profilerScript).toContain('browser-channel-dispatch-p95');
    expect(profilerScript).toContain('command-ack-p95');
    expect(profilerScript).toContain('pty-write-to-command-ack-p95');
    expect(profilerScript).toContain('browser-control buffered-max');
    expect(profilerScript).toContain('pty-echo-p95');
    expect(profilerScript).toContain('get_backend_runtime_diagnostics');
    expect(profilerScript).toContain('reset_backend_runtime_diagnostics');
    expect(profilerScript).toContain('__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ = false');
    expect(profilerScript).toContain('active-visible-bytes-p95');
    expect(profilerScript).toContain('visible-background-started-before-input-count');
    expect(profilerScript).toContain('visible-background-started-before-input-bytes');
    expect(profilerScript).toContain('focused round-trip split input-dispatch-p95');
    expect(profilerScript).toContain('render-after-receive-p95');
    expect(profilerScript).toContain('rendered-timeouts');
    expect(profilerScript).toContain('plain-bytes=');
    expect(profilerScript).toContain('control-bytes=');
    expect(profilerScript).toContain('redraw-control-bytes=');
    expect(profilerScript).toContain('plain-write-duration-p95');
    expect(profilerScript).toContain('control-write-duration-p95');
    expect(profilerScript).toContain('redraw-control-write-duration-p95');
    expect(profilerScript).toContain('terminal-write finalization p95');
    expect(profilerScript).toContain('write-finalization-p95');
    expect(profilerScript).not.toContain('Connecting to terminal…');
    expect(profilerScript).not.toContain('Attaching terminal…');
    expect(profilerScript).not.toContain('Restoring terminal output…');
  });

  it('keeps matrix summaries carrying focused round-trip, input, and flow split diagnostics', async () => {
    const matrixScript = await readRepoFile('scripts/terminal-ui-fluidity-matrix.mjs');

    expect(matrixScript).toContain('focused-roundtrip-split input-dispatch-p95');
    expect(matrixScript).toContain('rendered-p95=');
    expect(matrixScript).toContain('render-after-receive-p95');
    expect(matrixScript).toContain('plain-bytes p95');
    expect(matrixScript).toContain('control-bytes p95');
    expect(matrixScript).toContain('redraw-control-bytes p95');
    expect(matrixScript).toContain('plain-write-duration p95');
    expect(matrixScript).toContain('control-write-duration p95');
    expect(matrixScript).toContain('redraw-control-write-duration p95');
    expect(matrixScript).toContain('write-finalization p95');
    expect(matrixScript).toContain('write-finalization-p95');
    expect(matrixScript).toContain('plain-bytes-p95=');
    expect(matrixScript).toContain('control-bytes-p95=');
    expect(matrixScript).toContain('redraw-control-bytes-p95=');
    expect(matrixScript).toContain('plain-write-duration-p95=');
    expect(matrixScript).toContain('control-write-duration-p95=');
    expect(matrixScript).toContain('redraw-control-write-duration-p95=');
    expect(matrixScript).toContain('focused-input-output focused-bytes-p95');
    expect(matrixScript).toContain('visible-background-started-before-input-count-p95');
    expect(matrixScript).toContain('visible-background-started-before-input-bytes-p95');
    expect(matrixScript).toContain('terminal-input buffered-p95');
    expect(matrixScript).toContain('terminal-input-split lease-wait-p95');
    expect(matrixScript).toContain('command-result-p95');
    expect(matrixScript).toContain('accepted-settle-p95');
    expect(matrixScript).toContain('renderer-terminal-input buffered-chars-max');
    expect(matrixScript).toContain('browser-control-client sends');
    expect(matrixScript).toContain('BROWSER_CONTROL_CLIENT_DETAIL_TYPES');
    expect(matrixScript).toContain('nonzero-buffered');
    expect(matrixScript).toContain('post-buffered-max');
    expect(matrixScript).toContain('send-duration-p95');
    expect(matrixScript).toContain('terminal-flow pauses');
    expect(matrixScript).toContain('backend-input-trace completed');
    expect(matrixScript).toContain('backend-output-buffer-p95');
    expect(matrixScript).toContain('browser-delivery-p95');
    expect(matrixScript).toContain('browser-transport-delivery-p95');
    expect(matrixScript).toContain('browser-channel-dispatch-p95');
    expect(matrixScript).toContain('command-ack-p95');
    expect(matrixScript).toContain('pty-write-to-command-ack-p95');
    expect(matrixScript).toContain('control-buffered-max');
    expect(matrixScript).toContain('pty-echo-p95');
    expect(matrixScript).toContain('backend-pty-input enqueued');
    expect(matrixScript).toContain('Number.isFinite(value) && value >= 0');
    expect(matrixScript).toContain('timeoutCount: collectSum');
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

  it('evaluates provisional loaded browser fluidity budgets from aggregated matrix summaries', async () => {
    const gateModule = await loadTerminalUiFluidityGateModule();
    const observations = gateModule.evaluateTerminalUiFluidityBudgets({
      aggregatedRuns: [
        {
          surface: 'agents',
          terminals: 24,
          variant: 'product_default',
          visibleTerminalCount: 4,
          suites: [
            {
              focusedRoundTrip: { p95Ms: 1_800, timeoutCount: 1 },
              frameGap: { p95Ms: 300 },
              longTasks: { totalDurationMs: 6_200 },
              profile: 'interactive_verbose',
              terminalOutputPerFrame: { hiddenQueueAgeP95Ms: 0 },
              terminalRender: { p95Ms: 6_800 },
            },
            {
              focusedRoundTrip: { p95Ms: -1 },
              frameGap: { p95Ms: 120 },
              longTasks: { totalDurationMs: 1_000 },
              profile: 'bulk_text',
              terminalOutputPerFrame: { hiddenQueueAgeP95Ms: 0 },
              terminalRender: { p95Ms: 200 },
            },
          ],
        },
      ],
    });

    expect(observations.overallStatus).toBe('provisional-fail');
    expect(observations.failedChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'focused roundtrip p95',
          profile: 'interactive_verbose',
          status: 'provisional-fail',
        }),
        expect.objectContaining({
          actualMs: 1,
          maxMs: 0,
          metric: 'focused roundtrip timeouts',
          profile: 'interactive_verbose',
          status: 'provisional-fail',
          unit: 'count',
        }),
        expect.objectContaining({
          metric: 'frame-gap p95',
          profile: 'interactive_verbose',
          status: 'provisional-fail',
        }),
      ]),
    );
    expect(
      observations.failedChecks.some(
        (check) => check.metric === 'focused roundtrip p95' && check.profile === 'bulk_text',
      ),
    ).toBe(false);
  });
});
