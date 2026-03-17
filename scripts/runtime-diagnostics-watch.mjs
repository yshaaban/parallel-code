#!/usr/bin/env node

import { createBrowserServerClient } from './browser-server-client.mjs';

const DEFAULT_INTERVAL_MS = 2000;
const COUNT_PATHS = [
  ['browserChannels.coalescedMessages', ['browserChannels', 'coalescedMessages']],
  ['browserChannels.coalescedBytesSaved', ['browserChannels', 'coalescedBytesSaved']],
  ['browserChannels.degradedClientChannels', ['browserChannels', 'degradedClientChannels']],
  ['browserChannels.droppedDataMessages', ['browserChannels', 'droppedDataMessages']],
  ['browserChannels.recoveredClientChannels', ['browserChannels', 'recoveredClientChannels']],
  ['browserChannels.resetBindings', ['browserChannels', 'resetBindings']],
  ['browserChannels.transportBusyDeferrals', ['browserChannels', 'transportBusyDeferrals']],
  ['browserControl.backpressureRejects', ['browserControl', 'backpressureRejects']],
  ['browserControl.notOpenRejects', ['browserControl', 'notOpenRejects']],
  ['browserControl.sendErrors', ['browserControl', 'sendErrors']],
  ['ptyInput.clearedQueues', ['ptyInput', 'clearedQueues']],
  ['ptyInput.coalescedMessages', ['ptyInput', 'coalescedMessages']],
  ['ptyInput.enqueuedChars', ['ptyInput', 'enqueuedChars']],
  ['ptyInput.enqueuedMessages', ['ptyInput', 'enqueuedMessages']],
  ['ptyInput.flushes', ['ptyInput', 'flushes']],
  ['ptyInput.writeFailures', ['ptyInput', 'writeFailures']],
  ['previewValidation.cacheHits', ['previewValidation', 'cacheHits']],
  ['previewValidation.probeFailures', ['previewValidation', 'probeFailures']],
  ['previewValidation.probeSuccesses', ['previewValidation', 'probeSuccesses']],
  ['previewValidation.revalidations', ['previewValidation', 'revalidations']],
  ['reconnectSnapshots.cacheHits', ['reconnectSnapshots', 'cacheHits']],
  ['reconnectSnapshots.cacheInvalidations', ['reconnectSnapshots', 'cacheInvalidations']],
  ['reconnectSnapshots.cacheMisses', ['reconnectSnapshots', 'cacheMisses']],
  ['scrollbackReplay.batchRequests', ['scrollbackReplay', 'batchRequests']],
  ['scrollbackReplay.cacheHits', ['scrollbackReplay', 'cacheHits']],
  ['scrollbackReplay.cacheMisses', ['scrollbackReplay', 'cacheMisses']],
  ['scrollbackReplay.requestedAgents', ['scrollbackReplay', 'requestedAgents']],
  ['scrollbackReplay.returnedBytes', ['scrollbackReplay', 'returnedBytes']],
];
const HOT_COUNT_LABELS = [
  ['backpressure', 'browserControl.backpressureRejects'],
  ['transportDeferrals', 'browserChannels.transportBusyDeferrals'],
  ['degraded', 'browserChannels.degradedClientChannels'],
  ['replayBatches', 'scrollbackReplay.batchRequests'],
  ['reconnectMisses', 'reconnectSnapshots.cacheMisses'],
];

function printHelp() {
  console.log(`Usage: node scripts/runtime-diagnostics-watch.mjs --server-url <url> [options]

Options:
  --server-url <url>          Browser server base URL to poll, e.g. https://yrsh-vm1.duckdns.org
  --auth-token <token>        Bearer/query token for the target server (defaults to AUTH_TOKEN)
  --interval-ms <n>           Poll interval in ms (default: 2000)
  --samples <n>               Stop after n samples; 0 keeps watching until interrupted (default: 0)
  --reset-on-start            Reset backend runtime diagnostics before the first sample
  --reset-after-sample        Reset diagnostics after each sample so counters are per-interval
  --json                      Print one JSON object per sample instead of a compact summary line
  --help                      Print this help and exit
`);
}

function parseArgs(argv) {
  const options = {
    authToken: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    json: false,
    resetAfterSample: false,
    resetOnStart: false,
    samples: 0,
    serverUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--server-url':
        if (!next) {
          throw new Error('Missing value for --server-url');
        }
        options.serverUrl = next;
        index += 1;
        break;
      case '--auth-token':
        if (!next) {
          throw new Error('Missing value for --auth-token');
        }
        options.authToken = next;
        index += 1;
        break;
      case '--interval-ms':
        if (!next) {
          throw new Error('Missing value for --interval-ms');
        }
        options.intervalMs = Number(next);
        index += 1;
        break;
      case '--samples':
        if (!next) {
          throw new Error('Missing value for --samples');
        }
        options.samples = Number(next);
        index += 1;
        break;
      case '--reset-on-start':
        options.resetOnStart = true;
        break;
      case '--reset-after-sample':
        options.resetAfterSample = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.serverUrl) {
    throw new Error('Missing required --server-url');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('--interval-ms must be a positive number');
  }
  if (!Number.isInteger(options.samples) || options.samples < 0) {
    throw new Error('--samples must be a non-negative integer');
  }

  return options;
}

