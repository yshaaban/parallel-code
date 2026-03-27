#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS,
  getTerminalUiFluidityVariant,
} from './terminal-ui-fluidity-variants.mjs';
import {
  getDefaultTerminalUiFluidityGateProfiles,
  getDefaultTerminalUiFluidityGateVisibleTerminalCounts,
} from './terminal-ui-fluidity-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const UI_FLUIDITY_PROFILER = path.resolve(ROOT_DIR, 'scripts', 'profile-terminal-ui-fluidity.mjs');

const DEFAULT_PROFILES = getDefaultTerminalUiFluidityGateProfiles();
const DEFAULT_REPEATS = 3;
const DEFAULT_TERMINAL_COUNTS = [24];
const DEFAULT_VISIBLE_TERMINAL_COUNTS = getDefaultTerminalUiFluidityGateVisibleTerminalCounts();

function isHiddenWakeSuiteName(profile) {
  return (
    profile === 'hidden_switch' ||
    profile === 'hidden_render_wake' ||
    profile === 'hidden_session_wake'
  );
}

function createTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function defaultOutputDirectory() {
  return path.resolve(ROOT_DIR, 'artifacts', 'terminal-ui-fluidity', createTimestampForPath());
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseCommaSeparatedList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTerminalCounts(value) {
  const counts = parseCommaSeparatedList(value)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  if (counts.length === 0) {
    throw new Error('--terminals must include at least one positive integer');
  }
  return counts;
}

function parseVisibleTerminalCounts(value) {
  const counts = parseCommaSeparatedList(value)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  if (counts.length === 0) {
    throw new Error('--visible-terminal-counts must include at least one positive integer');
  }
  return counts;
}

function parseArgs(argv) {
  const options = {
    allowPartialProfiles: false,
    durationMs: 5_000,
    inputIntervalMs: 800,
    outDir: defaultOutputDirectory(),
    profiles: [...DEFAULT_PROFILES],
    repeats: DEFAULT_REPEATS,
    skipBuild: false,
    surface: 'agents',
    terminalCounts: [...DEFAULT_TERMINAL_COUNTS],
    visibleTerminalCounts: DEFAULT_VISIBLE_TERMINAL_COUNTS,
    trace: false,
    traceProfiles: [],
    variants: [...DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--allow-partial-profiles':
        options.allowPartialProfiles = true;
        break;
      case '--profiles':
        if (!next) {
          throw new Error('Missing value for --profiles');
        }
        options.profiles = parseCommaSeparatedList(next);
        index += 1;
        break;
      case '--variants':
        if (!next) {
          throw new Error('Missing value for --variants');
        }
        options.variants = parseCommaSeparatedList(next);
        index += 1;
        break;
      case '--terminals':
      case '--terminal-counts':
        if (!next) {
          throw new Error(`Missing value for ${arg}`);
        }
        options.terminalCounts = parseTerminalCounts(next);
        index += 1;
        break;
      case '--visible-terminal-counts':
        if (!next) {
          throw new Error('Missing value for --visible-terminal-counts');
        }
        options.visibleTerminalCounts = parseVisibleTerminalCounts(next);
        index += 1;
        break;
      case '--duration-ms':
        options.durationMs = parsePositiveInteger(next, '--duration-ms');
        index += 1;
        break;
      case '--input-interval-ms':
        options.inputIntervalMs = parsePositiveInteger(next, '--input-interval-ms');
        index += 1;
        break;
      case '--repeats':
        options.repeats = parsePositiveInteger(next, '--repeats');
        index += 1;
        break;
      case '--surface':
        if (next !== 'agents' && next !== 'shell') {
          throw new Error(`Unknown surface: ${next}`);
        }
        options.surface = next;
        index += 1;
        break;
      case '--out-dir':
        if (!next) {
          throw new Error('Missing value for --out-dir');
        }
        options.outDir = path.resolve(ROOT_DIR, next);
        index += 1;
        break;
      case '--trace':
        options.trace = true;
        break;
      case '--trace-profiles':
        if (!next) {
          throw new Error('Missing value for --trace-profiles');
        }
        options.traceProfiles = parseCommaSeparatedList(next);
        index += 1;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.profiles.length === 0) {
    throw new Error('--profiles must include at least one profile');
  }
  if (options.variants.length === 0) {
    throw new Error('--variants must include at least one variant');
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/terminal-ui-fluidity-matrix.mjs [options]

Options:
  --profiles <a,b,c>          Profiles to run per terminal count (default: ${DEFAULT_PROFILES.join(',')})
  --variants <a,b,c>          Variant presets to compare (default: ${DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS.join(',')})
  --terminals <a,b,c>         Terminal counts to profile (default: ${DEFAULT_TERMINAL_COUNTS.join(',')})
  --visible-terminal-counts <a,b,c>
                              Approximate visible terminal counts to profile
                              (default: ${DEFAULT_VISIBLE_TERMINAL_COUNTS.join(',')})
  --repeats <n>               Repeats per variant/count pair (default: ${DEFAULT_REPEATS})
  --duration-ms <n>           Measurement window per suite (default: 5000)
  --input-interval-ms <n>     Focused input probe interval (default: 800)
  --surface <agents|shell>    Surface to profile (default: agents)
  --out-dir <path>            Artifact directory (default: artifacts/terminal-ui-fluidity/<timestamp>)
  --trace                     Capture Chromium performance traces
  --trace-profiles <a,b,c>    Only capture traces for these profiles
  --allow-partial-profiles    Keep running when a variant only supports a subset
                              of the requested profiles and record an explicit warning
  --skip-build                Reuse existing browser artifacts
  --help                      Print this help and exit
`);
}

export function getCompatibleProfilesForVariant(profileNames, variantName) {
  const experiments = getTerminalUiFluidityVariant(variantName).experiments;

  return profileNames.filter((profileName) => {
    switch (profileName) {
      case 'hidden_render_wake':
        return (
          typeof experiments.hiddenTerminalHibernationDelayMs === 'number' &&
          typeof experiments.hiddenTerminalSessionDormancyDelayMs !== 'number'
        );
      case 'hidden_session_wake':
        return typeof experiments.hiddenTerminalSessionDormancyDelayMs === 'number';
      default:
        return true;
    }
  });
}

export function getIncompatibleProfilesForVariant(profileNames, variantName) {
  const compatibleProfiles = new Set(getCompatibleProfilesForVariant(profileNames, variantName));
  return profileNames.filter((profileName) => !compatibleProfiles.has(profileName));
}

function formatIncompatibleProfilesWarning(variantName, requestedProfiles, incompatibleProfiles) {
  return (
    `[ui-fluidity-matrix] variant=${variantName} only supports [` +
    `${requestedProfiles.filter((profileName) => !incompatibleProfiles.includes(profileName)).join(', ')}]` +
    ` from requested profiles [` +
    `${requestedProfiles.join(', ')}]; skipped incompatible profiles [` +
    `${incompatibleProfiles.join(', ')}]`
  );
}

async function runCommand(label, command, args, envOverrides = undefined) {
  console.log(`[ui-fluidity-matrix] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if ((exitCode ?? 1) !== 0) {
        reject(new Error(`${label} failed with exit code ${exitCode ?? 1}\n${stderr}`));
        return;
      }
      resolve({ stderr, stdout });
    });
  });
}

