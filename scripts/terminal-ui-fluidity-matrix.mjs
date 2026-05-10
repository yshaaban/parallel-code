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
  evaluateTerminalUiFluidityBudgets,
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
const BROWSER_CONTROL_CLIENT_DETAIL_TYPES = ['input', 'resize', 'pause', 'resume'];

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
    failOnBudget: false,
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
      case '--fail-on-budget':
        options.failOnBudget = true;
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
  --fail-on-budget            Exit non-zero after writing artifacts when provisional
                              UI-fluidity budgets fail
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

function collectSum(values) {
  return values
    .filter((value) => Number.isFinite(value))
    .reduce((total, value) => total + value, 0);
}

function collectNullableMedian(values) {
  const finiteValues = values
    .filter((value) => Number.isFinite(value) && value >= 0)
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

function collectBrowserControlClientTypeStats(suites, type) {
  return {
    nonZeroBufferedSendAttempts: collectSum(
      suites.map(
        (suite) => suite.browserControlClient?.byType?.[type]?.nonZeroBufferedSendAttempts ?? 0,
      ),
    ),
    postSendBufferedAmountMax: collectMedian(
      suites.map(
        (suite) => suite.browserControlClient?.byType?.[type]?.postSendBufferedAmountMax ?? 0,
      ),
    ),
    sendAttempts: collectSum(
      suites.map((suite) => suite.browserControlClient?.byType?.[type]?.sendAttempts ?? 0),
    ),
    sendBufferedAmountMax: collectMedian(
      suites.map((suite) => suite.browserControlClient?.byType?.[type]?.sendBufferedAmountMax ?? 0),
    ),
    sendDurationP95Ms: collectMedian(
      suites.map((suite) => suite.browserControlClient?.byType?.[type]?.sendDurationMs?.p95 ?? 0),
    ),
  };
}

function collectBrowserControlClientStatsByType(suites) {
  return Object.fromEntries(
    BROWSER_CONTROL_CLIENT_DETAIL_TYPES.map((type) => [
      type,
      collectBrowserControlClientTypeStats(suites, type),
    ]),
  );
}

function formatBrowserControlClientTypeStats(browserControlClient, type) {
  const stats = browserControlClient.byType?.[type] ?? {
    nonZeroBufferedSendAttempts: 0,
    postSendBufferedAmountMax: 0,
    sendAttempts: 0,
    sendBufferedAmountMax: 0,
    sendDurationP95Ms: 0,
  };
  return (
    `${type}-sends=${stats.sendAttempts.toFixed(0)}` +
    ` ${type}-nonzero-buffered=${stats.nonZeroBufferedSendAttempts.toFixed(0)}` +
    ` ${type}-buffered-max=${stats.sendBufferedAmountMax.toFixed(0)}` +
    ` ${type}-post-buffered-max=${stats.postSendBufferedAmountMax.toFixed(0)}` +
    ` ${type}-send-duration-p95=${stats.sendDurationP95Ms.toFixed(2)}ms`
  );
}

function formatBudgetValue(check, key) {
  const value = check[key];
  if (check.unit === 'count') {
    return Number.isFinite(value) ? value.toFixed(0) : 'n/a';
  }

  return formatNullableMs(value);
}

function formatNullableMs(value) {
  return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)}ms` : 'n/a';
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
      attemptedCount: collectSum(suites.map((suite) => suite.focusedRoundTrip.attemptedCount)),
      echoAfterDispatchP95Ms: collectMedian(
        suites.map((suite) => suite.focusedRoundTrip.echoAfterDispatchP95Ms ?? 0),
      ),
      inputDispatchP95Ms: collectMedian(
        suites.map((suite) => suite.focusedRoundTrip.inputDispatchP95Ms ?? 0),
      ),
      p95Ms: collectNullableMedian(suites.map((suite) => suite.focusedRoundTrip.p95Ms)),
      renderAfterReceiveP95Ms: collectMedian(
        suites.map((suite) => suite.focusedRoundTrip.renderAfterReceiveP95Ms ?? 0),
      ),
      renderedP95Ms: collectMedian(
        suites.map((suite) => suite.focusedRoundTrip.renderedP95Ms ?? 0),
      ),
      renderedTimeoutCount: collectSum(
        suites.map((suite) => suite.focusedRoundTrip.renderedTimeoutCount ?? 0),
      ),
      timeoutCount: collectSum(suites.map((suite) => suite.focusedRoundTrip.timeoutCount)),
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
      activeWriteAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeWriteAgeP95Ms ?? 0),
      ),
      activeWriteCountP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeWriteCountP95 ?? 0),
      ),
      activeVisibleBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeVisibleBytesP95 ?? 0),
      ),
      activeVisibleQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeVisibleQueueAgeP95Ms ?? 0),
      ),
      activeVisibleWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.activeVisibleWriteDurationP95Ms ?? 0),
      ),
      activeVisibleWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.activeVisibleWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      controlWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.controlWriteBytesP95 ?? 0),
      ),
      controlWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.controlWriteDurationP95Ms ?? 0),
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
      focusedWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.focusedWriteDurationP95Ms ?? 0),
      ),
      focusedWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.focusedWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      hiddenQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms),
      ),
      nonTargetVisibleActiveWriteAgeP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.nonTargetVisibleActiveWriteAgeP95Ms ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteCountP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.nonTargetVisibleActiveWriteCountP95 ?? 0,
        ),
      ),
      nonTargetVisibleBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.nonTargetVisibleBytesP95 ?? 0),
      ),
      plainWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.plainWriteBytesP95 ?? 0),
      ),
      plainWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.plainWriteDurationP95Ms ?? 0),
      ),
      queuedWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.queuedWriteBytesP95 ?? 0),
      ),
      queuedWriteCallsP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.queuedWriteCallsP95 ?? 0),
      ),
      queuedWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.queuedWriteDurationP95Ms ?? 0),
      ),
      queuedWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.queuedWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      redrawControlWriteBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.redrawControlWriteBytesP95 ?? 0),
      ),
      redrawControlWriteDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.redrawControlWriteDurationP95Ms ?? 0),
      ),
      suppressedBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.suppressedBytesP95),
      ),
      visibleBackgroundBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleBackgroundBytesP95 ?? 0),
      ),
      visibleBackgroundActiveWriteAgeP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.visibleBackgroundActiveWriteAgeP95Ms ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteCountP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.visibleBackgroundActiveWriteCountP95 ?? 0,
        ),
      ),
      visibleBackgroundQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleBackgroundQueueAgeP95Ms ?? 0),
      ),
      visibleBackgroundWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputPerFrame.visibleBackgroundWriteDurationP95Ms ?? 0,
        ),
      ),
      visibleBackgroundWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputPerFrame.visibleBackgroundWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      visibleQueueAgeP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.visibleQueueAgeP95Ms),
      ),
      writeBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.writeBytesP95),
      ),
      writeDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.writeDurationP95Ms ?? 0),
      ),
      writeFinalizationDurationP95Ms: collectMedian(
        suites.map((suite) => suite.terminalOutputPerFrame.writeFinalizationDurationP95Ms ?? 0),
      ),
    },
    terminalOutputDuringFocusedInputPerFrame: {
      activeWriteAgeP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.activeWriteAgeP95Ms ?? 0,
        ),
      ),
      activeWriteCountP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.activeWriteCountP95 ?? 0,
        ),
      ),
      activeVisibleBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.activeVisibleBytesP95 ?? 0,
        ),
      ),
      activeVisibleQueueAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.activeVisibleQueueAgeP95Ms ?? 0,
        ),
      ),
      controlWriteBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.controlWriteBytesP95 ?? 0,
        ),
      ),
      controlWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.controlWriteDurationP95Ms ?? 0,
        ),
      ),
      directWriteBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.directWriteBytesP95 ?? 0,
        ),
      ),
      directWriteCallsP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.directWriteCallsP95 ?? 0,
        ),
      ),
      focusedWriteBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.focusedWriteBytesP95 ?? 0,
        ),
      ),
      hiddenBytesP95: collectMedian(
        suites.map((suite) => suite.terminalOutputDuringFocusedInputPerFrame?.hiddenBytesP95 ?? 0),
      ),
      nonTargetVisibleActiveWriteAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.nonTargetVisibleActiveWriteAgeP95Ms ??
            0,
        ),
      ),
      nonTargetVisibleActiveWriteCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.nonTargetVisibleActiveWriteCountP95 ??
            0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedBeforeInputAgeP95Ms ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputBytesP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedBeforeInputBytesP95 ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedBeforeInputCountP95 ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedDuringInputAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedDuringInputAgeP95Ms ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedDuringInputBytesP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedDuringInputBytesP95 ?? 0,
        ),
      ),
      nonTargetVisibleActiveWriteStartedDuringInputCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleActiveWriteStartedDuringInputCountP95 ?? 0,
        ),
      ),
      nonTargetVisibleBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.nonTargetVisibleBytesP95 ?? 0,
        ),
      ),
      nonTargetVisibleWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.nonTargetVisibleWriteDurationP95Ms ?? 0,
        ),
      ),
      nonTargetVisibleWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.nonTargetVisibleWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      plainWriteBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.plainWriteBytesP95 ?? 0,
        ),
      ),
      plainWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.plainWriteDurationP95Ms ?? 0,
        ),
      ),
      queuedWriteBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.queuedWriteBytesP95 ?? 0,
        ),
      ),
      queuedWriteCallsP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.queuedWriteCallsP95 ?? 0,
        ),
      ),
      queuedQueueAgeP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.queuedQueueAgeP95Ms ?? 0,
        ),
      ),
      redrawControlWriteBytesP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.redrawControlWriteBytesP95 ?? 0,
        ),
      ),
      redrawControlWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.redrawControlWriteDurationP95Ms ?? 0,
        ),
      ),
      visibleBackgroundBytesP95: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.visibleBackgroundBytesP95 ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.visibleBackgroundActiveWriteAgeP95Ms ??
            0,
        ),
      ),
      visibleBackgroundActiveWriteCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.visibleBackgroundActiveWriteCountP95 ??
            0,
        ),
      ),
      visibleBackgroundActiveWriteStartedBeforeInputAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedBeforeInputAgeP95Ms ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteStartedBeforeInputBytesP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedBeforeInputBytesP95 ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteStartedBeforeInputCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedBeforeInputCountP95 ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteStartedDuringInputAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedDuringInputAgeP95Ms ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteStartedDuringInputBytesP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedDuringInputBytesP95 ?? 0,
        ),
      ),
      visibleBackgroundActiveWriteStartedDuringInputCountP95: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundActiveWriteStartedDuringInputCountP95 ?? 0,
        ),
      ),
      visibleBackgroundQueueAgeP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.visibleBackgroundQueueAgeP95Ms ?? 0,
        ),
      ),
      visibleBackgroundWriteDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.visibleBackgroundWriteDurationP95Ms ??
            0,
        ),
      ),
      visibleBackgroundWriteFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame
              ?.visibleBackgroundWriteFinalizationDurationP95Ms ?? 0,
        ),
      ),
      writeDurationP95Ms: collectMedian(
        suites.map(
          (suite) => suite.terminalOutputDuringFocusedInputPerFrame?.writeDurationP95Ms ?? 0,
        ),
      ),
      writeFinalizationDurationP95Ms: collectMedian(
        suites.map(
          (suite) =>
            suite.terminalOutputDuringFocusedInputPerFrame?.writeFinalizationDurationP95Ms ?? 0,
        ),
      ),
    },
    terminalOutputTotals: {
      suppressedBytes: collectMedian(
        suites.map((suite) => suite.terminalOutputTotals.suppressedBytes),
      ),
    },
    terminalInput: suites.some((suite) => suite.terminalInput)
      ? {
          acceptedP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.accepted?.p95Ms ?? 0),
          ),
          acceptedMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.accepted?.maxMs ?? 0),
          ),
          acceptedCount: collectMedian(
            suites.map((suite) => suite.terminalInput?.accepted?.count ?? 0),
          ),
          acceptedSettledP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.acceptedSettled?.p95Ms ?? 0),
          ),
          acceptedSettledMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.acceptedSettled?.maxMs ?? 0),
          ),
          acceptedSettledCount: collectMedian(
            suites.map((suite) => suite.terminalInput?.acceptedSettled?.count ?? 0),
          ),
          bufferedP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.buffered?.p95Ms ?? 0),
          ),
          bufferedMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.buffered?.maxMs ?? 0),
          ),
          dispatchedP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.dispatched?.p95Ms ?? 0),
          ),
          dispatchedMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.dispatched?.maxMs ?? 0),
          ),
          dispatchedCount: collectMedian(
            suites.map((suite) => suite.terminalInput?.dispatched?.count ?? 0),
          ),
          commandResultReceivedP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.commandResultReceived?.p95Ms ?? 0),
          ),
          commandResultReceivedMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.commandResultReceived?.maxMs ?? 0),
          ),
          commandResultReceivedCount: collectMedian(
            suites.map((suite) => suite.terminalInput?.commandResultReceived?.count ?? 0),
          ),
          leaseWaitP95Ms: collectMedian(
            suites.map((suite) => suite.terminalInput?.leaseWait?.p95Ms ?? 0),
          ),
          leaseWaitMaxMs: collectMedian(
            suites.map((suite) => suite.terminalInput?.leaseWait?.maxMs ?? 0),
          ),
          leaseWaitCount: collectMedian(
            suites.map((suite) => suite.terminalInput?.leaseWait?.count ?? 0),
          ),
          sentP95Ms: collectMedian(suites.map((suite) => suite.terminalInput?.sent?.p95Ms ?? 0)),
          sentMaxMs: collectMedian(suites.map((suite) => suite.terminalInput?.sent?.maxMs ?? 0)),
          sentCount: collectMedian(suites.map((suite) => suite.terminalInput?.sent?.count ?? 0)),
        }
      : null,
    rendererTerminalInput: suites.some((suite) => suite.rendererTerminalInput)
      ? {
          bufferedCharsMax: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.bufferedCharsMax ?? 0),
          ),
          droppedSuffixBatches: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.droppedSuffixBatches ?? 0),
          ),
          inFlightBatchesMax: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.inFlightBatchesMax ?? 0),
          ),
          queuedChunksMax: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.queuedChunksMax ?? 0),
          ),
          retrySchedules: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.retrySchedules ?? 0),
          ),
          sentBatchCharsMax: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.sentBatchCharsMax ?? 0),
          ),
          sentBatches: collectMedian(
            suites.map((suite) => suite.rendererTerminalInput?.sentBatches ?? 0),
          ),
        }
      : null,
    browserControlClient: suites.some((suite) => suite.browserControlClient)
      ? {
          byType: collectBrowserControlClientStatsByType(suites),
          nonZeroBufferedSendAttempts: collectSum(
            suites.map((suite) => suite.browserControlClient?.nonZeroBufferedSendAttempts ?? 0),
          ),
          postSendBufferedAmountMax: collectMedian(
            suites.map((suite) => suite.browserControlClient?.postSendBufferedAmountMax ?? 0),
          ),
          sendAttempts: collectSum(
            suites.map((suite) => suite.browserControlClient?.sendAttempts ?? 0),
          ),
          sendBufferedAmountMax: collectMedian(
            suites.map((suite) => suite.browserControlClient?.sendBufferedAmountMax ?? 0),
          ),
          sendDurationP95Ms: collectMedian(
            suites.map((suite) => suite.browserControlClient?.sendDurationP95Ms ?? 0),
          ),
        }
      : null,
    terminalFlowControl: suites.some((suite) => suite.terminalFlowControl)
      ? {
          avgPauseRequestWindowMs: collectMedian(
            suites.map((suite) => suite.terminalFlowControl?.avgPauseRequestWindowMs ?? 0),
          ),
          pauseRequests: collectMedian(
            suites.map((suite) => suite.terminalFlowControl?.pauseRequests ?? 0),
          ),
          resumeRequests: collectMedian(
            suites.map((suite) => suite.terminalFlowControl?.resumeRequests ?? 0),
          ),
        }
      : null,
    backendInputTrace: suites.some((suite) => suite.backendInputTrace)
      ? {
          activeTraceCount: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.activeTraceCount ?? 0),
          ),
          backendOutputBufferP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.backendOutputBufferP95Ms ?? 0),
          ),
          browserChannelDispatchP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.browserChannelDispatchP95Ms ?? 0),
          ),
          browserDeliveryP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.browserDeliveryP95Ms ?? 0),
          ),
          browserTransportDeliveryP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.browserTransportDeliveryP95Ms ?? 0),
          ),
          clientBufferP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.clientBufferP95Ms ?? 0),
          ),
          clientSendP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.clientSendP95Ms ?? 0),
          ),
          commandAckP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.commandAckP95Ms ?? 0),
          ),
          completedCount: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.completedCount ?? 0),
          ),
          droppedTraces: collectSum(
            suites.map((suite) => suite.backendInputTrace?.droppedTraces ?? 0),
          ),
          endToEndP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.endToEndP95Ms ?? 0),
          ),
          ptyEchoP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.ptyEchoP95Ms ?? 0),
          ),
          ptyWriteToCommandAckP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.ptyWriteToCommandAckP95Ms ?? 0),
          ),
          renderP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.renderP95Ms ?? 0),
          ),
          sendToEchoP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.sendToEchoP95Ms ?? 0),
          ),
          serverQueueP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.serverQueueP95Ms ?? 0),
          ),
          transportResidualP95Ms: collectMedian(
            suites.map((suite) => suite.backendInputTrace?.transportResidualP95Ms ?? 0),
          ),
        }
      : null,
    backendPtyInput: suites.some((suite) => suite.backendPtyInput)
      ? {
          coalescedMessages: collectMedian(
            suites.map((suite) => suite.backendPtyInput?.coalescedMessages ?? 0),
          ),
          enqueuedMessages: collectMedian(
            suites.map((suite) => suite.backendPtyInput?.enqueuedMessages ?? 0),
          ),
          flushes: collectMedian(suites.map((suite) => suite.backendPtyInput?.flushes ?? 0)),
          maxQueuedChars: collectMedian(
            suites.map((suite) => suite.backendPtyInput?.maxQueuedChars ?? 0),
          ),
          writeFailures: collectSum(
            suites.map((suite) => suite.backendPtyInput?.writeFailures ?? 0),
          ),
        }
      : null,
    backendBrowserControl: suites.some((suite) => suite.backendBrowserControl)
      ? {
          backpressureRejects: collectSum(
            suites.map((suite) => suite.backendBrowserControl?.backpressureRejects ?? 0),
          ),
          delayedQueueMaxAgeMs: collectMedian(
            suites.map((suite) => suite.backendBrowserControl?.delayedQueueMaxAgeMs ?? 0),
          ),
          delayedQueueMaxBytes: collectMedian(
            suites.map((suite) => suite.backendBrowserControl?.delayedQueueMaxBytes ?? 0),
          ),
          delayedQueueMaxDepth: collectMedian(
            suites.map((suite) => suite.backendBrowserControl?.delayedQueueMaxDepth ?? 0),
          ),
          maxBufferedAmountBytes: collectMedian(
            suites.map((suite) => suite.backendBrowserControl?.maxBufferedAmountBytes ?? 0),
          ),
          notOpenRejects: collectSum(
            suites.map((suite) => suite.backendBrowserControl?.notOpenRejects ?? 0),
          ),
          sendErrors: collectSum(
            suites.map((suite) => suite.backendBrowserControl?.sendErrors ?? 0),
          ),
        }
      : null,
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
  const budgetObservations = summary.budgetObservations;

  if (budgetObservations) {
    lines.push('## Budget Observations', '');
    lines.push(`- Overall: ${budgetObservations.overallStatus}`);
    lines.push(
      `- Checks: ${budgetObservations.checkedCount}; failures: ${budgetObservations.failedCount}`,
    );
    lines.push(
      '- Budgets are provisional product-profile observations. Use `--fail-on-budget` only when a branch is explicitly trying to satisfy this loaded browser lane.',
    );
    if (budgetObservations.failedChecks.length > 0) {
      lines.push('');
      lines.push('| Variant | Visible | Profile | Metric | Actual | Budget | Status |');
      lines.push('| --- | ---: | --- | --- | ---: | ---: | --- |');
      for (const check of budgetObservations.failedChecks) {
        const visibleLabel =
          check.visibleTerminalCount === null ? 'default' : String(check.visibleTerminalCount);
        lines.push(
          `| ${check.variant} | ${visibleLabel} | ${check.profile} | ${check.metric} | ` +
            `${formatBudgetValue(check, 'actualMs')} | ${formatBudgetValue(check, 'maxMs')} | ${check.status} |`,
        );
      }
    }
    lines.push('');
  }

  if (summary.profileCompatibilityWarnings.length > 0) {
    lines.push('## Compatibility Warnings', '');
    for (const warning of summary.profileCompatibilityWarnings) {
      const visibleTerminalLabel =
        warning.visibleTerminalCount === null
          ? 'default visible set'
          : `${warning.visibleTerminalCount} visible`;
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
          ` plain-bytes p95=${suite.terminalOutputPerFrame.plainWriteBytesP95.toFixed(0)}` +
          ` control-bytes p95=${suite.terminalOutputPerFrame.controlWriteBytesP95.toFixed(0)}` +
          ` redraw-control-bytes p95=${suite.terminalOutputPerFrame.redrawControlWriteBytesP95.toFixed(0)}` +
          ` write-duration p95=${suite.terminalOutputPerFrame.writeDurationP95Ms.toFixed(2)}ms` +
          ` plain-write-duration p95=${suite.terminalOutputPerFrame.plainWriteDurationP95Ms.toFixed(2)}ms` +
          ` control-write-duration p95=${suite.terminalOutputPerFrame.controlWriteDurationP95Ms.toFixed(2)}ms` +
          ` redraw-control-write-duration p95=${suite.terminalOutputPerFrame.redrawControlWriteDurationP95Ms.toFixed(2)}ms` +
          ` write-finalization p95=${suite.terminalOutputPerFrame.writeFinalizationDurationP95Ms.toFixed(2)}ms` +
          ` visible-background-write-duration p95=${suite.terminalOutputPerFrame.visibleBackgroundWriteDurationP95Ms.toFixed(2)}ms` +
          ` visible-background-write-finalization p95=${suite.terminalOutputPerFrame.visibleBackgroundWriteFinalizationDurationP95Ms.toFixed(2)}ms` +
          ` active-write-count p95=${suite.terminalOutputPerFrame.activeWriteCountP95.toFixed(0)}` +
          ` active-write-age p95=${suite.terminalOutputPerFrame.activeWriteAgeP95Ms.toFixed(2)}ms` +
          ` visible-background-active-write-age p95=${suite.terminalOutputPerFrame.visibleBackgroundActiveWriteAgeP95Ms.toFixed(2)}ms` +
          ` hidden-queue p95=${suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms.toFixed(2)}ms` +
          (hiddenQueueDelta === null ? '' : ` (${hiddenQueueDelta.toFixed(1)}%)`) +
          ` suppressed=${suite.terminalOutputTotals.suppressedBytes.toFixed(0)}`,
      );
      if (!isHiddenWakeSuiteName(suite.profile)) {
        lines.push(
          `  focused-roundtrip-split input-dispatch-p95=${suite.focusedRoundTrip.inputDispatchP95Ms.toFixed(2)}ms` +
            ` echo-after-dispatch-p95=${suite.focusedRoundTrip.echoAfterDispatchP95Ms.toFixed(2)}ms` +
            ` rendered-p95=${suite.focusedRoundTrip.renderedP95Ms.toFixed(2)}ms` +
            ` render-after-receive-p95=${suite.focusedRoundTrip.renderAfterReceiveP95Ms.toFixed(2)}ms` +
            ` rendered-timeouts=${suite.focusedRoundTrip.renderedTimeoutCount.toFixed(0)}`,
        );
        lines.push(
          `  focused-input-output focused-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.focusedWriteBytesP95.toFixed(0)}` +
            ` active-visible-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.activeVisibleBytesP95.toFixed(0)}` +
            ` visible-background-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundBytesP95.toFixed(0)}` +
            ` non-target-visible-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleBytesP95.toFixed(0)}` +
            ` plain-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.plainWriteBytesP95.toFixed(0)}` +
            ` control-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.controlWriteBytesP95.toFixed(0)}` +
            ` redraw-control-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteBytesP95.toFixed(0)}` +
            ` direct-calls-p95=${suite.terminalOutputDuringFocusedInputPerFrame.directWriteCallsP95.toFixed(0)}` +
            ` queued-calls-p95=${suite.terminalOutputDuringFocusedInputPerFrame.queuedWriteCallsP95.toFixed(0)}` +
            ` write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.writeDurationP95Ms.toFixed(2)}ms` +
            ` plain-write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.plainWriteDurationP95Ms.toFixed(2)}ms` +
            ` control-write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.controlWriteDurationP95Ms.toFixed(2)}ms` +
            ` redraw-control-write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteDurationP95Ms.toFixed(2)}ms` +
            ` write-finalization-p95=${suite.terminalOutputDuringFocusedInputPerFrame.writeFinalizationDurationP95Ms.toFixed(2)}ms` +
            ` non-target-visible-write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleWriteDurationP95Ms.toFixed(2)}ms` +
            ` non-target-visible-write-finalization-p95=${suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleWriteFinalizationDurationP95Ms.toFixed(2)}ms` +
            ` visible-background-write-duration-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundWriteDurationP95Ms.toFixed(2)}ms` +
            ` visible-background-write-finalization-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundWriteFinalizationDurationP95Ms.toFixed(2)}ms` +
            ` active-write-count-p95=${suite.terminalOutputDuringFocusedInputPerFrame.activeWriteCountP95.toFixed(0)}` +
            ` active-write-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.activeWriteAgeP95Ms.toFixed(2)}ms` +
            ` visible-background-active-write-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteAgeP95Ms.toFixed(2)}ms` +
            ` visible-background-started-before-input-count-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputCountP95.toFixed(0)}` +
            ` visible-background-started-before-input-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputBytesP95.toFixed(0)}` +
            ` visible-background-started-before-input-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputAgeP95Ms.toFixed(2)}ms` +
            ` visible-background-started-during-input-count-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputCountP95.toFixed(0)}` +
            ` visible-background-started-during-input-bytes-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputBytesP95.toFixed(0)}` +
            ` visible-background-started-during-input-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputAgeP95Ms.toFixed(2)}ms` +
            ` active-visible-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.activeVisibleQueueAgeP95Ms.toFixed(2)}ms` +
            ` visible-background-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundQueueAgeP95Ms.toFixed(2)}ms` +
            ` queued-age-p95=${suite.terminalOutputDuringFocusedInputPerFrame.queuedQueueAgeP95Ms.toFixed(2)}ms`,
        );
      }
      if (suite.terminalInput) {
        lines.push(
          `  terminal-input buffered-p95=${suite.terminalInput.bufferedP95Ms.toFixed(2)}ms` +
            ` buffered-max=${suite.terminalInput.bufferedMaxMs.toFixed(2)}ms` +
            ` sent-p95=${suite.terminalInput.sentP95Ms.toFixed(2)}ms` +
            ` sent-max=${suite.terminalInput.sentMaxMs.toFixed(2)}ms` +
            ` sent-count=${suite.terminalInput.sentCount.toFixed(0)}`,
        );
        lines.push(
          `  terminal-input-split lease-wait-p95=${suite.terminalInput.leaseWaitP95Ms.toFixed(2)}ms` +
            ` lease-wait-max=${suite.terminalInput.leaseWaitMaxMs.toFixed(2)}ms` +
            ` lease-wait-count=${suite.terminalInput.leaseWaitCount.toFixed(0)}` +
            ` dispatched-p95=${suite.terminalInput.dispatchedP95Ms.toFixed(2)}ms` +
            ` dispatched-max=${suite.terminalInput.dispatchedMaxMs.toFixed(2)}ms` +
            ` dispatched-count=${suite.terminalInput.dispatchedCount.toFixed(0)}` +
            ` command-result-p95=${suite.terminalInput.commandResultReceivedP95Ms.toFixed(2)}ms` +
            ` command-result-max=${suite.terminalInput.commandResultReceivedMaxMs.toFixed(2)}ms` +
            ` command-result-count=${suite.terminalInput.commandResultReceivedCount.toFixed(0)}` +
            ` accepted-p95=${suite.terminalInput.acceptedP95Ms.toFixed(2)}ms` +
            ` accepted-max=${suite.terminalInput.acceptedMaxMs.toFixed(2)}ms` +
            ` accepted-count=${suite.terminalInput.acceptedCount.toFixed(0)}` +
            ` accepted-settle-p95=${suite.terminalInput.acceptedSettledP95Ms.toFixed(2)}ms` +
            ` accepted-settle-max=${suite.terminalInput.acceptedSettledMaxMs.toFixed(2)}ms` +
            ` accepted-settle-count=${suite.terminalInput.acceptedSettledCount.toFixed(0)}`,
        );
      }
      if (suite.rendererTerminalInput) {
        lines.push(
          `  renderer-terminal-input buffered-chars-max=${suite.rendererTerminalInput.bufferedCharsMax.toFixed(0)}` +
            ` queued-chunks-max=${suite.rendererTerminalInput.queuedChunksMax.toFixed(0)}` +
            ` in-flight-max=${suite.rendererTerminalInput.inFlightBatchesMax.toFixed(0)}` +
            ` sent-batches=${suite.rendererTerminalInput.sentBatches.toFixed(0)}` +
            ` sent-batch-chars-max=${suite.rendererTerminalInput.sentBatchCharsMax.toFixed(0)}` +
            ` retry-schedules=${suite.rendererTerminalInput.retrySchedules.toFixed(0)}` +
            ` dropped-suffix=${suite.rendererTerminalInput.droppedSuffixBatches.toFixed(0)}`,
        );
      }
      if (suite.browserControlClient) {
        lines.push(
          `  browser-control-client sends=${suite.browserControlClient.sendAttempts.toFixed(0)}` +
            ` nonzero-buffered-sends=${suite.browserControlClient.nonZeroBufferedSendAttempts.toFixed(0)}` +
            ` buffered-max=${suite.browserControlClient.sendBufferedAmountMax.toFixed(0)} ` +
            ` post-buffered-max=${suite.browserControlClient.postSendBufferedAmountMax.toFixed(0)}` +
            ` send-duration-p95=${suite.browserControlClient.sendDurationP95Ms.toFixed(2)}ms ` +
            BROWSER_CONTROL_CLIENT_DETAIL_TYPES.map((type) =>
              formatBrowserControlClientTypeStats(suite.browserControlClient, type),
            ).join(' '),
        );
      }
      if (suite.terminalFlowControl) {
        lines.push(
          `  terminal-flow pauses=${suite.terminalFlowControl.pauseRequests.toFixed(0)}` +
            ` resumes=${suite.terminalFlowControl.resumeRequests.toFixed(0)}` +
            ` avg-pause-window=${suite.terminalFlowControl.avgPauseRequestWindowMs.toFixed(2)}ms`,
        );
      }
      if (suite.backendInputTrace) {
        lines.push(
          `  backend-input-trace completed=${suite.backendInputTrace.completedCount.toFixed(0)}` +
            ` active=${suite.backendInputTrace.activeTraceCount.toFixed(0)}` +
            ` dropped=${suite.backendInputTrace.droppedTraces.toFixed(0)}` +
            ` client-buffer-p95=${suite.backendInputTrace.clientBufferP95Ms.toFixed(2)}ms` +
            ` client-send-p95=${suite.backendInputTrace.clientSendP95Ms.toFixed(2)}ms` +
            ` server-queue-p95=${suite.backendInputTrace.serverQueueP95Ms.toFixed(2)}ms` +
            ` command-ack-p95=${suite.backendInputTrace.commandAckP95Ms.toFixed(2)}ms` +
            ` pty-write-to-command-ack-p95=${suite.backendInputTrace.ptyWriteToCommandAckP95Ms.toFixed(2)}ms` +
            ` pty-echo-p95=${suite.backendInputTrace.ptyEchoP95Ms.toFixed(2)}ms` +
            ` backend-output-buffer-p95=${suite.backendInputTrace.backendOutputBufferP95Ms.toFixed(2)}ms` +
            ` browser-delivery-p95=${suite.backendInputTrace.browserDeliveryP95Ms.toFixed(2)}ms` +
            ` browser-transport-delivery-p95=${suite.backendInputTrace.browserTransportDeliveryP95Ms.toFixed(2)}ms` +
            ` browser-channel-dispatch-p95=${suite.backendInputTrace.browserChannelDispatchP95Ms.toFixed(2)}ms` +
            ` transport-residual-p95=${suite.backendInputTrace.transportResidualP95Ms.toFixed(2)}ms` +
            ` render-p95=${suite.backendInputTrace.renderP95Ms.toFixed(2)}ms` +
            ` end-to-end-p95=${suite.backendInputTrace.endToEndP95Ms.toFixed(2)}ms`,
        );
      }
      if (suite.backendPtyInput && suite.backendBrowserControl) {
        lines.push(
          `  backend-pty-input enqueued=${suite.backendPtyInput.enqueuedMessages.toFixed(0)}` +
            ` flushes=${suite.backendPtyInput.flushes.toFixed(0)}` +
            ` coalesced=${suite.backendPtyInput.coalescedMessages.toFixed(0)}` +
            ` max-queued-chars=${suite.backendPtyInput.maxQueuedChars.toFixed(0)}` +
            ` write-failures=${suite.backendPtyInput.writeFailures.toFixed(0)}` +
            ` control-backpressure=${suite.backendBrowserControl.backpressureRejects.toFixed(0)}` +
            ` control-not-open=${suite.backendBrowserControl.notOpenRejects.toFixed(0)}` +
            ` control-send-errors=${suite.backendBrowserControl.sendErrors.toFixed(0)}` +
            ` control-delayed-depth=${suite.backendBrowserControl.delayedQueueMaxDepth.toFixed(0)}` +
            ` control-delayed-age=${suite.backendBrowserControl.delayedQueueMaxAgeMs.toFixed(2)}ms` +
            ` control-buffered-max=${suite.backendBrowserControl.maxBufferedAmountBytes.toFixed(0)}`,
        );
      }
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

  const budgetObservations = evaluateTerminalUiFluidityBudgets({ aggregatedRuns });
  const summary = {
    aggregatedRuns,
    budgetObservations,
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

  if (options.failOnBudget && budgetObservations.overallStatus === 'provisional-fail') {
    throw new Error(
      `Terminal UI fluidity budgets failed (${budgetObservations.failedCount} checks). ` +
        `Artifacts were written to ${options.outDir}`,
    );
  }
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
