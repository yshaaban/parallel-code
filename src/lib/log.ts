import { IPC } from '../../electron/ipc/channels';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const RATE_LIMIT_PER_SECOND = 50;
const RATE_WINDOW_MS = 1_000;
const CONTEXT_MAX_BYTES = 4 * 1024;
const STACK_MAX_LINES = 50;

let verbose = false;
let minLevel: LogLevel = getDefaultMinLevel();
let emitting = false;

interface RateBucket {
  count: number;
  suppressed: number;
  windowStart: number;
}

const rateBuckets = new Map<string, RateBucket>();
const pendingSuppressionNotices = new Set<string>();
const suppressionNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setVerbose(value: boolean): void {
  verbose = value;
  minLevel = value ? 'debug' : getDefaultMinLevel();
}

export function isVerbose(): boolean {
  return verbose;
}

export function getMinLevel(): LogLevel {
  return minLevel;
}

export function debug(category: string, message: string, context?: LogContext): void {
  emit('debug', category, message, context);
}

export function info(category: string, message: string, context?: LogContext): void {
  emit('info', category, message, context);
}

export function warn(category: string, message: string, context?: LogContext): void {
  emit('warn', category, message, context);
}

export function error(
  category: string,
  message: string,
  thrown: unknown,
  context?: LogContext,
): void {
  emit('error', category, message, context, thrown);
}

export function resetLoggerForTests(): void {
  verbose = false;
  minLevel = getDefaultMinLevel();
  emitting = false;
  for (const timer of suppressionNoticeTimers.values()) {
    clearTimeout(timer);
  }
  rateBuckets.clear();
  pendingSuppressionNotices.clear();
  suppressionNoticeTimers.clear();
}

function emit(
  level: LogLevel,
  category: string,
  message: string,
  context?: LogContext,
  thrown?: unknown,
): void {
  if (emitting || LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    return;
  }

  emitting = true;
  try {
    const timestamp = Date.now();
    writeConsole(
      level,
      `[${formatTime(timestamp)}] ${level.toUpperCase()} ${category}: ${message}${serializeContext(context)}`,
    );
    if (level === 'error') {
      const stack = getStack(thrown);
      if (stack) {
        writeConsole(level, stack);
      }
    }
    forwardToMainIfNeeded(level, category, message, context, timestamp);
  } catch {
    // Logging must never throw into application code.
  } finally {
    emitting = false;
  }
}

function getDefaultMinLevel(): LogLevel {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true ? 'debug' : 'warn';
}

function shouldForward(level: LogLevel): boolean {
  if (level === 'debug') {
    return false;
  }
  if (level === 'info') {
    return verbose;
  }
  return true;
}

function forwardToMainIfNeeded(
  level: LogLevel,
  category: string,
  message: string,
  context: LogContext | undefined,
  timestamp: number,
): void {
  if (!shouldForward(level) || !takeRateBudget(category, timestamp)) {
    return;
  }

  invokeRendererLog({
    category,
    ...(context !== undefined ? { ctx: context } : {}),
    level,
    level_min: minLevel,
    msg: message,
    ts: timestamp,
  });
}

function takeRateBudget(category: string, nowMs: number): boolean {
  let bucket = rateBuckets.get(category);
  if (!bucket || nowMs - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket = { count: 0, suppressed: 0, windowStart: nowMs };
    rateBuckets.set(category, bucket);
  }

  if (bucket.count < RATE_LIMIT_PER_SECOND) {
    bucket.count += 1;
    return true;
  }

  bucket.suppressed += 1;
  if (!pendingSuppressionNotices.has(category)) {
    const capturedBucket = bucket;
    const remainingMs = RATE_WINDOW_MS - (nowMs - bucket.windowStart);
    pendingSuppressionNotices.add(category);
    const timer = setTimeout(
      () => {
        pendingSuppressionNotices.delete(category);
        suppressionNoticeTimers.delete(category);
        if (rateBuckets.get(category) === capturedBucket) {
          rateBuckets.delete(category);
        }
        if (capturedBucket.suppressed === 0) {
          return;
        }
        invokeRendererLog({
          category,
          level: 'warn',
          level_min: minLevel,
          msg: `rate-limit suppressed ${capturedBucket.suppressed} entries`,
          ts: Date.now(),
        });
      },
      Math.max(0, remainingMs),
    );
    suppressionNoticeTimers.set(category, timer);
  }

  return false;
}

function invokeRendererLog(payload: {
  category: string;
  ctx?: LogContext;
  level: LogLevel;
  level_min: LogLevel;
  msg: string;
  ts: number;
}): void {
  if (typeof window === 'undefined') {
    return;
  }

  const invoke = window.electron?.ipcRenderer?.invoke;
  if (!invoke) {
    return;
  }

  void invoke(IPC.LogFromRenderer, payload).catch(() => {
    // Console output already happened; forwarding is best-effort.
  });
}

function writeConsole(level: LogLevel, line: string): void {
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'info') {
    // eslint-disable-next-line no-console -- this module is the renderer logging boundary.
    console.info(line);
    return;
  }

  // eslint-disable-next-line no-console -- this module is the renderer logging boundary.
  console.debug(line);
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function serializeContext(context: LogContext | undefined): string {
  if (context === undefined) {
    return '';
  }

  const serialized = safeStringify(context);
  if (!serialized) {
    return '';
  }
  if (serialized.length <= CONTEXT_MAX_BYTES) {
    return ` ${serialized}`;
  }

  return ` ${serialized.slice(0, CONTEXT_MAX_BYTES)}...`;
}

function getStack(thrown: unknown): string | null {
  if (thrown === undefined) {
    return null;
  }
  if (thrown instanceof Error && typeof thrown.stack === 'string') {
    return clipStack(thrown.stack);
  }
  if (thrown && typeof thrown === 'object') {
    const stack = getObjectStack(thrown);
    if (stack !== null) {
      return stack;
    }
  }
  if (typeof thrown === 'string') {
    return thrown;
  }

  return safeStringify(thrown) ?? String(thrown);
}

function getObjectStack(value: object): string | null {
  const stack = (value as { stack?: unknown }).stack;
  return typeof stack === 'string' ? clipStack(stack) : null;
}

function clipStack(stack: string): string {
  const lines = stack.split('\n');
  if (lines.length <= STACK_MAX_LINES) {
    return stack;
  }

  return `${lines.slice(0, STACK_MAX_LINES).join('\n')}\n...`;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, createSafeReplacer());
  } catch {
    return null;
  }
}

function createSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[circular]';
      }
      seen.add(value);
      if (typeof Node !== 'undefined' && value instanceof Node) {
        return '[node]';
      }
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    return value;
  };
}
