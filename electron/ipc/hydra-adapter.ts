import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCommandAvailable, validateCommand } from './command-resolver.js';

export const HYDRA_ADAPTER = 'hydra';
export const HYDRA_HOST = '127.0.0.1';
export const HYDRA_PORT_MIN = 43000;
export const HYDRA_PORT_SPAN = 15000;
export const HYDRA_PORT_PROBE_ATTEMPTS = 64;
export const HYDRA_HEALTH_TIMEOUT_MS = 15_000;
export const HYDRA_HEALTH_POLL_INTERVAL_MS = 250;
export const HYDRA_SHUTDOWN_TIMEOUT_MS = 2_000;
const HYDRA_COMMAND_LOOKUP = process.platform === 'win32' ? 'where' : 'which';
const HYDRA_COMMAND_LOOKUP_TIMEOUT_MS = 3_000;

const HYDRA_STARTUP_MODES = ['auto', 'dispatch', 'smart', 'council'] as const;
export type HydraStartupMode = (typeof HYDRA_STARTUP_MODES)[number];

interface HydraResolvedCommand {
  command: string;
  args: string[];
}

interface HydraRuntime {
  operator: HydraResolvedCommand;
  daemon: HydraResolvedCommand;
}

interface HydraRuntimeResolutionOptions {
  resolveBareCommandPath?: boolean;
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
}

export interface HydraAdapterLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  isInternalNodeProcess: boolean;
}

