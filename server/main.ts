import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import { installStdioEpipeGuard } from '../electron/stdio.js';
import { startBrowserServer } from './browser-server.js';
import {
  assertBrowserServerBuildArtifactsAreFresh,
  shouldCheckBrowserServerBuildArtifacts,
} from './build-artifacts.js';
import { loadLocalEnvWithDefaults } from './env.js';
import {
  getRuntimeDiagnosticsLoggingConfigFromEnv,
  startRuntimeDiagnosticsLogging,
} from './runtime-diagnostics-logging.js';
import { getServerPort } from './server-port.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
installStdioEpipeGuard();
loadLocalEnvWithDefaults(path.join(projectRoot, '.env'), path.join(projectRoot, '.env.example'));
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const distRemoteDir = path.resolve(__dirname, '..', '..', 'dist-remote');
const token = process.env.AUTH_TOKEN || randomBytes(24).toString('base64url');
const userDataPath =
  process.env.PARALLEL_CODE_USER_DATA_DIR ?? path.resolve(__dirname, '..', '..', '.server-data');

function getOptionalEnvNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const browserChannelBackpressureDrainIntervalMs = getOptionalEnvNumber(
  'BROWSER_CHANNEL_BACKPRESSURE_DRAIN_INTERVAL_MS',
);
const browserChannelClientDegradedMaxDrainPasses = getOptionalEnvNumber(
  'BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_DRAIN_PASSES',
);
const browserChannelClientDegradedMaxQueueAgeMs = getOptionalEnvNumber(
  'BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_QUEUE_AGE_MS',
);
const browserChannelClientDegradedMaxQueuedBytes = getOptionalEnvNumber(
  'BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_QUEUED_BYTES',
);
const browserChannelCoalescedDataMaxBytes = getOptionalEnvNumber(
  'BROWSER_CHANNEL_COALESCED_DATA_MAX_BYTES',
);
const browserControlHeartbeatIntervalMs = getOptionalEnvNumber(
  'BROWSER_CONTROL_HEARTBEAT_INTERVAL_MS',
);
const browserControlMaxMissedPongs = getOptionalEnvNumber('BROWSER_CONTROL_MAX_MISSED_PONGS');
const runtimeDiagnosticsLoggingConfig = getRuntimeDiagnosticsLoggingConfigFromEnv(process.env);

interface BrowserChannelServerOptions {
  browserChannelBackpressureDrainIntervalMs?: number;
  browserChannelClientDegradedMaxDrainPasses?: number;
  browserChannelClientDegradedMaxQueueAgeMs?: number;
  browserChannelClientDegradedMaxQueuedBytes?: number;
  browserChannelCoalescedDataMaxBytes?: number;
  browserControlHeartbeatIntervalMs?: number;
  browserControlMaxMissedPongs?: number;
}

function getBrowserChannelServerOptions(): BrowserChannelServerOptions {
  return {
    ...(browserChannelBackpressureDrainIntervalMs === undefined
      ? {}
      : { browserChannelBackpressureDrainIntervalMs }),
    ...(browserChannelClientDegradedMaxDrainPasses === undefined
      ? {}
      : { browserChannelClientDegradedMaxDrainPasses }),
    ...(browserChannelClientDegradedMaxQueueAgeMs === undefined
      ? {}
      : { browserChannelClientDegradedMaxQueueAgeMs }),
    ...(browserChannelClientDegradedMaxQueuedBytes === undefined
      ? {}
      : { browserChannelClientDegradedMaxQueuedBytes }),
    ...(browserChannelCoalescedDataMaxBytes === undefined
      ? {}
      : { browserChannelCoalescedDataMaxBytes }),
    ...(browserControlHeartbeatIntervalMs === undefined
      ? {}
      : { browserControlHeartbeatIntervalMs }),
    ...(browserControlMaxMissedPongs === undefined ? {} : { browserControlMaxMissedPongs }),
  };
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

if (runtimeDiagnosticsLoggingConfig) {
  const stopRuntimeDiagnosticsLogging = startRuntimeDiagnosticsLogging({
    ...runtimeDiagnosticsLoggingConfig,
    getSnapshot: getBackendRuntimeDiagnosticsSnapshot,
    log: writeLine,
    resetSnapshot: resetBackendRuntimeDiagnostics,
  });

  process.once('exit', () => {
    stopRuntimeDiagnosticsLogging();
  });
}

async function main(): Promise<void> {
  if (shouldCheckBrowserServerBuildArtifacts(process.env)) {
    await assertBrowserServerBuildArtifactsAreFresh({
      projectRoot,
      serverEntryPath: __filename,
    });
  }

  startBrowserServer({
    ...getBrowserChannelServerOptions(),
    distDir,
    distRemoteDir,
    port: getServerPort(process.env),
    simulateJitterMs: Number(process.env.SIMULATE_JITTER_MS) || 0,
    simulateLatencyMs: Number(process.env.SIMULATE_LATENCY_MS) || 0,
    simulatePacketLoss: Number(process.env.SIMULATE_PACKET_LOSS) || 0,
    token,
    userDataPath,
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
