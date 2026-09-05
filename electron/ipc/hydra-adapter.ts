import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import { isHydraStartupMode, type HydraStartupMode } from '../../src/lib/hydra.js';
import {
  spawnWithDeadline,
  terminateBoundedSpawnAndWait,
  type BoundedSpawn,
  type BoundedSpawnOptions,
  type SubprocessExit,
} from './bounded-process.js';
import { isCommandAvailable, validateCommand } from './command-resolver.js';
import {
  findRuntimeAsset,
  getRuntimeAssetCandidates,
  type RuntimeAssetSearchOptions,
} from './runtime-assets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HYDRA_ADAPTER = 'hydra';
export const HYDRA_HOST = '127.0.0.1';
export const HYDRA_PORT_MIN = 43000;
export const HYDRA_PORT_SPAN = 15000;
export const HYDRA_PORT_PROBE_ATTEMPTS = 64;
export const HYDRA_HEALTH_TIMEOUT_MS = 15_000;
export const HYDRA_HEALTH_POLL_INTERVAL_MS = 250;
export const HYDRA_HTTP_REQUEST_TIMEOUT_MS = 1_000;
export const HYDRA_SHUTDOWN_TIMEOUT_MS = 2_000;
const HYDRA_COMMAND_LOOKUP = process.platform === 'win32' ? 'where' : 'which';
const HYDRA_COMMAND_LOOKUP_TIMEOUT_MS = 3_000;
const VENDORED_HYDRA_CLI_RELATIVE_PATH = path.join('vendor', 'hydra', 'bin', 'hydra-cli.mjs');

interface HydraResolvedCommand {
  command: string;
  args: string[];
}

interface HydraRuntime {
  operator: HydraResolvedCommand;
  daemon: HydraResolvedCommand;
}

interface HydraRuntimeResolutionOptions {
  assetSearch?: RuntimeAssetSearchOptions;
  resolveBareCommandPath?: boolean;
}

export interface HydraRuntimeAvailability {
  available: boolean;
  detail: string;
  resolvedCommand: string | null;
  source: 'path' | 'bundled' | 'override' | 'unavailable';
}

interface HydraHealthResponse {
  running?: boolean;
  projectRoot?: string;
  [key: string]: unknown;
}

export interface HydraAdapterLaunchRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  resumeOnStart?: boolean;
}

export interface HydraAdapterLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  isInternalNodeProcess: boolean;
}

interface ParsedAdapterArgs {
  hydraCommand: string;
  resumeOnStart: boolean;
  startupMode: HydraStartupMode;
  operatorArgs: string[];
}

function isPathLikeCommand(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\');
}

function isNodeScriptPath(filePath: string): boolean {
  return /\.(?:[cm]?js)$/i.test(filePath);
}

function getHydraCommandName(command: string): string {
  const trimmed = command.trim();
  return trimmed || 'hydra';
}

function assertScriptExists(scriptPath: string, label: string): void {
  const stats = fs.statSync(scriptPath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    throw new Error(`${label} not found: ${scriptPath}`);
  }
}

