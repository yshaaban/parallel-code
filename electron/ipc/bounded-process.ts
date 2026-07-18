import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type ExecFileOptionsWithBufferEncoding,
  type ExecFileOptionsWithStringEncoding,
  type SpawnOptions,
} from 'child_process';
import { win32 as win32Path } from 'path';

export const DEFAULT_SUBPROCESS_TERMINATE_GRACE_MS = 5_000;
export const DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS = 1_000;

const DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES = 1024 * 1024;
const POSIX_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS = 500;
// Direct spawns retain an eager silent window because their output can be a readiness contract.
// Buffered one-shot helpers have no such contract, so they get a wider window that lets ordinary
// short commands finish without a process-table scan while still sampling longer-lived trees.
const POSIX_STARTUP_OWNERSHIP_CAPTURE_DELAYS_MS = [20, 100] as const;
const POSIX_BUFFERED_OWNERSHIP_CAPTURE_DELAYS_MS = [100, 250] as const;
const POSIX_TERMINATION_RETRY_MS = 100;

export interface SubprocessLifecycleOptions {
  createTimeoutError?: ((timeoutMs: number) => Error) | undefined;
  forceKillCloseGraceMs?: number | undefined;
  signal?: AbortSignal | undefined;
  terminateGraceMs?: number | undefined;
  timeoutMs: number;
}

export interface SubprocessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface BoundedSpawn {
  child: ChildProcess;
  completion: Promise<SubprocessExit>;
  /** Set only when the lifecycle had to settle without observing confirmed process-tree cleanup. */
  readonly forcedTerminationError: Error | undefined;
  terminate: (error: Error) => void;
}

/**
 * Requests bounded process-tree termination and waits until ownership is confirmed released.
 * The rejection created by this request is an expected completion outcome; an earlier process
 * failure or a forced settlement without confirmed tree cleanup remains observable to callers.
 */
export async function terminateBoundedSpawnAndWait(
  bounded: BoundedSpawn,
  terminationError: Error,
): Promise<void> {
  bounded.terminate(terminationError);
  try {
    await bounded.completion;
  } catch (completionError) {
    if (bounded.forcedTerminationError !== undefined) {
      throw bounded.forcedTerminationError;
    }
    if (completionError !== terminationError) {
      throw completionError;
    }
  }
}

type SpawnLifecycleOptionKey = 'detached' | 'killSignal' | 'signal' | 'timeout';

export type BoundedSpawnOptions = Omit<SpawnOptions, SpawnLifecycleOptionKey>;

type ExecFileLifecycleOptionKey = 'killSignal' | 'signal' | 'timeout';

interface BoundedExecFileLifecycleOptions {
  forceKillCloseGraceMs?: number | undefined;
  input?: Buffer | string | undefined;
  signal?: AbortSignal | undefined;
  terminateGraceMs?: number | undefined;
  timeoutMs: number;
}

export type BoundedExecFileOptions = Omit<ExecFileOptions, ExecFileLifecycleOptionKey> &
  BoundedExecFileLifecycleOptions;

export type BoundedExecFileOptionsWithStringEncoding = Omit<
  ExecFileOptionsWithStringEncoding,
  ExecFileLifecycleOptionKey
> &
  BoundedExecFileLifecycleOptions;

export type BoundedExecFileOptionsWithBufferEncoding = Omit<
  ExecFileOptionsWithBufferEncoding,
  ExecFileLifecycleOptionKey
> &
  BoundedExecFileLifecycleOptions;

export interface BoundedExecFileResult<TOutput extends Buffer | string> {
  stderr: TOutput;
  stdout: TOutput;
}