function getGaugeSnapshot(snapshot) {
  return {
    browserChannelsMaxQueueAgeMs: snapshot.browserChannels.maxQueueAgeMs,
    browserChannelsMaxQueuedBytes: snapshot.browserChannels.maxQueuedBytes,
    browserControlDelayedQueueMaxAgeMs: snapshot.browserControl.delayedQueueMaxAgeMs,
    browserControlDelayedQueueMaxBytes: snapshot.browserControl.delayedQueueMaxBytes,
    browserControlDelayedQueueMaxDepth: snapshot.browserControl.delayedQueueMaxDepth,
    previewValidationLastProbeDurationMs: snapshot.previewValidation.lastProbeDurationMs,
    ptyInputMaxQueuedChars: snapshot.ptyInput.maxQueuedChars,
    scrollbackReplayLastDurationMs: snapshot.scrollbackReplay.lastDurationMs,
    scrollbackReplayMaxDurationMs: snapshot.scrollbackReplay.maxDurationMs,
  };
}

function getNestedNumber(snapshot, path) {
  return path.reduce((value, key) => value?.[key], snapshot) ?? 0;
}

function createDeltaSnapshot(previous, current, elapsedMs) {
  const perSecondMultiplier = elapsedMs > 0 ? 1000 / elapsedMs : 0;
  const counts = {};

  for (const [label, path] of COUNT_PATHS) {
    const previousValue = previous ? getNestedNumber(previous, path) : 0;
    const currentValue = getNestedNumber(current, path);
    const delta = Math.max(0, currentValue - previousValue);
    counts[label] = {
      delta,
      ratePerSecond: Number((delta * perSecondMultiplier).toFixed(2)),
      total: currentValue,
    };
  }

  return {
    counts,
    gauges: getGaugeSnapshot(current),
  };
}

function formatCompactSample(sample) {
  const hotCounts = HOT_COUNT_LABELS.map(([label, path]) => {
    const entry = sample.delta.counts[path];
    return `${label}=+${entry.delta} (${entry.ratePerSecond}/s)`;
  }).join(' ');

  const hotGauges = [
    `delayedAge=${sample.delta.gauges.browserControlDelayedQueueMaxAgeMs}ms`,
    `delayedDepth=${sample.delta.gauges.browserControlDelayedQueueMaxDepth}`,
    `delayedBytes=${sample.delta.gauges.browserControlDelayedQueueMaxBytes}`,
    `maxQueuedChars=${sample.delta.gauges.ptyInputMaxQueuedChars}`,
    `replayMax=${sample.delta.gauges.scrollbackReplayMaxDurationMs ?? 0}ms`,
  ].join(' ');

  return `[runtime-diagnostics-watch] sample=${sample.sampleIndex} elapsedMs=${sample.elapsedMs.toFixed(
    1,
  )} ${hotCounts} ${hotGauges}`;
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exit(1);
  }

  const client = createBrowserServerClient({
    authToken: options.authToken,
    serverUrl: options.serverUrl,
  });

  if (options.resetOnStart) {
    await client.invokeIpc('reset_backend_runtime_diagnostics');
  }

  console.log(
    `[runtime-diagnostics-watch] server=${client.baseUrl} intervalMs=${options.intervalMs} samples=${options.samples === 0 ? 'infinite' : options.samples}`,
  );

  let previousSnapshot = null;
  let previousSampleAt = globalThis.performance.now();
  let sampleIndex = 0;

  while (options.samples === 0 || sampleIndex < options.samples) {
    if (sampleIndex > 0) {
      await sleep(options.intervalMs);
    }

    const currentSampleAt = globalThis.performance.now();
    const snapshot = await client.invokeIpc('get_backend_runtime_diagnostics');
    sampleIndex += 1;

    const sample = {
      delta: createDeltaSnapshot(previousSnapshot, snapshot, currentSampleAt - previousSampleAt),
      elapsedMs: currentSampleAt - previousSampleAt,
      recordedAt: new Date().toISOString(),
      sampleIndex,
      snapshot,
      target: client.baseUrl,
    };

    if (options.json) {
      console.log(JSON.stringify(sample));
    } else {
      console.log(formatCompactSample(sample));
    }

    previousSnapshot = snapshot;
    previousSampleAt = currentSampleAt;

    if (options.resetAfterSample) {
      await client.invokeIpc('reset_backend_runtime_diagnostics');
      previousSnapshot = null;
    }
  }
}

await main();