interface ParsedAdapterArgs {
  hydraCommand: string;
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

function tryResolveBareHydraCommandPath(command: string): string | null {
  const normalized = getHydraCommandName(command);
  if (isPathLikeCommand(normalized)) return null;

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
  const resolvedCommand =
    options.resolveBareCommandPath && !isPathLikeCommand(normalized)
      ? (tryResolveBareHydraCommandPath(normalized) ?? normalized)
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
  try {
    const runtime = resolveHydraRuntime(command, { resolveBareCommandPath: true });
    const [operatorAvailable, daemonAvailable] = await Promise.all([
      isResolvedCommandAvailable(runtime.operator),
      isResolvedCommandAvailable(runtime.daemon),
    ]);
    return operatorAvailable && daemonAvailable;
  } catch {
    return false;
  }
}

export function normalizeHydraStartupMode(mode: string | undefined): HydraStartupMode {
  const normalized = String(mode ?? '')
    .trim()
    .toLowerCase();
  return HYDRA_STARTUP_MODES.includes(normalized as HydraStartupMode)
    ? (normalized as HydraStartupMode)
    : 'auto';
}

export function deriveHydraPortFromWorktree(worktreePath: string): number {
  const digest = createHash('sha256').update(path.resolve(worktreePath)).digest();
  const offset = digest.readUInt32BE(0) % HYDRA_PORT_SPAN;
  return HYDRA_PORT_MIN + offset;
}

export function buildHydraOperatorArgs(
  operatorArgs: string[],
  options: { url: string; startupMode: HydraStartupMode },
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
  const response = await fetch(`${url}/health`, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Hydra health check failed (${response.status})`);
  }
  return (await response.json()) as HydraHealthResponse;
}

async function requestHydraShutdown(url: string): Promise<void> {
  const response = await fetch(`${url}/shutdown`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`Hydra shutdown failed (${response.status})`);
  }
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return true;
    await sleep(HYDRA_HEALTH_POLL_INTERVAL_MS);
  }
  return isPortAvailable(port);
}

async function pickHydraPort(worktreePath: string): Promise<number> {
  const preferred = deriveHydraPortFromWorktree(worktreePath);
  for (let offset = 0; offset < HYDRA_PORT_PROBE_ATTEMPTS; offset += 1) {
    const candidate = HYDRA_PORT_MIN + ((preferred - HYDRA_PORT_MIN + offset) % HYDRA_PORT_SPAN);
    if (await isPortAvailable(candidate)) {
      return candidate;
    }

    const url = buildHydraUrl(candidate);
    try {
      const health = await fetchHydraHealth(url);
      const daemonProjectRoot = typeof health.projectRoot === 'string' ? health.projectRoot : '';
      if (daemonProjectRoot && path.resolve(daemonProjectRoot) === path.resolve(worktreePath)) {
        await requestHydraShutdown(url);
        if (await waitForPortRelease(candidate, HYDRA_SHUTDOWN_TIMEOUT_MS)) {
          return candidate;
        }
      }
    } catch {
      // Non-Hydra listener or unreachable service; try the next port.
    }
  }

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

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for child process to exit.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    function onExit() {
      cleanup();
      resolve();
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function terminateChild(
  child: ChildProcess | null | undefined,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.killed) return;
  child.kill(signal);
  try {
    await waitForChildExit(child, timeoutMs);
  } catch {
    if (signal !== 'SIGKILL') {
      child.kill('SIGKILL');
      await waitForChildExit(child, Math.max(250, Math.min(1_000, timeoutMs)));
    }
  }
}

async function waitForHydraHealth(
  url: string,
  daemon: ChildProcess,
  daemonOutput: string[],
  daemonSpawnError: { current: Error | null },
): Promise<void> {
  const deadline = Date.now() + HYDRA_HEALTH_TIMEOUT_MS;
  let lastError = 'Hydra daemon did not report healthy status.';

  while (Date.now() < deadline) {
    if (daemonSpawnError.current) {
      throw buildHydraDaemonFailure(daemonSpawnError.current.message, daemonOutput);
    }
    if (daemon.exitCode !== null) {
      break;
    }

    try {
      const health = await fetchHydraHealth(url);
      if (health.running) return;
      lastError = 'Hydra daemon responded without reporting a running state.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(HYDRA_HEALTH_POLL_INTERVAL_MS);
  }

  if (daemonSpawnError.current) {
    throw buildHydraDaemonFailure(daemonSpawnError.current.message, daemonOutput);
  }

  throw buildHydraDaemonFailure(lastError, daemonOutput);
}

async function shutdownHydraDaemon(url: string, daemon: ChildProcess | null): Promise<void> {
  if (!daemon || daemon.pid === undefined || daemon.exitCode !== null || daemon.killed) return;

  try {
    await requestHydraShutdown(url);
  } catch {
    // Fall back to direct termination below.
  }

  try {
    await waitForChildExit(daemon, HYDRA_SHUTDOWN_TIMEOUT_MS);
    return;
  } catch {
    // Fall back to direct termination below.
  }

  await terminateChild(daemon, 'SIGTERM', HYDRA_SHUTDOWN_TIMEOUT_MS);
}

async function runHydraAdapter(): Promise<number> {
  const options = parseAdapterArgs(process.argv.slice(2));
  const worktreePath = process.cwd();
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
  const daemon = spawn(runtime.daemon.command, runtime.daemon.args, {
    cwd: worktreePath,
    env: hydraEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemonSpawnError: { current: Error | null } = { current: null };
  daemon.once('error', (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    daemonSpawnError.current = new Error(
      `Failed to start Hydra daemon (${formatSpawnCommand(runtime.daemon.command, runtime.daemon.args)}): ${reason}`,
    );
  });

  daemon.stdout?.on('data', (chunk: Buffer) => appendCapturedLines(daemonOutput, chunk));
  daemon.stderr?.on('data', (chunk: Buffer) => appendCapturedLines(daemonOutput, chunk));

  let cleanedUp = false;
  let cleaningUp: Promise<void> | null = null;
  const operatorArgs = buildHydraOperatorArgs(options.operatorArgs, {
    url,
    startupMode: options.startupMode,
  });
  let operator: ChildProcess | null = null;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    if (cleaningUp) return cleaningUp;

    cleaningUp = (async () => {
      cleanedUp = true;
      await shutdownHydraDaemon(url, daemon);
    })();

    await cleaningUp;
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      if (operator && operator.exitCode === null) {
        await terminateChild(operator, 'SIGTERM', HYDRA_SHUTDOWN_TIMEOUT_MS);
      }
      await cleanup();
      const exitCode = signal === 'SIGINT' ? 130 : 1;
      process.exit(exitCode);
    })();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('SIGHUP', handleSignal);

  try {
    await waitForHydraHealth(url, daemon, daemonOutput, daemonSpawnError);

    operator = spawn(runtime.operator.command, [...runtime.operator.args, ...operatorArgs], {
      cwd: worktreePath,
      env: hydraEnv,
      stdio: 'inherit',
    });

    const operatorResult = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        operator?.once('error', reject);
        operator?.once('exit', (code, signal) => {
          resolve({
            code,
            signal: typeof signal === 'string' ? signal : null,
          });
        });
      },
    );

    await cleanup();
    if (operatorResult.code !== null) return operatorResult.code;
    return operatorResult.signal ? 1 : 0;
  } catch (error) {
    if (operator && operator.exitCode === null) {
      await terminateChild(operator, 'SIGTERM', HYDRA_SHUTDOWN_TIMEOUT_MS);
    }
    await cleanup();
    throw error;
  }
}

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