export class SubprocessTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} subprocess timed out after ${timeoutMs}ms`);
    this.name = 'SubprocessTimeoutError';
  }
}

class SubprocessMaxBufferError extends RangeError {
  readonly code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

  constructor(readonly stream: 'stderr' | 'stdout') {
    super(`${stream} maxBuffer length exceeded`);
  }
}

interface ChildLifecycleHandlers {
  onClose: (exit: SubprocessExit, terminationError: Error | undefined) => void;
  onForcedTermination: (error: Error) => void;
}

interface ChildLifecycleController {
  readonly terminationError: Error | undefined;
  settleExternally: () => boolean;
  terminate: (error: Error) => void;
}

type PosixStartupOutputCaptureMode = 'immediate' | 'scheduled';

interface PosixProcessRecord {
  pgid: number;
  pid: number;
  ppid: number;
  startTime: string;
  status: string;
}

interface OwnedPosixProcessTree {
  child: ChildProcess;
  initialized: boolean;
  processes: Map<number, PosixProcessRecord>;
  rootIdentity?: PosixProcessRecord;
  rootPid: number;
  rootProcessGroupAbsent: boolean;
  rootProcessGroupAlive: boolean;
  startupCaptureDelaysMs: readonly number[];
  startupCaptureDueAt: number;
  startupCaptureIndex: number;
  startupCapturePending: boolean;
  startupCaptureStartedAt: number;
  startupOutputObserved: boolean;
}

const activePosixProcessTrees = new Set<OwnedPosixProcessTree>();
let posixStartupCaptureDueAt: number | undefined;
let posixStartupCaptureTimer: ReturnType<typeof setTimeout> | undefined;

function validateLifecycleDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function validateLifecycleOptions(options: SubprocessLifecycleOptions): void {
  validateLifecycleDuration(options.timeoutMs, 'timeoutMs');
  validateLifecycleDuration(
    options.terminateGraceMs ?? DEFAULT_SUBPROCESS_TERMINATE_GRACE_MS,
    'terminateGraceMs',
  );
  validateLifecycleDuration(
    options.forceKillCloseGraceMs ?? DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS,
    'forceKillCloseGraceMs',
  );
}

function validateMaxBuffer(maxBuffer: number): void {
  if (typeof maxBuffer !== 'number' || Number.isNaN(maxBuffer) || maxBuffer < 0) {
    throw new RangeError('maxBuffer must be a non-negative number');
  }
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : 'The subprocess operation was aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  Object.defineProperties(error, {
    cause: { configurable: true, value: reason, writable: true },
    code: { configurable: true, enumerable: true, value: 'ABORT_ERR', writable: true },
  });
  return error;
}

function destroyChildStreams(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function hasPositivePid(child: ChildProcess): child is ChildProcess & { pid: number } {
  return Number.isInteger(child.pid) && (child.pid ?? 0) > 0;
}

function signalDirectChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    // The child can exit between the lifecycle check and signal delivery.
    return false;
  }
}

function getSystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function readPosixProcessSnapshot(): Map<number, PosixProcessRecord> {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8',
    maxBuffer: POSIX_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: POSIX_PROCESS_SNAPSHOT_TIMEOUT_MS,
  });
  const snapshot = new Map<number, PosixProcessRecord>();

  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) {
      throw new Error(`Could not parse POSIX process snapshot line: ${line}`);
    }

    const processRecord: PosixProcessRecord = {
      pgid: Number(match[3]),
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startTime: match[5] ?? '',
      status: match[4] ?? '',
    };
    if (
      !Number.isInteger(processRecord.pid) ||
      processRecord.pid <= 0 ||
      !Number.isInteger(processRecord.ppid) ||
      processRecord.ppid < 0 ||
      !Number.isInteger(processRecord.pgid) ||
      processRecord.pgid <= 0 ||
      processRecord.startTime.length === 0 ||
      snapshot.has(processRecord.pid)
    ) {
      throw new Error(`Invalid POSIX process snapshot line: ${line}`);
    }
    snapshot.set(processRecord.pid, processRecord);
  }

  if (!snapshot.has(process.pid)) {
    throw new Error('POSIX process snapshot did not include the current process');
  }
  return snapshot;
}

function hasSamePosixProcessIdentity(
  previous: PosixProcessRecord,
  current: PosixProcessRecord,
): boolean {
  return previous.pid === current.pid && previous.startTime === current.startTime;
}

function isAlivePosixProcess(processRecord: PosixProcessRecord): boolean {
  return !processRecord.status.startsWith('Z');
}

function probePosixProcessGroup(processGroup: number): boolean | undefined {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return getSystemErrorCode(error) === 'ESRCH' ? false : undefined;
  }
}

function refreshOwnedPosixProcessTree(
  state: OwnedPosixProcessTree,
  snapshot: Map<number, PosixProcessRecord> = readPosixProcessSnapshot(),
): Map<number, PosixProcessRecord> {
  const rootHasNotExited =
    (state.child.exitCode === null || state.child.exitCode === undefined) &&
    (state.child.signalCode === null || state.child.signalCode === undefined);
  const anchoredProcessGroups = new Set<number>();

  for (const [pid, retainedProcess] of state.processes) {
    const currentProcess = snapshot.get(pid);
    if (
      !currentProcess ||
      !hasSamePosixProcessIdentity(retainedProcess, currentProcess) ||
      !isAlivePosixProcess(currentProcess)
    ) {
      state.processes.delete(pid);
      continue;
    }
    state.processes.set(pid, currentProcess);
    anchoredProcessGroups.add(currentProcess.pgid);
  }

  const currentRootProcess = snapshot.get(state.rootPid);
  const rootPidWasReused =
    !rootHasNotExited &&
    currentRootProcess !== undefined &&
    isAlivePosixProcess(currentRootProcess) &&
    (!state.rootIdentity || !hasSamePosixProcessIdentity(state.rootIdentity, currentRootProcess));
  if (rootPidWasReused) {
    state.rootProcessGroupAbsent = true;
  }

  if (!state.rootProcessGroupAbsent) {
    const snapshotHasRootProcessGroup = Array.from(snapshot.values()).some(
      (processRecord) => processRecord.pgid === state.rootPid && isAlivePosixProcess(processRecord),
    );
    if (snapshotHasRootProcessGroup) {
      state.rootProcessGroupAlive = true;
    } else {
      const groupProbe = probePosixProcessGroup(state.rootPid);
      state.rootProcessGroupAlive = groupProbe !== false;
      state.rootProcessGroupAbsent = groupProbe === false;
    }
  } else {
    state.rootProcessGroupAlive = false;
  }
  if (state.rootProcessGroupAlive) {
    anchoredProcessGroups.add(state.rootPid);
  }

  if (!state.initialized) {
    const rootProcess = snapshot.get(state.rootPid);
    if (rootProcess && rootHasNotExited && isAlivePosixProcess(rootProcess)) {
      state.rootIdentity = rootProcess;
      state.processes.set(rootProcess.pid, rootProcess);
      anchoredProcessGroups.add(rootProcess.pgid);
    }
    state.initialized = true;
  }

  let discoveredProcess = true;
  while (discoveredProcess) {
    discoveredProcess = false;
    const ownedPids = new Set(state.processes.keys());
    for (const ownedProcess of state.processes.values()) {
      anchoredProcessGroups.add(ownedProcess.pgid);
    }

    for (const processRecord of snapshot.values()) {
      if (
        !isAlivePosixProcess(processRecord) ||
        state.processes.has(processRecord.pid) ||
        (!ownedPids.has(processRecord.ppid) && !anchoredProcessGroups.has(processRecord.pgid))
      ) {
        continue;
      }
      state.processes.set(processRecord.pid, processRecord);
      anchoredProcessGroups.add(processRecord.pgid);
      discoveredProcess = true;
    }
  }

  return snapshot;
}

function captureActivePosixProcessTrees(): boolean {
  if (activePosixProcessTrees.size === 0) {
    return false;
  }

  try {
    const snapshot = readPosixProcessSnapshot();
    for (const state of activePosixProcessTrees) {
      refreshOwnedPosixProcessTree(state, snapshot);
    }
    return true;
  } catch {
    // Termination performs another bounded snapshot and retains process-group fallback cleanup.
    return false;
  }
}

function capturePosixStartupActivity(
  state: OwnedPosixProcessTree,
  captureMode: PosixStartupOutputCaptureMode,
): void {
  if (state.startupOutputObserved) {
    return;
  }

  if (captureMode === 'immediate') {
    if (!captureActivePosixProcessTrees()) {
      return;
    }
    state.startupOutputObserved = true;
    state.startupCapturePending = false;
    schedulePosixStartupOwnershipCapture();
    return;
  }

  state.startupOutputObserved = true;
  const outputCaptureDueAt = Date.now() + (state.startupCaptureDelaysMs[0] ?? 0);
  state.startupCaptureDueAt = state.startupCapturePending
    ? Math.min(state.startupCaptureDueAt, outputCaptureDueAt)
    : outputCaptureDueAt;
  state.startupCapturePending = true;
  schedulePosixStartupOwnershipCapture();
}

function schedulePosixStartupOwnershipCapture(): void {
  const nextCaptureDueAt = Math.min(
    ...Array.from(activePosixProcessTrees)
      .filter((state) => state.startupCapturePending)
      .map((state) => state.startupCaptureDueAt),
  );
  if (!Number.isFinite(nextCaptureDueAt)) {
    if (posixStartupCaptureTimer !== undefined) {
      clearTimeout(posixStartupCaptureTimer);
      posixStartupCaptureTimer = undefined;
      posixStartupCaptureDueAt = undefined;
    }
    return;
  }
  if (
    posixStartupCaptureTimer !== undefined &&
    posixStartupCaptureDueAt !== undefined &&
    posixStartupCaptureDueAt === nextCaptureDueAt
  ) {
    return;
  }
  if (posixStartupCaptureTimer !== undefined) {
    clearTimeout(posixStartupCaptureTimer);
  }
  posixStartupCaptureDueAt = nextCaptureDueAt;
  posixStartupCaptureTimer = setTimeout(
    () => {
      posixStartupCaptureTimer = undefined;
      posixStartupCaptureDueAt = undefined;
      const captureSucceeded = captureActivePosixProcessTrees();
      const capturedAt = Date.now();
      for (const state of activePosixProcessTrees) {
        if (state.startupCaptureDueAt <= capturedAt) {
          if (state.startupOutputObserved && captureSucceeded) {
            state.startupCapturePending = false;
            continue;
          }
          let nextCaptureIndex = state.startupCaptureIndex + 1;
          while (
            nextCaptureIndex < state.startupCaptureDelaysMs.length &&
            state.startupCaptureStartedAt + (state.startupCaptureDelaysMs[nextCaptureIndex] ?? 0) <=
              capturedAt
          ) {
            nextCaptureIndex += 1;
          }
          const nextCaptureDelay = state.startupCaptureDelaysMs[nextCaptureIndex];
          state.startupCaptureIndex = nextCaptureIndex;
          state.startupCapturePending = nextCaptureDelay !== undefined;
          if (nextCaptureDelay !== undefined) {
            state.startupCaptureDueAt = state.startupCaptureStartedAt + nextCaptureDelay;
          }
        }
      }
      schedulePosixStartupOwnershipCapture();
    },
    Math.max(0, nextCaptureDueAt - Date.now()),
  );
  posixStartupCaptureTimer.unref?.();
}

function registerOwnedPosixProcessTree(
  child: ChildProcess,
  startupOutputCaptureMode: PosixStartupOutputCaptureMode,
): OwnedPosixProcessTree | undefined {
  if (process.platform === 'win32' || !hasPositivePid(child)) {
    return undefined;
  }

  const startupCaptureStartedAt = Date.now();
  const startupCaptureDelaysMs =
    startupOutputCaptureMode === 'immediate'
      ? POSIX_STARTUP_OWNERSHIP_CAPTURE_DELAYS_MS
      : POSIX_BUFFERED_OWNERSHIP_CAPTURE_DELAYS_MS;
  const state: OwnedPosixProcessTree = {
    child,
    initialized: false,
    processes: new Map(),
    rootPid: child.pid,
    rootProcessGroupAbsent: false,
    rootProcessGroupAlive: true,
    startupCaptureDelaysMs,
    startupCaptureDueAt: startupCaptureStartedAt + (startupCaptureDelaysMs[0] ?? 0),
    startupCaptureIndex: 0,
    startupCapturePending: true,
    startupCaptureStartedAt,
    startupOutputObserved: false,
  };
  activePosixProcessTrees.add(state);
  schedulePosixStartupOwnershipCapture();
  return state;
}

function unregisterOwnedPosixProcessTree(state: OwnedPosixProcessTree | undefined): void {
  if (!state) {
    return;
  }
  activePosixProcessTrees.delete(state);
  schedulePosixStartupOwnershipCapture();
}

function inspectOwnedPosixProcessTree(state: OwnedPosixProcessTree):
  | {
      aliveProcesses: PosixProcessRecord[];
      rootProcessGroupAlive: boolean;
      snapshot: Map<number, PosixProcessRecord>;
    }
  | undefined {
  try {
    const snapshot = refreshOwnedPosixProcessTree(state);
    const aliveProcesses = Array.from(state.processes.values()).filter((retainedProcess) => {
      const currentProcess = snapshot.get(retainedProcess.pid);
      return (
        currentProcess !== undefined &&
        hasSamePosixProcessIdentity(retainedProcess, currentProcess) &&
        isAlivePosixProcess(currentProcess)
      );
    });
    return { aliveProcesses, rootProcessGroupAlive: state.rootProcessGroupAlive, snapshot };
  } catch {
    return undefined;
  }
}

function signalOwnedPosixProcessTree(
  state: OwnedPosixProcessTree,
  inspection: NonNullable<ReturnType<typeof inspectOwnedPosixProcessTree>>,
  signal: NodeJS.Signals,
): void {
  const currentProcessGroup = inspection.snapshot.get(process.pid)?.pgid;
  if (!currentProcessGroup) {
    return;
  }
  const safeProcessGroups = new Set(
    inspection.aliveProcesses
      .map((ownedProcess) => ownedProcess.pgid)
      .filter((processGroup) => processGroup > 0 && processGroup !== currentProcessGroup),
  );
  if (inspection.rootProcessGroupAlive && state.rootPid !== currentProcessGroup) {
    safeProcessGroups.add(state.rootPid);
  }

  for (const processGroup of safeProcessGroups) {
    try {
      process.kill(-processGroup, signal);
    } catch {
      // A group can disappear between the verified snapshot and signal delivery.
    }
  }

  for (const ownedProcess of inspection.aliveProcesses) {
    if (safeProcessGroups.has(ownedProcess.pgid) || ownedProcess.pid === process.pid) {
      continue;
    }
    try {
      process.kill(ownedProcess.pid, signal);
    } catch {
      // A process can disappear between the verified snapshot and signal delivery.
    }
  }
}

function signalPosixProcessGroupFallback(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!hasPositivePid(child)) {
    return signalDirectChild(child, signal);
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (getSystemErrorCode(error) === 'ESRCH') {
      signalDirectChild(child, signal);
      return true;
    }
    signalDirectChild(child, signal);
    return false;
  }
}

function isPosixProcessGroupAliveFallback(child: ChildProcess): boolean {
  if (!hasPositivePid(child)) {
    return false;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return getSystemErrorCode(error) !== 'ESRCH';
  }
}

function getWindowsTaskkillPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return win32Path.join(systemRoot, 'System32', 'taskkill.exe');
}

function runWindowsTreeKill(
  child: ChildProcess,
  force: boolean,
  timeoutMs: number,
  forceCloseGraceMs: number,
): Promise<boolean> {
  if (!hasPositivePid(child)) {
    signalDirectChild(child, 'SIGKILL');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let taskkill: ChildProcess;
    try {
      const args = ['/pid', String(child.pid), '/t'];
      if (force) {
        args.push('/f');
      }
      taskkill = spawn(getWindowsTaskkillPath(), args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      signalDirectChild(child, 'SIGKILL');
      resolve(false);
      return;
    }

    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let requestSettled = false;
    let timedOut = false;

    function clearHelperTimers(): void {
      if (operationTimer !== undefined) {
        clearTimeout(operationTimer);
        operationTimer = undefined;
      }
      if (forceCloseTimer !== undefined) {
        clearTimeout(forceCloseTimer);
        forceCloseTimer = undefined;
      }
    }

    function detachHelperListeners(): void {
      taskkill.off('error', handleError);
      taskkill.off('close', handleClose);
    }

    function settleRequest(succeeded: boolean): void {
      if (requestSettled) {
        return;
      }
      requestSettled = true;
      clearHelperTimers();
      detachHelperListeners();
      if (!succeeded) {
        signalDirectChild(child, 'SIGKILL');
        taskkill.unref();
      }
      resolve(succeeded);
    }

    function handleError(): void {
      settleRequest(false);
    }

    function handleClose(code: number | null): void {
      if (requestSettled) {
        detachHelperListeners();
        return;
      }
      settleRequest(!timedOut && code === 0);
      detachHelperListeners();
    }

    // Keep the error guard until the bounded request settles: kill() can schedule an error.
    taskkill.on('error', handleError);
    taskkill.once('close', handleClose);
    operationTimer = setTimeout(() => {
      operationTimer = undefined;
      timedOut = true;
      signalDirectChild(taskkill, 'SIGKILL');
      signalDirectChild(child, 'SIGKILL');
      forceCloseTimer = setTimeout(() => {
        forceCloseTimer = undefined;
        settleRequest(false);
      }, forceCloseGraceMs);
      forceCloseTimer.unref?.();
    }, timeoutMs);
    operationTimer.unref?.();
  });
}

async function stopOwnedWindowsProcessTree(
  child: ChildProcess,
  terminateGraceMs: number,
  forceCloseGraceMs: number,
): Promise<boolean> {
  const initialAttemptSucceeded = await runWindowsTreeKill(
    child,
    false,
    terminateGraceMs,
    forceCloseGraceMs,
  );
  if (initialAttemptSucceeded) {
    return true;
  }

  // Retain the root PID and retry tree mode even if the root exited while the first request ran.
  return runWindowsTreeKill(child, true, forceCloseGraceMs, forceCloseGraceMs);
}

function observePosixStartupStream(
  stream: NonNullable<ChildProcess['stdout']>,
  capture: () => void,
): () => void {
  let observedEvent: 'data' | 'readable' | undefined;

  function handleActivity(): void {
    capture();
    stream.off('newListener', handleNewListener);
  }

  function handleNewListener(eventName: string | symbol): void {
    if (observedEvent !== undefined || (eventName !== 'data' && eventName !== 'readable')) {
      return;
    }
    observedEvent = eventName;
    stream.once(eventName, handleActivity);
  }

  stream.on('newListener', handleNewListener);
  return () => {
    stream.off('newListener', handleNewListener);
    if (observedEvent !== undefined) {
      stream.off(observedEvent, handleActivity);
    }
  };
}

function attachBoundedChildLifecycle(
  child: ChildProcess,
  options: SubprocessLifecycleOptions,
  handlers: ChildLifecycleHandlers,
  startupOutputCaptureMode: PosixStartupOutputCaptureMode,
): ChildLifecycleController {
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_SUBPROCESS_TERMINATE_GRACE_MS;
  const forceKillCloseGraceMs =
    options.forceKillCloseGraceMs ?? DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS;

  validateLifecycleOptions(options);

  const ownedPosixProcessTree = registerOwnedPosixProcessTree(child, startupOutputCaptureMode);
  const stopObservingPosixStartupStreams = ownedPosixProcessTree
    ? [child.stdout, child.stderr]
        .filter((stream): stream is NonNullable<typeof stream> => stream !== null)
        .map((stream) =>
          observePosixStartupStream(stream, () =>
            capturePosixStartupActivity(ownedPosixProcessTree, startupOutputCaptureMode),
          ),
        )
    : [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let posixExitCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  let posixRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let closeExit: SubprocessExit | undefined;
  let closeListenerAttached = false;
  let exitListenerAttached = false;
  let terminationError: Error | undefined;
  let treeSignalInFlight: Promise<boolean> | undefined;
  let windowsTreeKillSucceeded = false;
  let settled = false;

  function clearLifecycleTimers(): void {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    if (forceKillCloseTimer !== undefined) {
      clearTimeout(forceKillCloseTimer);
      forceKillCloseTimer = undefined;
    }
    if (posixRetryTimer !== undefined) {
      clearTimeout(posixRetryTimer);
      posixRetryTimer = undefined;
    }
    if (posixExitCaptureTimer !== undefined) {
      clearTimeout(posixExitCaptureTimer);
      posixExitCaptureTimer = undefined;
    }
  }

  function cleanup(): void {
    clearLifecycleTimers();
    unregisterOwnedPosixProcessTree(ownedPosixProcessTree);
    for (const stopObserving of stopObservingPosixStartupStreams) {
      stopObserving();
    }
    if (closeListenerAttached) {
      child.off('close', handleClose);
      closeListenerAttached = false;
    }
    if (exitListenerAttached) {
      child.off('exit', handleExit);
      exitListenerAttached = false;
    }
    options.signal?.removeEventListener('abort', handleAbort);
  }

  function settleExternally(): boolean {
    if (settled) {
      return false;
    }
    settled = true;
    cleanup();
    return true;
  }

  function trySettleTerminatedClose(): void {
    if (settled || !terminationError || !closeExit || treeSignalInFlight) {
      return;
    }

    let treeIsGone: boolean;
    if (process.platform === 'win32') {
      treeIsGone = windowsTreeKillSucceeded;
    } else if (ownedPosixProcessTree) {
      const inspection = inspectOwnedPosixProcessTree(ownedPosixProcessTree);
      treeIsGone =
        inspection !== undefined &&
        !inspection.rootProcessGroupAlive &&
        inspection.aliveProcesses.length === 0;
    } else {
      treeIsGone = !isPosixProcessGroupAliveFallback(child);
    }
    if (!treeIsGone || !settleExternally()) {
      return;
    }
    handlers.onClose(closeExit, terminationError);
  }

  function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    closeExit = { code, signal };
    if (terminationError) {
      trySettleTerminatedClose();
      return;
    }
    if (!settleExternally()) {
      return;
    }
    handlers.onClose(closeExit, undefined);
  }

  function handleExit(): void {
    if (!ownedPosixProcessTree || posixExitCaptureTimer !== undefined) {
      return;
    }
    // Normal close follows exit and cancels this work. A pipe-holding descendant delays close,
    // leaving one final startup snapshot to retain an escaped group after its root disappears.
    posixExitCaptureTimer = setTimeout(() => {
      posixExitCaptureTimer = undefined;
      captureActivePosixProcessTrees();
    }, 0);
    posixExitCaptureTimer.unref?.();
  }

  function attachCloseListener(): void {
    if (closeListenerAttached) {
      return;
    }
    closeListenerAttached = true;
    child.once('close', handleClose);
    exitListenerAttached = true;
    child.once('exit', handleExit);
  }

  function signalOwnedPosixTree(signal: NodeJS.Signals): void {
    if (!ownedPosixProcessTree) {
      signalPosixProcessGroupFallback(child, signal);
      return;
    }

    const inspection = inspectOwnedPosixProcessTree(ownedPosixProcessTree);
    if (!inspection) {
      signalPosixProcessGroupFallback(child, signal);
      return;
    }
    signalOwnedPosixProcessTree(ownedPosixProcessTree, inspection, signal);
  }

  function finishWindowsTreeCleanup(succeeded: boolean, error: Error): void {
    windowsTreeKillSucceeded = succeeded;
    treeSignalInFlight = undefined;
    trySettleTerminatedClose();
    if (settled || forceKillCloseTimer !== undefined) {
      return;
    }

    forceKillCloseTimer = setTimeout(() => {
      forceKillCloseTimer = undefined;
      if (!settleExternally()) {
        return;
      }
      handlers.onForcedTermination(terminationError ?? error);
    }, forceKillCloseGraceMs);
    forceKillCloseTimer.unref?.();
  }

  function startWindowsTreeCleanup(error: Error): void {
    const request = stopOwnedWindowsProcessTree(child, terminateGraceMs, forceKillCloseGraceMs);
    treeSignalInFlight = request;
    void request.then(
      (succeeded) => finishWindowsTreeCleanup(succeeded, error),
      () => finishWindowsTreeCleanup(false, error),
    );
  }

  function schedulePosixTerminationRetry(): void {
    const retryDelayMs = Math.min(POSIX_TERMINATION_RETRY_MS, forceKillCloseGraceMs);
    if (settled || retryDelayMs <= 0 || posixRetryTimer !== undefined) {
      return;
    }
    posixRetryTimer = setTimeout(() => {
      posixRetryTimer = undefined;
      if (settled) {
        return;
      }
      signalOwnedPosixTree('SIGKILL');
      trySettleTerminatedClose();
      schedulePosixTerminationRetry();
    }, retryDelayMs);
    posixRetryTimer.unref?.();
  }

  function terminate(error: Error): void {
    if (settled || terminationError) {
      return;
    }

    terminationError = error;
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    attachCloseListener();

    if (process.platform === 'win32') {
      startWindowsTreeCleanup(error);
      return;
    }

    signalOwnedPosixTree('SIGTERM');
    trySettleTerminatedClose();
    if (settled) {
      return;
    }

    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      if (settled) {
        return;
      }

      signalOwnedPosixTree('SIGKILL');
      trySettleTerminatedClose();
      if (settled) {
        return;
      }
      schedulePosixTerminationRetry();
      forceKillCloseTimer = setTimeout(() => {
        forceKillCloseTimer = undefined;
        signalOwnedPosixTree('SIGKILL');
        trySettleTerminatedClose();
        if (settled) {
          return;
        }
        if (!settleExternally()) {
          return;
        }
        handlers.onForcedTermination(terminationError ?? error);
      }, forceKillCloseGraceMs);
      forceKillCloseTimer.unref?.();
    }, terminateGraceMs);
    forceKillTimer.unref?.();
  }

  function handleAbort(): void {
    if (options.signal) {
      terminate(createAbortError(options.signal));
    }
  }

  attachCloseListener();
  if (options.signal) {
    options.signal.addEventListener('abort', handleAbort, { once: true });
  }
  if (options.timeoutMs > 0) {
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      terminate(
        options.createTimeoutError?.(options.timeoutMs) ??
          new SubprocessTimeoutError(child.spawnfile, options.timeoutMs),
      );
    }, options.timeoutMs);
    deadlineTimer.unref?.();
  }
  return {
    get terminationError() {
      return terminationError;
    },
    settleExternally,
    terminate,
  };
}

function spawnWithDeadlineOwned(
  command: string,
  args: readonly string[],
  options: BoundedSpawnOptions,
  lifecycleOptions: SubprocessLifecycleOptions,
  startupOutputCaptureMode: PosixStartupOutputCaptureMode,
): BoundedSpawn {
  validateLifecycleOptions(lifecycleOptions);
  if (lifecycleOptions.signal?.aborted) {
    throw createAbortError(lifecycleOptions.signal);
  }

  const child = spawn(command, [...args], {
    ...options,
    detached: process.platform !== 'win32',
  });
  let resolveCompletion!: (exit: SubprocessExit) => void;
  let rejectCompletion!: (error: Error) => void;
  let forcedTerminationError: Error | undefined;

  const completion = new Promise<SubprocessExit>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  function cleanupErrorListener(): void {
    child.off('error', handleError);
  }

  function handleError(error: Error): void {
    if (lifecycle.terminationError) {
      // Termination still owns completion and bounds the final close wait.
      return;
    }
    if (hasPositivePid(child)) {
      lifecycle.terminate(error);
      return;
    }
    if (!lifecycle.settleExternally()) {
      return;
    }
    cleanupErrorListener();
    rejectCompletion(error);
  }

  const lifecycle = attachBoundedChildLifecycle(
    child,
    lifecycleOptions,
    {
      onClose: (exit, terminationError) => {
        cleanupErrorListener();
        if (terminationError) {
          rejectCompletion(terminationError);
          return;
        }
        resolveCompletion(exit);
      },
      onForcedTermination: (error) => {
        forcedTerminationError = error;
        cleanupErrorListener();
        rejectCompletion(error);
      },
    },
    startupOutputCaptureMode,
  );
  child.on('error', handleError);
  if (lifecycleOptions.signal?.aborted) {
    lifecycle.terminate(createAbortError(lifecycleOptions.signal));
  }

  return {
    child,
    completion,
    get forcedTerminationError() {
      return forcedTerminationError;
    },
    terminate: lifecycle.terminate,
  };
}

export function spawnWithDeadline(
  command: string,
  args: readonly string[],
  options: BoundedSpawnOptions,
  lifecycleOptions: SubprocessLifecycleOptions,
): BoundedSpawn {
  // Direct stream output can be the only readiness signal before a root exits and an escaped
  // descendant is reparented, so this path preserves immediate ownership capture.
  return spawnWithDeadlineOwned(command, args, options, lifecycleOptions, 'immediate');
}

function cloneErrorForDecoration(error: Error): Error {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    delete descriptors.cmd;
    delete descriptors.stderr;
    delete descriptors.stdout;
    return Object.create(Object.getPrototypeOf(error), descriptors) as Error;
  } catch {
    const clone = new Error(error.message);
    clone.name = error.name;
    Object.defineProperty(clone, 'cause', { configurable: true, value: error, writable: true });
    return clone;
  }
}

function addBufferedOutputToError(
  error: Error,
  cmd: string,
  stdout: Buffer | string,
  stderr: Buffer | string,
): Error {
  try {
    Object.assign(error, { cmd, stderr, stdout });
    return error;
  } catch {
    const clone = cloneErrorForDecoration(error);
    Object.defineProperties(clone, {
      cmd: { configurable: true, enumerable: true, value: cmd, writable: true },
      stderr: { configurable: true, enumerable: true, value: stderr, writable: true },
      stdout: { configurable: true, enumerable: true, value: stdout, writable: true },
    });
    return clone;
  }
}

function decodeBufferedOutput(
  chunks: ReadonlyArray<Buffer | string>,
  encoding: BufferEncoding | null,
): Buffer | string {
  if (encoding) {
    return chunks.join('');
  }
  return Buffer.concat(chunks as readonly Buffer[]);
}

function getBufferedOutputEncoding(encoding: string | null | undefined): BufferEncoding | null {
  const candidate = encoding ?? 'utf8';
  return encoding !== 'buffer' && encoding !== null && Buffer.isEncoding(candidate)
    ? (candidate as BufferEncoding)
    : null;
}

function createExitError(
  command: string,
  args: readonly string[],
  exit: SubprocessExit,
  stderr: Buffer | string,
): Error {
  const renderedCommand = [command, ...args].join(' ');
  const error = new Error(`Command failed: ${renderedCommand}\n${String(stderr)}`);
  Object.assign(error, {
    cmd: renderedCommand,
    code: exit.code,
    killed: false,
    signal: exit.signal,
  });
  return error;
}

export function execFileWithDeadline(
  command: string,
  args: readonly string[],
  options: BoundedExecFileOptionsWithBufferEncoding,
): Promise<BoundedExecFileResult<Buffer>>;
export function execFileWithDeadline(
  command: string,
  args: readonly string[],
  options: BoundedExecFileOptionsWithStringEncoding,
): Promise<BoundedExecFileResult<string>>;
export function execFileWithDeadline(
  command: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
): Promise<BoundedExecFileResult<Buffer | string>>;
export function execFileWithDeadline(
  command: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
): Promise<BoundedExecFileResult<Buffer | string>> {
  const {
    encoding,
    forceKillCloseGraceMs,
    input,
    maxBuffer = DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES,
    signal,
    terminateGraceMs,
    timeoutMs,
    ...spawnOptions
  } = options;

  validateLifecycleOptions({ forceKillCloseGraceMs, signal, terminateGraceMs, timeoutMs });
  validateMaxBuffer(maxBuffer);
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }

  let bounded: BoundedSpawn;
  try {
    // Buffered one-shot commands do not expose readiness output to their caller. Coalesce their
    // ownership scan so ordinary short-lived helpers can finish without synchronously running ps.
    bounded = spawnWithDeadlineOwned(
      command,
      args,
      { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] },
      { forceKillCloseGraceMs, signal, terminateGraceMs, timeoutMs },
      'scheduled',
    );
  } catch (error) {
    return Promise.reject(error);
  }

  const { child, completion, terminate } = bounded;
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    const error = new Error(`${command} did not provide piped standard streams`);
    terminate(error);
    destroyChildStreams(child);
    return completion.then(
      () => Promise.reject(error),
      (reason: unknown) => Promise.reject(reason),
    );
  }
  const pipedStdin = stdin;
  const pipedStdout = stdout;
  const pipedStderr = stderr;
  const outputEncoding = getBufferedOutputEncoding(encoding);
  if (outputEncoding) {
    pipedStdout.setEncoding(outputEncoding);
    pipedStderr.setEncoding(outputEncoding);
  }

  return new Promise((resolve, reject) => {
    const stdoutChunks: Array<Buffer | string> = [];
    const stderrChunks: Array<Buffer | string> = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let collectionStopped = false;
    let settled = false;

    function collectChunk(stream: 'stderr' | 'stdout', value: Buffer | string): void {
      if (settled || collectionStopped) {
        return;
      }
      const chunk = outputEncoding
        ? typeof value === 'string'
          ? value
          : value.toString(outputEncoding)
        : Buffer.isBuffer(value)
          ? value
          : Buffer.from(value);
      const chunkLength =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk, outputEncoding ?? 'utf8')
          : chunk.length;
      const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks;
      const nextLength = (stream === 'stdout' ? stdoutLength : stderrLength) + chunkLength;
      if (nextLength > maxBuffer) {
        const remaining = maxBuffer - (nextLength - chunkLength);
        if (remaining > 0) {
          const partialChunk = chunk.slice(0, remaining);
          chunks.push(partialChunk);
        }
        collectionStopped = true;
        terminate(new SubprocessMaxBufferError(stream));
        destroyChildStreams(child);
        return;
      }

      chunks.push(chunk);
      if (stream === 'stdout') {
        stdoutLength = nextLength;
      } else {
        stderrLength = nextLength;
      }
    }

    const handleStdoutData = (chunk: Buffer | string): void => collectChunk('stdout', chunk);
    const handleStderrData = (chunk: Buffer | string): void => collectChunk('stderr', chunk);
    const handleStreamError = (error: Error): void => terminate(error);

    function cleanup(): void {
      pipedStdin.off('error', handleStreamError);
      pipedStdout.off('data', handleStdoutData);
      pipedStdout.off('error', handleStreamError);
      pipedStderr.off('data', handleStderrData);
      pipedStderr.off('error', handleStreamError);
      destroyChildStreams(child);
    }

    function finish(error: Error | undefined, exit: SubprocessExit | undefined): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = decodeBufferedOutput(stdoutChunks, outputEncoding);
      const stderr = decodeBufferedOutput(stderrChunks, outputEncoding);
      const commandError =
        error ??
        (exit && exit.code !== 0 ? createExitError(command, args, exit, stderr) : undefined);
      if (commandError) {
        reject(
          addBufferedOutputToError(commandError, [command, ...args].join(' '), stdout, stderr),
        );
        return;
      }
      resolve({ stderr, stdout });
    }

    pipedStdout.on('data', handleStdoutData);
    pipedStdout.once('error', handleStreamError);
    pipedStderr.on('data', handleStderrData);
    pipedStderr.once('error', handleStreamError);
    pipedStdin.once('error', handleStreamError);
    try {
      // This API only returns buffered output, so callers cannot close the child's stdin
      // themselves. Always deliver EOF; otherwise commands that read until EOF remain alive
      // until the deadline whenever no explicit input was supplied.
      pipedStdin.end(input);
    } catch (error) {
      terminate(error as Error);
    }

    void completion.then(
      (exit) => finish(undefined, exit),
      (error: Error) => finish(error, undefined),
    );
  });
}