function resolveSiblingHydraDaemon(binDir: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['hydra-daemon.cmd', 'hydra-daemon.exe', 'hydra-daemon.bat', 'hydra-daemon']
      : ['hydra-daemon'];

  for (const candidate of candidates) {
    const resolved = path.join(binDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

function getResolvedCommandPath(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function hasSearchPath(): boolean {
  return (process.env.PATH ?? '').trim().length > 0;
}

function tryResolveBareHydraCommandPath(command: string): string | null {
  const normalized = getHydraCommandName(command);
  if (isPathLikeCommand(normalized)) return null;
  if (!hasSearchPath()) return null;

  try {
    validateCommand(normalized);
    const resolvedPath = getResolvedCommandPath(
      execFileSync(HYDRA_COMMAND_LOOKUP, [normalized], {
        encoding: 'utf8',
        timeout: HYDRA_COMMAND_LOOKUP_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    if (!resolvedPath || !path.isAbsolute(resolvedPath)) return null;

    const stats = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
    if (!stats) return null;
    if (!stats.isSymbolicLink()) return resolvedPath;

    return fs.realpathSync.native(resolvedPath);
  } catch {
    return null;
  }
}

function getVendoredHydraCommandPath(assetSearch: RuntimeAssetSearchOptions = {}): string | null {
  return findRuntimeAsset(VENDORED_HYDRA_CLI_RELATIVE_PATH, {
    startDir: __dirname,
    ...assetSearch,
  });
}

function getVendoredHydraCandidatePaths(assetSearch: RuntimeAssetSearchOptions = {}): string[] {
  return getRuntimeAssetCandidates(VENDORED_HYDRA_CLI_RELATIVE_PATH, {
    startDir: __dirname,
    ...assetSearch,
  });
}

function getHydraAvailabilityDetail(
  source: HydraRuntimeAvailability['source'],
  command: string | null,
  reason?: string,
): string {
  if (reason) {
    return reason;
  }

  switch (source) {
    case 'bundled':
      return `Using bundled Hydra runtime (${command ?? 'unknown path'}).`;
    case 'override':
      return `Using Hydra override (${command ?? 'unknown path'}).`;
    case 'path':
      return `Using Hydra from PATH (${command ?? 'hydra'}).`;
    case 'unavailable':
      return 'Hydra runtime is unavailable.';
    default:
      return 'Hydra runtime state is unknown.';
  }
}

function normalizeHydraCommand(command: string): string {
  const trimmed = getHydraCommandName(command);
  if (isPathLikeCommand(trimmed) && !path.isAbsolute(trimmed)) {
    throw new Error('Hydra command override must be absolute when it includes a path.');
  }
  return trimmed;
}

function resolveHydraCommand(command: string, label: string): HydraResolvedCommand {
  const normalized = normalizeHydraCommand(command);
  if (!isPathLikeCommand(normalized)) {
    return { command: normalized, args: [] };
  }

  if (isNodeScriptPath(normalized)) {
    assertScriptExists(normalized, label);
    return { command: process.execPath, args: [normalized] };
  }

  validateCommand(normalized);
  return { command: normalized, args: [] };
}

export function resolveHydraRuntime(
  command: string,
  options: HydraRuntimeResolutionOptions = {},
): HydraRuntime {
  const normalized = normalizeHydraCommand(command);
  const vendoredCommand =
    normalized.toLowerCase() === 'hydra' ? getVendoredHydraCommandPath(options.assetSearch) : null;
  const resolvedCommand =
    options.resolveBareCommandPath && !isPathLikeCommand(normalized)
      ? (tryResolveBareHydraCommandPath(normalized) ?? vendoredCommand ?? normalized)
      : normalized;

  if (!isPathLikeCommand(resolvedCommand)) {
    return {
      operator: { command: resolvedCommand, args: [] },
      daemon: { command: 'hydra-daemon', args: ['start'] },
    };
  }

  const operator = resolveHydraCommand(resolvedCommand, 'Hydra operator');
  const binDir = path.dirname(resolvedCommand);
  const projectRoot = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : null;
  const directDaemon = resolveSiblingHydraDaemon(binDir);
  if (directDaemon) {
    return {
      operator,
      daemon: { command: directDaemon, args: ['start'] },
    };
  }

  const daemonScript = projectRoot ? path.join(projectRoot, 'lib', 'orchestrator-daemon.mjs') : '';
  if (daemonScript && fs.existsSync(daemonScript)) {
    return {
      operator,
      daemon: { command: process.execPath, args: [daemonScript, 'start'] },
    };
  }

  return {
    operator,
    daemon: { command: 'hydra-daemon', args: ['start'] },
  };
}

export async function getHydraRuntimeAvailability(
  command: string,
  options: HydraRuntimeResolutionOptions = {},
): Promise<HydraRuntimeAvailability> {
  const normalized = normalizeHydraCommand(command);
  const assetSearch = options.assetSearch;

  if (isPathLikeCommand(normalized)) {
    try {
      const runtime = resolveHydraRuntime(normalized, options);
      const [operatorAvailable, daemonAvailable] = await Promise.all([
        isResolvedCommandAvailable(runtime.operator),
        isResolvedCommandAvailable(runtime.daemon),
      ]);
      if (operatorAvailable && daemonAvailable) {
        return {
          available: true,
          detail: getHydraAvailabilityDetail('override', normalized),
          resolvedCommand: normalized,
          source: 'override',
        };
      }
      return {
        available: false,
        detail: `Hydra override is invalid or incomplete: ${normalized}`,
        resolvedCommand: normalized,
        source: 'unavailable',
      };
    } catch (error) {
      return {
        available: false,
        detail: error instanceof Error ? error.message : `Hydra override failed: ${String(error)}`,
        resolvedCommand: normalized,
        source: 'unavailable',
      };
    }
  }

  const resolvedPath = tryResolveBareHydraCommandPath(normalized);
  if (resolvedPath) {
    try {
      const runtime = resolveHydraRuntime(resolvedPath, options);
      const [operatorAvailable, daemonAvailable] = await Promise.all([
        isResolvedCommandAvailable(runtime.operator),
        isResolvedCommandAvailable(runtime.daemon),
      ]);
      if (operatorAvailable && daemonAvailable) {
        return {
          available: true,
          detail: getHydraAvailabilityDetail('path', resolvedPath),
          resolvedCommand: resolvedPath,
          source: 'path',
        };
      }
    } catch {
      // Fall through to vendored/runtime diagnostics below.
    }
  }

  if (normalized.toLowerCase() === 'hydra') {
    const vendoredPath = getVendoredHydraCommandPath(assetSearch);
    if (vendoredPath) {
      try {
        const runtime = resolveHydraRuntime(vendoredPath, options);
        const [operatorAvailable, daemonAvailable] = await Promise.all([
          isResolvedCommandAvailable(runtime.operator),
          isResolvedCommandAvailable(runtime.daemon),
        ]);
        if (operatorAvailable && daemonAvailable) {
          return {
            available: true,
            detail: getHydraAvailabilityDetail('bundled', vendoredPath),
            resolvedCommand: vendoredPath,
            source: 'bundled',
          };
        }
        return {
          available: false,
          detail: `Bundled Hydra runtime is incomplete: ${vendoredPath}`,
          resolvedCommand: vendoredPath,
          source: 'unavailable',
        };
      } catch (error) {
        return {
          available: false,
          detail:
            error instanceof Error
              ? error.message
              : `Bundled Hydra runtime failed: ${String(error)}`,
          resolvedCommand: vendoredPath,
          source: 'unavailable',
        };
      }
    }

    const candidates = getVendoredHydraCandidatePaths(assetSearch);
    const firstCandidate = candidates[0];
    return {
      available: false,
      detail: firstCandidate
        ? `Bundled Hydra runtime not found (looked for ${firstCandidate}).`
        : 'Bundled Hydra runtime not found.',
      resolvedCommand: null,
      source: 'unavailable',
    };
  }

  return {
    available: false,
    detail: `Hydra command '${normalized}' was not found on PATH.`,
    resolvedCommand: null,
    source: 'unavailable',
  };
}

async function isResolvedCommandAvailable(spec: HydraResolvedCommand): Promise<boolean> {
  if (spec.command === process.execPath) {
    const scriptPath = spec.args[0];
    return typeof scriptPath === 'string' && fs.existsSync(scriptPath);
  }

  if (path.isAbsolute(spec.command)) {
    try {
      validateCommand(spec.command);
      return true;
    } catch {
      return false;
    }
  }

  return isCommandAvailable(spec.command);
}

export async function isHydraRuntimeAvailable(command: string): Promise<boolean> {
  const availability = await getHydraRuntimeAvailability(command, { resolveBareCommandPath: true });
  return availability.available;
}

export function normalizeHydraStartupMode(mode: string | undefined): HydraStartupMode {
  const normalized = String(mode ?? '')
    .trim()
    .toLowerCase();
  return isHydraStartupMode(normalized) ? normalized : 'auto';
}

export function deriveHydraPortFromWorktree(worktreePath: string): number {
  const digest = createHash('sha256').update(path.resolve(worktreePath)).digest();
  const offset = digest.readUInt32BE(0) % HYDRA_PORT_SPAN;
  return HYDRA_PORT_MIN + offset;
}

export function buildHydraOperatorArgs(
  operatorArgs: string[],
  options: { resumeOnStart: boolean; url: string; startupMode: HydraStartupMode },
): string[] {
  const args = [...operatorArgs];
  if (!args.some((arg) => /^url=/i.test(arg))) {
    args.push(`url=${options.url}`);
  }
  if (!args.some((arg) => /^welcome=/i.test(arg))) {
    args.push('welcome=false');
  }
  if (!args.some((arg) => /^mode=/i.test(arg))) {
    args.push(`mode=${options.startupMode}`);
  }
  if (options.resumeOnStart && !args.some((arg) => /^resumeOnStart=/i.test(arg))) {
    args.push('resumeOnStart=true');
  }
  return args;
}

export function getHydraAdapterScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

export function resolveHydraAdapterLaunch(request: HydraAdapterLaunchRequest): HydraAdapterLaunch {
  const startupMode = normalizeHydraStartupMode(request.env.PARALLEL_CODE_HYDRA_STARTUP_MODE);
  const args = [
    getHydraAdapterScriptPath(),
    '--hydra-command',
    getHydraCommandName(request.command),
    '--startup-mode',
    startupMode,
  ];

  if (request.resumeOnStart === true) {
    args.push('--resume-on-start');
  }

  for (const operatorArg of request.args) {
    args.push('--operator-arg', operatorArg);
  }

  return {
    command: process.execPath,
    args,
    env: request.env,
    isInternalNodeProcess: true,
  };
}

function parseAdapterArgs(argv: string[]): ParsedAdapterArgs {
  const parsed: ParsedAdapterArgs = {
    hydraCommand: 'hydra',
    resumeOnStart: false,
    startupMode: 'auto',
    operatorArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--hydra-command': {
        const value = argv[index + 1];
        if (!value) throw new Error('Missing value for --hydra-command.');
        parsed.hydraCommand = value;
        index += 1;
        break;
      }
      case '--startup-mode': {
        parsed.startupMode = normalizeHydraStartupMode(argv[index + 1]);
        index += 1;
        break;
      }
      case '--resume-on-start':
        parsed.resumeOnStart = true;
        break;
      case '--operator-arg': {
        const value = argv[index + 1];
        if (!value) throw new Error('Missing value for --operator-arg.');
        parsed.operatorArgs.push(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown Hydra adapter argument: ${token}`);
    }
  }

  return parsed;
}

function buildHydraUrl(port: number): string {
  return `http://${HYDRA_HOST}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withHydraRequestDeadline<T>(
  label: string,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), {
        code: 'ETIMEDOUT',
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([Promise.resolve().then(() => request(controller.signal)), deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  }
}

async function isPortAvailable(port: number, host = HYDRA_HOST): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function fetchHydraHealth(url: string): Promise<HydraHealthResponse> {
  return withHydraRequestDeadline(
    'Hydra health request',
    HYDRA_HTTP_REQUEST_TIMEOUT_MS,
    async (signal) => {
      const response = await fetch(`${url}/health`, {
        headers: {
          Accept: 'application/json',
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Hydra health check failed (${response.status})`);
      }
      return (await response.json()) as HydraHealthResponse;
    },
  );
}

function hydraWorkspaceIdentity(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

async function pickHydraPort(worktreePath: string): Promise<number> {
  const preferred = deriveHydraPortFromWorktree(worktreePath);
  const workspace = hydraWorkspaceIdentity(worktreePath);
  // Check the whole bounded range: a previous daemon may occupy a later offset even after
  // the preferred port becomes free. Parallel probes retain one bounded HTTP timeout.
  const candidates = await Promise.all(
    Array.from({ length: HYDRA_PORT_PROBE_ATTEMPTS }, async (_, offset) => {
      const candidate = HYDRA_PORT_MIN + ((preferred - HYDRA_PORT_MIN + offset) % HYDRA_PORT_SPAN);
      if (await isPortAvailable(candidate)) {
        return { port: candidate, available: true, sameWorkspace: false };
      }

      const url = buildHydraUrl(candidate);
      let health: HydraHealthResponse;
      try {
        health = await fetchHydraHealth(url);
      } catch {
        // Non-Hydra listener or unreachable service; try the next port.
        return { port: candidate, available: false, sameWorkspace: false };
      }
      const daemonProjectRoot = typeof health.projectRoot === 'string' ? health.projectRoot : '';
      return {
        port: candidate,
        available: false,
        sameWorkspace:
          Boolean(daemonProjectRoot) && hydraWorkspaceIdentity(daemonProjectRoot) === workspace,
      };
    }),
  );
  if (candidates.some((candidate) => candidate.sameWorkspace)) {
    throw new Error(
      'Hydra is already running in this checkout. Stop the existing Hydra session or use an isolated worktree; it will not be shut down automatically.',
    );
  }
  const available = candidates.find((candidate) => candidate.available);
  if (available) return available.port;

  throw new Error(`Could not allocate a Hydra daemon port for ${worktreePath}`);
}

function appendCapturedLines(target: string[], chunk: Buffer): void {
  const lines = chunk
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return;
  target.push(...lines);
  if (target.length > 40) {
    target.splice(0, target.length - 40);
  }
}

function buildHydraDaemonFailure(message: string, daemonOutput: string[]): Error {
  const daemonLines = daemonOutput.length > 0 ? `\n${daemonOutput.join('\n')}` : '';
  return new Error(`${message}${daemonLines}`);
}

function formatSpawnCommand(command: string, args: string[]): string {
  const renderedArgs = args.join(' ').trim();
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function spawnHydraChild(
  command: string,
  args: readonly string[],
  options: BoundedSpawnOptions,
  spawnChild: typeof spawnWithDeadline = spawnWithDeadline,
): BoundedSpawn {
  return spawnChild(command, args, options, {
    terminateGraceMs: HYDRA_SHUTDOWN_TIMEOUT_MS,
    // Hydra children are intentionally long-lived. Their HTTP/PTY owner starts termination;
    // timeout 0 disables only the automatic deadline, not group/tree cleanup and escalation.
    timeoutMs: 0,
  });
}

function destroyHydraChildStreams(child: BoundedSpawn): void {
  child.child.stdin?.destroy();
  child.child.stdout?.destroy();
  child.child.stderr?.destroy();
}

function handleHydraDaemonStreamError(
  daemon: BoundedSpawn,
  daemonFailure: { current: Error | null },
  error: Error,
): void {
  const failure =
    daemonFailure.current ?? new Error(`Hydra daemon output stream failed: ${error.message}`);
  daemonFailure.current = failure;
  daemon.terminate(failure);
}

function forwardHydraOperatorResize(
  operator: BoundedSpawn | null,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    platform === 'win32' ||
    !operator ||
    operator.child.exitCode !== null ||
    operator.child.signalCode !== null
  ) {
    return;
  }

  try {
    operator.child.kill('SIGWINCH');
  } catch {
    // The operator can exit between the lifecycle check and resize forwarding.
  }
}

function waitForHydraChildExit(child: BoundedSpawn, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for child process to exit.'));
    }, timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([child.completion.then(() => undefined), deadline]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  });
}

async function terminateHydraChild(child: BoundedSpawn | null | undefined): Promise<void> {
  if (!child) return;

  try {
    await terminateBoundedSpawnAndWait(child, new Error('Hydra child termination requested'));
  } finally {
    destroyHydraChildStreams(child);
  }
}

export interface HydraRuntimeCleanupFailure {
  error: unknown;
  owner: 'daemon' | 'operator';
}

export class HydraRuntimeCleanupError extends Error {
  constructor(readonly failures: HydraRuntimeCleanupFailure[]) {
    super(`Hydra runtime cleanup failed: ${failures.map(({ owner }) => owner).join(', ')}`);
    this.name = 'HydraRuntimeCleanupError';
  }
}

export class HydraOperationCleanupError extends Error {
  constructor(
    readonly operationError: unknown,
    readonly cleanupError: unknown,
  ) {
    super('Hydra operation failed and runtime cleanup also failed');
    this.name = 'HydraOperationCleanupError';
  }
}

async function settleHydraRuntimeCleanupOwners(
  operator: BoundedSpawn | null,
  cleanupDaemon: () => Promise<void>,
  options?: { observedOperatorFailure: unknown },
): Promise<void> {
  const operatorCleanup = terminateHydraChild(operator).catch((error: unknown) => {
    if (options !== undefined && error === options.observedOperatorFailure) {
      return;
    }
    throw error;
  });
  const results = await Promise.allSettled([
    operatorCleanup,
    Promise.resolve().then(cleanupDaemon),
  ]);
  const owners = ['operator', 'daemon'] as const;
  const failures = results.flatMap((result, index): HydraRuntimeCleanupFailure[] => {
    if (result.status === 'fulfilled') {
      return [];
    }
    const owner = owners[index];
    return owner === undefined ? [] : [{ error: result.reason, owner }];
  });

  if (failures.length === 1) {
    throw failures[0]?.error;
  }
  if (failures.length > 1) {
    throw new HydraRuntimeCleanupError(failures);
  }
}

async function rethrowHydraOperationFailure(
  operationError: unknown,
  operator: BoundedSpawn | null,
  cleanupDaemon: () => Promise<void>,
): Promise<never> {
  try {
    await settleHydraRuntimeCleanupOwners(operator, cleanupDaemon, {
      observedOperatorFailure: operationError,
    });
  } catch (cleanupError) {
    throw new HydraOperationCleanupError(operationError, cleanupError);
  }
  throw operationError;
}

async function waitForHydraHealth(
  url: string,
  daemon: BoundedSpawn['child'],
  daemonOutput: string[],
  daemonFailure: { current: Error | null },
  worktreePath: string,
): Promise<void> {
  const deadline = Date.now() + HYDRA_HEALTH_TIMEOUT_MS;
  let lastError = 'Hydra daemon did not report healthy status.';

  while (Date.now() < deadline) {
    if (daemonFailure.current) {
      throw buildHydraDaemonFailure(daemonFailure.current.message, daemonOutput);
    }
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      lastError =
        daemon.exitCode !== null
          ? `Hydra daemon exited with code ${daemon.exitCode}`
          : `Hydra daemon killed by signal ${daemon.signalCode}`;
      break;
    }

    try {
      const health = await fetchHydraHealth(url);
      if (health.running) {
        if (
          typeof daemon.pid !== 'number' ||
          health.pid !== daemon.pid ||
          typeof health.projectRoot !== 'string' ||
          hydraWorkspaceIdentity(health.projectRoot) !== hydraWorkspaceIdentity(worktreePath)
        ) {
          throw new Error(
            'Hydra health endpoint does not belong to the launched daemon and checkout.',
          );
        }
        return;
      }
      lastError = 'Hydra daemon responded without reporting a running state.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(HYDRA_HEALTH_POLL_INTERVAL_MS);
  }

  if (daemonFailure.current) {
    throw buildHydraDaemonFailure(daemonFailure.current.message, daemonOutput);
  }

  throw buildHydraDaemonFailure(lastError, daemonOutput);
}

async function shutdownHydraDaemon(daemon: BoundedSpawn | null): Promise<void> {
  if (!daemon) return;

  try {
    // A TCP port is not process ownership: bind races and replacement listeners must never
    // let cleanup send a shutdown request to somebody else's daemon.
    await terminateHydraChild(daemon);
  } finally {
    destroyHydraChildStreams(daemon);
  }
}

async function runHydraAdapter(): Promise<number> {
  const options = parseAdapterArgs(process.argv.slice(2));
  const worktreePath = fs.realpathSync.native(process.cwd());
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Hydra worktree does not exist: ${worktreePath}`);
  }

  const runtime = resolveHydraRuntime(options.hydraCommand, { resolveBareCommandPath: true });
  const port = await pickHydraPort(worktreePath);
  const url = buildHydraUrl(port);
  const hydraEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HYDRA_PROJECT: worktreePath,
    AI_ORCH_HOST: HYDRA_HOST,
    AI_ORCH_PORT: String(port),
    AI_ORCH_URL: url,
  };

  const daemonOutput: string[] = [];
  const daemon = spawnHydraChild(runtime.daemon.command, runtime.daemon.args, {
    cwd: worktreePath,
    env: hydraEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemonFailure: { current: Error | null } = { current: null };
  daemon.child.once('error', (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    daemonFailure.current = new Error(
      `Failed to start Hydra daemon (${formatSpawnCommand(runtime.daemon.command, runtime.daemon.args)}): ${reason}`,
    );
  });
  // Health polling owns the user-facing spawn diagnostic. Consume the completion rejection now so
  // a very early spawn failure cannot become an unhandled rejection before the poll observes it.
  void daemon.completion.catch(() => undefined);

  const handleDaemonStdout = (chunk: Buffer): void => appendCapturedLines(daemonOutput, chunk);
  const handleDaemonStderr = (chunk: Buffer): void => appendCapturedLines(daemonOutput, chunk);
  const handleDaemonStreamError = (error: Error): void =>
    handleHydraDaemonStreamError(daemon, daemonFailure, error);
  daemon.child.stdout?.on('data', handleDaemonStdout);
  daemon.child.stdout?.on('error', handleDaemonStreamError);
  daemon.child.stderr?.on('data', handleDaemonStderr);
  daemon.child.stderr?.on('error', handleDaemonStreamError);

  const detachDaemonOutput = (): void => {
    daemon.child.stdout?.off('data', handleDaemonStdout);
    daemon.child.stdout?.off('error', handleDaemonStreamError);
    daemon.child.stderr?.off('data', handleDaemonStderr);
    daemon.child.stderr?.off('error', handleDaemonStreamError);
  };

  let cleanedUp = false;
  let cleaningUp: Promise<void> | null = null;
  const operatorArgs = buildHydraOperatorArgs(options.operatorArgs, {
    resumeOnStart: options.resumeOnStart,
    url,
    startupMode: options.startupMode,
  });
  let operator: BoundedSpawn | null = null;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    if (cleaningUp) return cleaningUp;

    cleaningUp = (async () => {
      try {
        await shutdownHydraDaemon(daemon);
        cleanedUp = true;
      } finally {
        detachDaemonOutput();
      }
    })();

    await cleaningUp;
  };

  let signalCleanupPromise: Promise<void> | null = null;
  let signalExitCode: number | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (signalCleanupPromise) {
      return;
    }
    const signalCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    signalExitCode = signalCodes[signal] ?? 1;
    signalCleanupPromise = settleHydraRuntimeCleanupOwners(operator, cleanup);
    // The main adapter flow observes the same cleanup before returning its signal exit code.
    void signalCleanupPromise.catch(() => {});
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('SIGHUP', handleSignal);
  const handleTerminalResize = (): void => forwardHydraOperatorResize(operator);
  if (process.platform !== 'win32') {
    process.on('SIGWINCH', handleTerminalResize);
  }

  try {
    let operatorResult: SubprocessExit;
    try {
      await waitForHydraHealth(url, daemon.child, daemonOutput, daemonFailure, worktreePath);
      if (signalCleanupPromise) {
        await signalCleanupPromise;
        return signalExitCode ?? 1;
      }

      operator = spawnHydraChild(
        runtime.operator.command,
        [...runtime.operator.args, ...operatorArgs],
        {
          cwd: worktreePath,
          env: hydraEnv,
          stdio: 'inherit',
        },
      );
      operatorResult = await operator.completion;
    } catch (error) {
      if (signalCleanupPromise) {
        await signalCleanupPromise;
        return signalExitCode ?? 1;
      }
      return await rethrowHydraOperationFailure(error, operator, cleanup);
    }

    if (signalCleanupPromise) {
      await signalCleanupPromise;
      return signalExitCode ?? 1;
    }
    await cleanup();
    if (signalCleanupPromise) {
      await signalCleanupPromise;
      return signalExitCode ?? 1;
    }
    if (operatorResult.code !== null) return operatorResult.code;
    return operatorResult.signal ? 1 : 0;
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    process.off('SIGHUP', handleSignal);
    if (process.platform !== 'win32') {
      process.off('SIGWINCH', handleTerminalResize);
    }
  }
}

export const __hydraAdapterTestExports = {
  pickHydraPort,
  shutdownHydraDaemon,
  forwardHydraOperatorResize,
  handleHydraDaemonStreamError,
  spawnHydraChild,
  rethrowHydraOperationFailure,
  settleHydraRuntimeCleanupOwners,
  terminateHydraChild,
  waitForHydraHealth,
  waitForHydraChildExit,
  withHydraRequestDeadline,
};

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  void runHydraAdapter()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Hydra adapter failed: ${message}\n`);
      process.exit(1);
    });
}
