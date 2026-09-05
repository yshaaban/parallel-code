import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import { installStdioEpipeGuard } from '../electron/stdio.js';
import { startBrowserServer } from './browser-server.js';
import type { BrowserServerController } from './browser-server.js';
import {
  snapshotTaskNotesWriterEntitlements,
  type TaskNotesWriterEntitlements,
} from '../electron/ipc/task-notes-writer-entitlements.js';
import { loadRemoteScopedCommandSecurityConfig } from '../electron/remote/scoped-command-security-config.js';
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

function resolveProjectPath(value: string | undefined, fallbackRelativePath: string): string {
  const nextPath = value ?? fallbackRelativePath;
  return path.isAbsolute(nextPath) ? nextPath : path.resolve(projectRoot, nextPath);
}

const distDir = resolveProjectPath(process.env.PARALLEL_CODE_BROWSER_DIST_DIR, 'dist');
const distRemoteDir = resolveProjectPath(
  process.env.PARALLEL_CODE_BROWSER_DIST_REMOTE_DIR,
  'dist-remote',
);
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

export async function startConfiguredBrowserServer(
  options: { taskNotesWriterEntitlements?: TaskNotesWriterEntitlements } = {},
): Promise<BrowserServerController> {
  const taskNotesWriterEntitlements = snapshotTaskNotesWriterEntitlements(
    options.taskNotesWriterEntitlements,
  );
  if (shouldCheckBrowserServerBuildArtifacts(process.env)) {
    await assertBrowserServerBuildArtifactsAreFresh({
      frontendDistDir: distDir,
      projectRoot,
      remoteDistDir: distRemoteDir,
      serverEntryPath: __filename,
    });
  }

  const remoteSecurity = loadRemoteScopedCommandSecurityConfig();
  if (remoteSecurity.kind === 'invalid') {
    throw new Error(`Secure remote access configuration is invalid (${remoteSecurity.code})`);
  }
  const scopedAccessToken =
    remoteSecurity.kind === 'configured'
      ? (remoteSecurity.accessToken ?? randomBytes(24).toString('base64url'))
      : randomBytes(24).toString('base64url');
  if (remoteSecurity.kind === 'configured' && scopedAccessToken === token) {
    throw new Error('Secure remote and full browser access tokens must be distinct');
  }

  const controller = startBrowserServer({
    ...getBrowserChannelServerOptions(),
    distDir,
    distRemoteDir,
    port: getServerPort(process.env),
    simulateJitterMs: Number(process.env.SIMULATE_JITTER_MS) || 0,
    simulateLatencyMs: Number(process.env.SIMULATE_LATENCY_MS) || 0,
    simulatePacketLoss: Number(process.env.SIMULATE_PACKET_LOSS) || 0,
    taskNotesWriterEntitlements,
    ...(remoteSecurity.kind === 'configured'
      ? {
          scopedCommands: {
            accessToken: scopedAccessToken,
            grants: remoteSecurity.grants,
            mutationAdmissionInitiallyOpen: [...remoteSecurity.grants].some(
              (grant) =>
                grant === 'notes:write' || grant === 'task:create' || grant === 'terminal:control',
            ),
            peerTrustPolicy: remoteSecurity.peerTrustPolicy,
            tls: remoteSecurity.tls,
            workspacePrincipalId: 'standalone-owner',
          },
        }
      : {}),
    token,
    userDataPath,
  });
  await controller.whenReady();
  return controller;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void startConfiguredBrowserServer().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