async function maybeBuildBrowserArtifacts(skipBuild) {
  if (skipBuild) {
    return;
  }

  await runCommand('prepare:browser-artifacts', 'npm', ['run', 'prepare:browser-artifacts']);
}

function collectMedian(values) {
  const finiteValues = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finiteValues.length === 0) {
    return 0;
  }

  const middleIndex = Math.floor((finiteValues.length - 1) / 2);
  if (finiteValues.length % 2 === 1) {
    return finiteValues[middleIndex];
  }

  const left = finiteValues[middleIndex] ?? 0;
  const right = finiteValues[middleIndex + 1] ?? left;
  return (left + right) / 2;
}

function collectNullableMedian(values) {
  const finiteValues = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finiteValues.length === 0) {
    return null;
  }

  const middleIndex = Math.floor((finiteValues.length - 1) / 2);
  if (finiteValues.length % 2 === 1) {
    return finiteValues[middleIndex] ?? null;
  }

  const left = finiteValues[middleIndex] ?? 0;
  const right = finiteValues[middleIndex + 1] ?? left;
  return (left + right) / 2;
}

function formatNullableMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}ms` : 'n/a';
}

function collectMedianSuiteSummaries(runs) {
  const aggregatedByProfile = new Map();

  for (const run of runs) {
    for (const suite of run.suites) {
      const existing = aggregatedByProfile.get(suite.profile) ?? [];
      existing.push(suite);
      aggregatedByProfile.set(suite.profile, existing);
    }
  }

  return [...aggregatedByProfile.entries()].map(([profile, suites]) => ({
    experiment: suites[0]?.experiment ?? null,
    focusedRoundTrip: {
      attemptedCount: collectMedian(suites.map((suite) => suite.focusedRoundTrip.attemptedCount)),
      p95Ms: collectNullableMedian(suites.map((suite) => suite.focusedRoundTrip.p95Ms)),
      timeoutCount: collectMedian(suites.map((suite) => suite.focusedRoundTrip.timeoutCount)),
    },
    frameGap: {
      p95Ms: collectMedian(suites.map((suite) => suite.frameGap.p95Ms)),
      pressureCounts: {
        critical: collectMedian(
          suites.map((suite) => suite.frameGap.pressureCounts?.critical ?? 0),
        ),
        elevated: collectMedian(
          suites.map((suite) => suite.frameGap.pressureCounts?.elevated ?? 0),
        ),
        stable: collectMedian(suites.map((suite) => suite.frameGap.pressureCounts?.stable ?? 0)),
      },
      overBudget16ms: collectMedian(suites.map((suite) => suite.frameGap.overBudget16ms)),
    },
    longTasks: {
      totalDurationMs: collectMedian(suites.map((suite) => suite.longTasks.totalDurationMs)),
    },
    profile,
    runtimePerFrame: suites.some((suite) => suite.runtimePerFrame)
      ? {
          activeWebglContextsP95: collectMedian(
            suites.map((suite) => suite.runtimePerFrame?.activeWebglContextsP95 ?? 0),
          ),
          agentAnalysisP95Ms: collectMedian(
            suites.map((suite) => suite.runtimePerFrame?.agentAnalysisP95Ms ?? 0),
          ),
          ownerP95Ms: collectMedian(suites.map((suite) => suite.runtimePerFrame?.ownerP95Ms ?? 0)),
          schedulerDrainP95Ms: collectMedian(
            suites.map((suite) => suite.runtimePerFrame?.schedulerDrainP95Ms ?? 0),
          ),
          schedulerScanP95Ms: collectMedian(
            suites.map((suite) => suite.runtimePerFrame?.schedulerScanP95Ms ?? 0),
          ),
          visibleWebglContextsP95: collectMedian(
            suites.map((suite) => suite.runtimePerFrame?.visibleWebglContextsP95 ?? 0),
          ),
        }
      : null,
    terminalFit: suites.some((suite) => suite.terminalFit)
      ? {
          dirtyMarks: collectMedian(suites.map((suite) => suite.terminalFit?.dirtyMarks ?? 0)),
          dirtyReasonCounts: {
            'font-family': collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.['font-family'] ?? 0),
            ),
            'font-size': collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.['font-size'] ?? 0),
            ),
            intersection: collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.intersection ?? 0),
            ),
            resize: collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.resize ?? 0),
            ),
            theme: collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.theme ?? 0),
            ),
            unknown: collectMedian(
              suites.map((suite) => suite.terminalFit?.dirtyReasonCounts?.unknown ?? 0),
            ),
          },
          executionCounts: {
            lifecycle: collectMedian(
              suites.map((suite) => suite.terminalFit?.executionCounts?.lifecycle ?? 0),
            ),
            manager: collectMedian(
              suites.map((suite) => suite.terminalFit?.executionCounts?.manager ?? 0),
            ),
            'session-immediate': collectMedian(
              suites.map((suite) => suite.terminalFit?.executionCounts?.['session-immediate'] ?? 0),
            ),
            'session-raf': collectMedian(
              suites.map((suite) => suite.terminalFit?.executionCounts?.['session-raf'] ?? 0),
            ),
          },
          flushCalls: collectMedian(suites.map((suite) => suite.terminalFit?.flushCalls ?? 0)),
          geometryChangeFits: collectMedian(
            suites.map((suite) => suite.terminalFit?.geometryChangeFits ?? 0),
          ),
          idleFlushCalls: collectMedian(
            suites.map((suite) => suite.terminalFit?.idleFlushCalls ?? 0),
          ),
          noopSkips: collectMedian(suites.map((suite) => suite.terminalFit?.noopSkips ?? 0)),
          scheduleCalls: collectMedian(
            suites.map((suite) => suite.terminalFit?.scheduleCalls ?? 0),
          ),
          scheduleReasonCounts: {
            attach: collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.attach ?? 0),
            ),
            ready: collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.ready ?? 0),
            ),
            'renderer-loss': collectMedian(
              suites.map(
                (suite) => suite.terminalFit?.scheduleReasonCounts?.['renderer-loss'] ?? 0,
              ),
            ),
            restore: collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.restore ?? 0),
            ),
            'spawn-ready': collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.['spawn-ready'] ?? 0),
            ),
            startup: collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.startup ?? 0),
            ),
            visibility: collectMedian(
              suites.map((suite) => suite.terminalFit?.scheduleReasonCounts?.visibility ?? 0),
            ),
          },
        }
      : null,
    terminalRenderer: suites.some((suite) => suite.terminalRenderer)
      ? {
          acquireAttempts: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.acquireAttempts ?? 0),
          ),
          acquireHits: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.acquireHits ?? 0),
          ),
          acquireMisses: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.acquireMisses ?? 0),
          ),
          activeContextsCurrent: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.activeContextsCurrent ?? 0),
          ),
          activeContextsMax: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.activeContextsMax ?? 0),
          ),
          explicitReleases: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.explicitReleases ?? 0),
          ),
          fallbackActivations: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.fallbackActivations ?? 0),
          ),
          fallbackRecoveries: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.fallbackRecoveries ?? 0),
          ),
          rendererSwapCounts: {
            attach: collectMedian(
              suites.map((suite) => suite.terminalRenderer?.rendererSwapCounts?.attach ?? 0),
            ),
            restore: collectMedian(
              suites.map((suite) => suite.terminalRenderer?.rendererSwapCounts?.restore ?? 0),
            ),
            'selected-switch': collectMedian(
              suites.map(
                (suite) => suite.terminalRenderer?.rendererSwapCounts?.['selected-switch'] ?? 0,
              ),
            ),
          },
          visibleContextsCurrent: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.visibleContextsCurrent ?? 0),
          ),
          visibleContextsMax: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.visibleContextsMax ?? 0),
          ),
          webglEvictions: collectMedian(
            suites.map((suite) => suite.terminalRenderer?.webglEvictions ?? 0),
          ),
        }
      : null,
    switchWake: suites.some((suite) => suite.switchWake)
      ? {
          appPostInputReadyEchoFocusedBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.appPostInputReadyEchoFocusedBytes ?? 0),
          ),
          appPostInputReadyEchoFocusedQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.appPostInputReadyEchoFocusedQueueAgeMs ?? 0),
          ),
          appPostInputReadyEchoFramePressureLevel:
            suites.find((suite) => suite.switchWake?.appPostInputReadyEchoFramePressureLevel)
              ?.switchWake?.appPostInputReadyEchoFramePressureLevel ?? null,
          appPostInputReadyEchoMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.appPostInputReadyEchoMs ?? null),
          ),
          appPostInputReadyEchoNonTargetVisibleBytes: collectMedian(
            suites.map(
              (suite) => suite.switchWake?.appPostInputReadyEchoNonTargetVisibleBytes ?? 0,
            ),
          ),
          appPostInputReadyEchoReason:
            suites.find((suite) => suite.switchWake?.appPostInputReadyEchoReason)?.switchWake
              ?.appPostInputReadyEchoReason ?? null,
          appPostInputReadyEchoVisibleBackgroundBytes: collectMedian(
            suites.map(
              (suite) => suite.switchWake?.appPostInputReadyEchoVisibleBackgroundBytes ?? 0,
            ),
          ),
          appPostInputReadyEchoVisibleBackgroundQueueAgeMs: collectMedian(
            suites.map(
              (suite) => suite.switchWake?.appPostInputReadyEchoVisibleBackgroundQueueAgeMs ?? 0,
            ),
          ),
          appFirstPaintMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.appFirstPaintMs ?? null),
          ),
          appInputReadyMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.appInputReadyMs ?? null),
          ),
          appSwitchDurationMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.appSwitchDurationMs ?? null),
          ),
          appSwitchReason:
            suites.find((suite) => suite.switchWake?.appSwitchReason)?.switchWake
              ?.appSwitchReason ?? null,
          applyMs: collectMedian(suites.map((suite) => suite.switchWake?.applyMs ?? 0)),
          chunkCount: collectMedian(suites.map((suite) => suite.switchWake?.chunkCount ?? 0)),
          firstPaintMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.firstPaintMs ?? null),
          ),
          firstPaintFramePressureLevel:
            suites.find((suite) => suite.switchWake?.firstPaintFramePressureLevel)?.switchWake
              ?.firstPaintFramePressureLevel ?? null,
          firstPaintFocusedBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintFocusedBytes ?? 0),
          ),
          firstPaintFocusedQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintFocusedQueueAgeMs ?? 0),
          ),
          firstPaintHiddenBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintHiddenBytes ?? 0),
          ),
          firstPaintHiddenQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintHiddenQueueAgeMs ?? 0),
          ),
          firstPaintNonTargetVisibleBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintNonTargetVisibleBytes ?? 0),
          ),
          firstPaintSwitchTargetVisibleBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.firstPaintSwitchTargetVisibleBytes ?? 0),
          ),
          focusedBytes: collectMedian(suites.map((suite) => suite.switchWake?.focusedBytes ?? 0)),
          focusedQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.focusedQueueAgeMs ?? 0),
          ),
          hiddenBytes: collectMedian(suites.map((suite) => suite.switchWake?.hiddenBytes ?? 0)),
          hiddenQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.hiddenQueueAgeMs ?? 0),
          ),
          inputReadyMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.inputReadyMs ?? null),
          ),
          inputReadyFramePressureLevel:
            suites.find((suite) => suite.switchWake?.inputReadyFramePressureLevel)?.switchWake
              ?.inputReadyFramePressureLevel ?? null,
          inputReadyFocusedBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadyFocusedBytes ?? 0),
          ),
          inputReadyFocusedQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadyFocusedQueueAgeMs ?? 0),
          ),
          inputReadyHiddenBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadyHiddenBytes ?? 0),
          ),
          inputReadyHiddenQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadyHiddenQueueAgeMs ?? 0),
          ),
          inputReadyNonTargetVisibleBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadyNonTargetVisibleBytes ?? 0),
          ),
          inputReadySwitchTargetVisibleBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.inputReadySwitchTargetVisibleBytes ?? 0),
          ),
          pauseMs: collectMedian(suites.map((suite) => suite.switchWake?.pauseMs ?? 0)),
          postInputReadyEchoDelayMs: collectNullableMedian(
            suites.map((suite) => suite.switchWake?.postInputReadyEchoDelayMs ?? null),
          ),
          replayEntryCountAfterSwitch: collectMedian(
            suites.map((suite) => suite.switchWake?.replayEntryCountAfterSwitch ?? 0),
          ),
          recoveryFetchMs: collectMedian(
            suites.map((suite) => suite.switchWake?.recoveryFetchMs ?? 0),
          ),
          recoveryRequestStateBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.recoveryRequestStateBytes ?? 0),
          ),
          restoreTotalMs: collectMedian(
            suites.map((suite) => suite.switchWake?.restoreTotalMs ?? 0),
          ),
          recoveryKind:
            suites.find((suite) => suite.switchWake?.recoveryKind)?.switchWake?.recoveryKind ??
            null,
          roundTripMs: collectMedian(suites.map((suite) => suite.switchWake?.roundTripMs ?? 0)),
          resumeMs: collectMedian(suites.map((suite) => suite.switchWake?.resumeMs ?? 0)),
          selectedRecoveryActive:
            collectMedian(
              suites.map((suite) => (suite.switchWake?.selectedRecoveryActive ? 1 : 0)),
            ) >= 1,
          selectedRecoveryProtected:
            collectMedian(
              suites.map((suite) => (suite.switchWake?.selectedRecoveryProtected ? 1 : 0)),
            ) >= 1,
          switchTargetVisibleBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.switchTargetVisibleBytes ?? 0),
          ),
          switchTargetVisibleQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.switchTargetVisibleQueueAgeMs ?? 0),
          ),
          targetSurfaceTier:
            suites.find((suite) => suite.switchWake?.targetSurfaceTier)?.switchWake
              ?.targetSurfaceTier ?? null,
          targetWasDormant:
            collectMedian(suites.map((suite) => (suite.switchWake?.targetWasDormant ? 1 : 0))) >= 1,
          targetWasRenderHibernating:
            collectMedian(
              suites.map((suite) => (suite.switchWake?.targetWasRenderHibernating ? 1 : 0)),
            ) >= 1,
          visibleBackgroundBytes: collectMedian(
            suites.map((suite) => suite.switchWake?.visibleBackgroundBytes ?? 0),
          ),
          visibleBackgroundQueueAgeMs: collectMedian(
            suites.map((suite) => suite.switchWake?.visibleBackgroundQueueAgeMs ?? 0),
          ),
          waitForOutputIdleMs: collectMedian(
            suites.map((suite) => suite.switchWake?.waitForOutputIdleMs ?? 0),
          ),
          writtenBytes: collectMedian(suites.map((suite) => suite.switchWake?.writtenBytes ?? 0)),
        }
      : null,
    terminalOutputPerFrame: {
      activeVisibleBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeVisibleBytesP95 ?? 0),
      ),
      activeVisibleQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeVisibleQueueAgeP95Ms ?? 0),
      ),
      directWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.directWriteBytesP95 ?? 0),
      ),
      directWriteCallsP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.directWriteCallsP95 ?? 0),
      ),
      focusedWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.focusedWriteBytesP95 ?? 0),
      ),
      hiddenQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms),
      ),
      nonTargetVisibleBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.nonTargetVisibleBytesP95 ?? 0),
      ),
      queuedWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.queuedWriteBytesP95 ?? 0),
      ),
      queuedWriteCallsP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.queuedWriteCallsP95 ?? 0),
      ),
      suppressedBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.suppressedBytesP95),
      ),
      visibleBackgroundBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleBackgroundBytesP95 ?? 0),
      ),
      visibleBackgroundQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleBackgroundQueueAgeP95Ms ?? 0),
      ),
      visibleQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleQueueAgeP95Ms),
      ),
      writeBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.writeBytesP95),
      ),
    },
    terminalOutputTotals: {
      suppressedBytes: collectMedian(
        suites.map((suite) => suite.terminalOutputTotals.suppressedBytes),
      ),
    },
    terminalRender: {
      p95Ms: collectMedian(suites.map((suite) => suite.terminalRender.p95Ms)),
    },
    trace: suites.find((suite) => suite.trace)?.trace ?? null,
  }));
}

function createAggregateIndex(aggregatedRuns) {
  const index = new Map();
  for (const run of aggregatedRuns) {
    for (const suite of run.suites) {
      index.set(
        `${run.terminals}:${run.visibleTerminalCount ?? 'default'}:${suite.profile}:${run.variant}`,
        suite,
      );
    }
  }
  return index;
}

function getRelativeImprovementPercent(baselineValue, candidateValue) {
  if (!Number.isFinite(baselineValue) || !Number.isFinite(candidateValue) || baselineValue <= 0) {
    return null;
  }

  return ((baselineValue - candidateValue) / baselineValue) * 100;
}

function createHiddenSwitchSummaryLines(suite, switchReadyDelta) {
  const firstPaintMs = formatNullableMs(suite.switchWake.firstPaintMs);
  const inputReadyMs = formatNullableMs(suite.switchWake.inputReadyMs);

  return [
    `  hidden-switch first-paint=${firstPaintMs}` +
      ` input-ready=${inputReadyMs}` +
      (switchReadyDelta === null ? '' : ` (${switchReadyDelta.toFixed(1)}%)`) +
      ` roundtrip=${suite.switchWake.roundTripMs.toFixed(2)}ms` +
      ` app-first-paint=${formatNullableMs(suite.switchWake.appFirstPaintMs)}` +
      ` app-input-ready=${formatNullableMs(suite.switchWake.appInputReadyMs)}` +
      ` app-switch=${formatNullableMs(suite.switchWake.appSwitchDurationMs)}` +
      ` reason=${suite.switchWake.appSwitchReason ?? 'none'}` +
      ` tier=${suite.switchWake.targetSurfaceTier ?? 'unknown'}` +
      ` dormant=${String(suite.switchWake.targetWasDormant)}` +
      ` hibernating=${String(suite.switchWake.targetWasRenderHibernating)}` +
      ` restore=${suite.switchWake.restoreTotalMs.toFixed(2)}ms` +
      ` pause=${suite.switchWake.pauseMs.toFixed(2)}ms` +
      ` fetch=${suite.switchWake.recoveryFetchMs.toFixed(2)}ms` +
      ` apply=${suite.switchWake.applyMs.toFixed(2)}ms` +
      ` resume=${suite.switchWake.resumeMs.toFixed(2)}ms` +
      ` idle=${suite.switchWake.waitForOutputIdleMs.toFixed(2)}ms` +
      ` chunks=${suite.switchWake.chunkCount.toFixed(0)}` +
      ` later-replays=${suite.switchWake.replayEntryCountAfterSwitch.toFixed(0)}` +
      ` kind=${suite.switchWake.recoveryKind ?? 'none'}` +
      ` selected-recovery-active=${String(suite.switchWake.selectedRecoveryActive)}` +
      ` selected-recovery-protected=${String(suite.switchWake.selectedRecoveryProtected)}` +
      ` request-state-bytes=${suite.switchWake.recoveryRequestStateBytes.toFixed(0)}` +
      ` bytes=${suite.switchWake.writtenBytes.toFixed(0)}`,
    `  switch-window bytes switch-target=${suite.switchWake.switchTargetVisibleBytes.toFixed(0)}` +
      ` visible-background=${suite.switchWake.visibleBackgroundBytes.toFixed(0)}` +
      ` focused=${suite.switchWake.focusedBytes.toFixed(0)}` +
      ` hidden=${suite.switchWake.hiddenBytes.toFixed(0)}` +
      ` queue switch-target=${suite.switchWake.switchTargetVisibleQueueAgeMs.toFixed(2)}ms` +
      ` visible-background=${suite.switchWake.visibleBackgroundQueueAgeMs.toFixed(2)}ms` +
      ` focused=${suite.switchWake.focusedQueueAgeMs.toFixed(2)}ms` +
      ` hidden=${suite.switchWake.hiddenQueueAgeMs.toFixed(2)}ms`,
    `  switch-window phase-samples first-paint pressure=${suite.switchWake.firstPaintFramePressureLevel ?? 'n/a'}` +
      ` focused=${suite.switchWake.firstPaintFocusedBytes.toFixed(0)}` +
      ` focused-queue=${suite.switchWake.firstPaintFocusedQueueAgeMs.toFixed(2)}ms` +
      ` hidden=${suite.switchWake.firstPaintHiddenBytes.toFixed(0)}` +
      ` hidden-queue=${suite.switchWake.firstPaintHiddenQueueAgeMs.toFixed(2)}ms` +
      ` non-target-visible=${suite.switchWake.firstPaintNonTargetVisibleBytes.toFixed(0)}` +
      ` switch-target=${suite.switchWake.firstPaintSwitchTargetVisibleBytes.toFixed(0)}` +
      ` input-ready pressure=${suite.switchWake.inputReadyFramePressureLevel ?? 'n/a'}` +
      ` focused=${suite.switchWake.inputReadyFocusedBytes.toFixed(0)}` +
      ` focused-queue=${suite.switchWake.inputReadyFocusedQueueAgeMs.toFixed(2)}ms` +
      ` hidden=${suite.switchWake.inputReadyHiddenBytes.toFixed(0)}` +
      ` hidden-queue=${suite.switchWake.inputReadyHiddenQueueAgeMs.toFixed(2)}ms` +
      ` non-target-visible=${suite.switchWake.inputReadyNonTargetVisibleBytes.toFixed(0)}` +
      ` switch-target=${suite.switchWake.inputReadySwitchTargetVisibleBytes.toFixed(0)}`,
    `  post-input-ready echo delay=${formatNullableMs(suite.switchWake.postInputReadyEchoDelayMs)}` +
      ` app-echo=${formatNullableMs(suite.switchWake.appPostInputReadyEchoMs)}` +
      ` reason=${suite.switchWake.appPostInputReadyEchoReason ?? 'none'}` +
      ` pressure=${suite.switchWake.appPostInputReadyEchoFramePressureLevel ?? 'n/a'}` +
      ` focused=${suite.switchWake.appPostInputReadyEchoFocusedBytes.toFixed(0)}` +
      ` non-target-visible=${suite.switchWake.appPostInputReadyEchoNonTargetVisibleBytes.toFixed(0)}` +
      ` visible-background=${suite.switchWake.appPostInputReadyEchoVisibleBackgroundBytes.toFixed(0)}` +
      ` focused-queue=${suite.switchWake.appPostInputReadyEchoFocusedQueueAgeMs.toFixed(2)}ms` +
      ` visible-background-queue=${suite.switchWake.appPostInputReadyEchoVisibleBackgroundQueueAgeMs.toFixed(2)}ms`,
  ];
}

function createMarkdownSummary(summary) {
  const lines = ['# Terminal UI Fluidity Experiment Matrix', ''];
  const aggregateIndex = createAggregateIndex(summary.aggregatedRuns);

  if (summary.profileCompatibilityWarnings.length > 0) {
    lines.push('## Compatibility Warnings', '');
    for (const warning of summary.profileCompatibilityWarnings) {
      const visibleTerminalLabel =
        warning.visibleTerminalCount === null ? 'default visible set' : `${warning.visibleTerminalCount} visible`;
      lines.push(
        `- variant=${warning.variant} terminals=${warning.terminals} visible=${visibleTerminalLabel} repeat=${warning.repeat}: ` +
          `requested [${warning.requestedProfiles.join(', ')}], skipped incompatible [${warning.incompatibleProfiles.join(', ')}]`,
      );
    }
    lines.push('');
  }

  for (const run of summary.aggregatedRuns) {
    const visibleTerminalLabel =
      run.visibleTerminalCount === null ? '' : ` / ${run.visibleTerminalCount} visible terminals`;
    lines.push(
      `## ${run.variant} @ ${run.surface} / ${run.terminals} terminals${visibleTerminalLabel}`,
    );
    for (const suite of run.suites) {
      const baselineSuite =
        aggregateIndex.get(
          `${run.terminals}:${run.visibleTerminalCount ?? 'default'}:${suite.profile}:baseline`,
        ) ?? null;
      const frameGapDelta =
        baselineSuite === null
          ? null
          : getRelativeImprovementPercent(baselineSuite.frameGap.p95Ms, suite.frameGap.p95Ms);
      const roundTripDelta =
        baselineSuite === null
          ? null
          : getRelativeImprovementPercent(
              baselineSuite.focusedRoundTrip.p95Ms,
              suite.focusedRoundTrip.p95Ms,
            );
      const renderDelta =
        baselineSuite === null
          ? null
          : getRelativeImprovementPercent(
              baselineSuite.terminalRender.p95Ms,
              suite.terminalRender.p95Ms,
            );
      const hiddenQueueDelta =
        baselineSuite === null
          ? null
          : getRelativeImprovementPercent(
              baselineSuite.terminalOutputPerFrame.hiddenQueueAgeP95Ms,
              suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms,
            );
      const switchReadyDelta =
        baselineSuite?.switchWake == null || suite.switchWake == null
          ? null
          : getRelativeImprovementPercent(
              baselineSuite.switchWake.inputReadyMs,
              suite.switchWake.inputReadyMs,
            );

      lines.push(
        `- ${suite.profile}: frame-gap p95=${suite.frameGap.p95Ms.toFixed(2)}ms` +
          (frameGapDelta === null ? '' : ` (${frameGapDelta.toFixed(1)}% vs baseline)`) +
          ` longtasks=${suite.longTasks.totalDurationMs.toFixed(2)}ms` +
          ` ${isHiddenWakeSuiteName(suite.profile) ? 'hidden-switch roundtrip' : 'roundtrip'} p95=${formatNullableMs(suite.focusedRoundTrip.p95Ms)}` +
          (roundTripDelta === null ? '' : ` (${roundTripDelta.toFixed(1)}%)`) +
          ` render p95=${suite.terminalRender.p95Ms.toFixed(2)}ms` +
          (renderDelta === null ? '' : ` (${renderDelta.toFixed(1)}%)`) +
          ` focused-bytes p95=${suite.terminalOutputPerFrame.focusedWriteBytesP95.toFixed(0)}` +
          ` non-target-visible-bytes p95=${suite.terminalOutputPerFrame.nonTargetVisibleBytesP95.toFixed(0)}` +
          ` active-visible-bytes p95=${suite.terminalOutputPerFrame.activeVisibleBytesP95.toFixed(0)}` +
          ` visible-background-bytes p95=${suite.terminalOutputPerFrame.visibleBackgroundBytesP95.toFixed(0)}` +
          ` hidden-queue p95=${suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms.toFixed(2)}ms` +
          (hiddenQueueDelta === null ? '' : ` (${hiddenQueueDelta.toFixed(1)}%)`) +
          ` suppressed=${suite.terminalOutputTotals.suppressedBytes.toFixed(0)}`,
      );
      if (suite.terminalFit) {
        lines.push(
          `  terminal-fit dirty=${suite.terminalFit.dirtyMarks.toFixed(0)}` +
            ` resize=${suite.terminalFit.dirtyReasonCounts.resize.toFixed(0)}` +
            ` intersection=${suite.terminalFit.dirtyReasonCounts.intersection.toFixed(0)}` +
            ` font-size=${suite.terminalFit.dirtyReasonCounts['font-size'].toFixed(0)}` +
            ` font-family=${suite.terminalFit.dirtyReasonCounts['font-family'].toFixed(0)}` +
            ` theme=${suite.terminalFit.dirtyReasonCounts.theme.toFixed(0)}` +
            ` flushes=${suite.terminalFit.flushCalls.toFixed(0)}` +
            ` idle-flushes=${suite.terminalFit.idleFlushCalls.toFixed(0)}` +
            ` lifecycle-fits=${suite.terminalFit.executionCounts.lifecycle.toFixed(0)}` +
            ` manager-fits=${suite.terminalFit.executionCounts.manager.toFixed(0)}` +
            ` session-immediate-fits=${suite.terminalFit.executionCounts['session-immediate'].toFixed(0)}` +
            ` session-raf-fits=${suite.terminalFit.executionCounts['session-raf'].toFixed(0)}` +
            ` geometry-change-fits=${suite.terminalFit.geometryChangeFits.toFixed(0)}` +
            ` noop-skips=${suite.terminalFit.noopSkips.toFixed(0)}` +
            ` schedules=${suite.terminalFit.scheduleCalls.toFixed(0)}` +
            ` startup=${suite.terminalFit.scheduleReasonCounts.startup.toFixed(0)}` +
            ` attach=${suite.terminalFit.scheduleReasonCounts.attach.toFixed(0)}` +
            ` spawn-ready=${suite.terminalFit.scheduleReasonCounts['spawn-ready'].toFixed(0)}` +
            ` restore=${suite.terminalFit.scheduleReasonCounts.restore.toFixed(0)}` +
            ` renderer-loss=${suite.terminalFit.scheduleReasonCounts['renderer-loss'].toFixed(0)}` +
            ` ready=${suite.terminalFit.scheduleReasonCounts.ready.toFixed(0)}` +
            ` visibility=${suite.terminalFit.scheduleReasonCounts.visibility.toFixed(0)}`,
        );
      }
      if (suite.runtimePerFrame) {
        lines.push(
          `  runtime-per-frame owner-p95=${suite.runtimePerFrame.ownerP95Ms.toFixed(2)}ms` +
            ` analysis-p95=${suite.runtimePerFrame.agentAnalysisP95Ms.toFixed(2)}ms` +
            ` scan-p95=${suite.runtimePerFrame.schedulerScanP95Ms.toFixed(2)}ms` +
            ` drain-p95=${suite.runtimePerFrame.schedulerDrainP95Ms.toFixed(2)}ms` +
            ` active-webgl-p95=${suite.runtimePerFrame.activeWebglContextsP95.toFixed(0)}` +
            ` visible-webgl-p95=${suite.runtimePerFrame.visibleWebglContextsP95.toFixed(0)}`,
        );
      }
      if (suite.terminalRenderer) {
        lines.push(
          `  terminal-renderer acquire-attempts=${suite.terminalRenderer.acquireAttempts.toFixed(0)}` +
            ` hits=${suite.terminalRenderer.acquireHits.toFixed(0)}` +
            ` misses=${suite.terminalRenderer.acquireMisses.toFixed(0)}` +
            ` evictions=${suite.terminalRenderer.webglEvictions.toFixed(0)}` +
            ` fallbacks=${suite.terminalRenderer.fallbackActivations.toFixed(0)}` +
            ` recoveries=${suite.terminalRenderer.fallbackRecoveries.toFixed(0)}` +
            ` releases=${suite.terminalRenderer.explicitReleases.toFixed(0)}` +
            ` active-max=${suite.terminalRenderer.activeContextsMax.toFixed(0)}` +
            ` visible-max=${suite.terminalRenderer.visibleContextsMax.toFixed(0)}` +
            ` attach-swaps=${suite.terminalRenderer.rendererSwapCounts.attach.toFixed(0)}` +
            ` restore-swaps=${suite.terminalRenderer.rendererSwapCounts.restore.toFixed(0)}` +
            ` selected-switch-swaps=${suite.terminalRenderer.rendererSwapCounts['selected-switch'].toFixed(0)}`,
        );
      }
      if (suite.switchWake) {
        lines.push(...createHiddenSwitchSummaryLines(suite, switchReadyDelta));
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  await maybeBuildBrowserArtifacts(options.skipBuild);

  const profileCompatibilityWarnings = [];
  const runs = [];
  const visibleTerminalCounts =
    options.visibleTerminalCounts === null ? [null] : options.visibleTerminalCounts;
  for (const variant of options.variants) {
    for (const terminalCount of options.terminalCounts) {
      for (const visibleTerminalCount of visibleTerminalCounts) {
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          const compatibleProfiles = getCompatibleProfilesForVariant(options.profiles, variant);
          const incompatibleProfiles = getIncompatibleProfilesForVariant(options.profiles, variant);
          if (incompatibleProfiles.length > 0) {
            const warningMessage = formatIncompatibleProfilesWarning(
              variant,
              options.profiles,
              incompatibleProfiles,
            );
            if (!options.allowPartialProfiles) {
              throw new Error(
                `${warningMessage}. Pass --allow-partial-profiles only for explicitly exploratory runs.`,
              );
            }

            console.warn(warningMessage);
            profileCompatibilityWarnings.push({
              incompatibleProfiles,
              repeat,
              requestedProfiles: [...options.profiles],
              terminals: terminalCount,
              variant,
              visibleTerminalCount,
            });
          }
          if (compatibleProfiles.length === 0) {
            console.log(
              `[ui-fluidity-matrix] skipping variant=${variant} because none of the requested profiles apply`,
            );
            continue;
          }

          const runSegments = [options.outDir, variant, `${options.surface}-${terminalCount}`];
          if (visibleTerminalCount !== null) {
            runSegments.push(`visible-${visibleTerminalCount}`);
          }
          runSegments.push(`repeat-${repeat}`);
          const runOutDir = path.resolve(...runSegments);
          const profilerArgs = [
            UI_FLUIDITY_PROFILER,
            '--launch-server',
            '--variant',
            variant,
            '--surface',
            options.surface,
            '--profiles',
            compatibleProfiles.join(','),
            '--terminals',
            String(terminalCount),
            '--duration-ms',
            String(options.durationMs),
            '--input-interval-ms',
            String(options.inputIntervalMs),
            '--out-dir',
            runOutDir,
          ];

          if (visibleTerminalCount !== null) {
            profilerArgs.push('--visible-terminal-count', String(visibleTerminalCount));
          }
          if (options.trace) {
            profilerArgs.push('--trace');
          }
          if (options.traceProfiles.length > 0) {
            profilerArgs.push('--trace-profiles', options.traceProfiles.join(','));
          }

          const runLabel =
            `variant=${variant} surface=${options.surface} terminals=${terminalCount}` +
            (visibleTerminalCount === null ? '' : ` visible=${visibleTerminalCount}`) +
            ` repeat=${repeat}`;
          await runCommand(runLabel, process.execPath, profilerArgs, {
            PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK: '1',
          });

          const rawSummary = await readFile(path.resolve(runOutDir, 'summary.json'), 'utf8');
          const parsedSummary = JSON.parse(rawSummary);
          runs.push({
            artifactDir: runOutDir,
            repeat,
            suites: parsedSummary.suites,
            surface: options.surface,
            terminals: terminalCount,
            variant,
            visibleTerminalCount,
          });
        }
      }
    }
  }

  const groupedRuns = new Map();
  for (const run of runs) {
    const key = `${run.variant}:${run.surface}:${run.terminals}:${run.visibleTerminalCount ?? 'default'}`;
    const existing = groupedRuns.get(key) ?? [];
    existing.push(run);
    groupedRuns.set(key, existing);
  }

  const aggregatedRuns = [...groupedRuns.entries()]
    .map(([key, grouped]) => {
      const [variant, surface, terminalsText, visibleTerminalText] = key.split(':');
      return {
        artifactDirs: grouped.map((entry) => entry.artifactDir),
        repeats: grouped.length,
        suites: collectMedianSuiteSummaries(grouped),
        surface,
        terminals: Number.parseInt(terminalsText, 10),
        visibleTerminalCount:
          visibleTerminalText === 'default' ? null : Number.parseInt(visibleTerminalText, 10),
        variant,
      };
    })
    .sort((left, right) => {
      const variantComparison = left.variant.localeCompare(right.variant);
      if (variantComparison !== 0) {
        return variantComparison;
      }
      const visibleCountLeft = left.visibleTerminalCount ?? Number.NEGATIVE_INFINITY;
      const visibleCountRight = right.visibleTerminalCount ?? Number.NEGATIVE_INFINITY;
      if (visibleCountLeft !== visibleCountRight) {
        return visibleCountLeft - visibleCountRight;
      }
      return left.terminals - right.terminals;
    });

  const summary = {
    aggregatedRuns,
    generatedAt: new Date().toISOString(),
    options,
    profileCompatibilityWarnings,
    runs,
  };

  await writeFile(
    path.resolve(options.outDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.resolve(options.outDir, 'summary.md'),
    createMarkdownSummary(summary),
    'utf8',
  );

  console.log(`[ui-fluidity-matrix] artifacts written to ${options.outDir}`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
