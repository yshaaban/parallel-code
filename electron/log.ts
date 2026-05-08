import { IPC } from './ipc/channels.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

export interface RendererLogPayload {
  category: string;
  ctx?: LogContext;
  level: LogLevel;
  level_min: LogLevel;
  msg: string;
  ts: number;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const VALID_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const CATEGORY_MAX_LENGTH = 256;
const MESSAGE_MAX_LENGTH = 4096;
const CONTEXT_MAX_BYTES = 16 * 1024;
const OUTPUT_CONTEXT_MAX_BYTES = 4 * 1024;
const STACK_MAX_LINES = 50;
const MALFORMED_RENDERER_LOG_SHAPES = new Set<string>();

let minLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
let emitting = false;

export function setMinLevel(level: LogLevel): void {
  minLevel = level;
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

export function handleRendererLogPayload(rawPayload: unknown): void {
  if (!isValidRendererLogPayload(rawPayload)) {
    const shape = getPayloadShape(rawPayload);
    if (!MALFORMED_RENDERER_LOG_SHAPES.has(shape)) {
      MALFORMED_RENDERER_LOG_SHAPES.add(shape);
      warn('log.ipc', `Malformed ${IPC.LogFromRenderer} payload dropped`, { shape });
    }
    return;
  }

  emit(rawPayload.level, `renderer.${rawPayload.category}`, rawPayload.msg, rawPayload.ctx);
}

export function isValidRendererLogPayload(value: unknown): value is RendererLogPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Record<string, unknown>;
  if (!VALID_LEVELS.has(payload.level as LogLevel)) {
    return false;
  }
  if (!VALID_LEVELS.has(payload.level_min as LogLevel)) {
    return false;
  }
  if (typeof payload.category !== 'string' || payload.category.length > CATEGORY_MAX_LENGTH) {
    return false;
  }
  if (typeof payload.msg !== 'string' || payload.msg.length > MESSAGE_MAX_LENGTH) {
    return false;
  }
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) {
    return false;
  }
  if (payload.ctx === undefined) {
    return true;
  }
  if (typeof payload.ctx !== 'object' || payload.ctx === null || Array.isArray(payload.ctx)) {
    return false;
  }

  return getSerializedByteLength(payload.ctx) <= CONTEXT_MAX_BYTES;
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
    const contextOutput = serializeContextForOutput(context);
    const line = `[${formatTime(timestamp)}] ${level.toUpperCase()} ${category}: ${message}${contextOutput}`;
    writeConsole(level, line);
    if (level === 'error') {
      const stack = getStack(thrown);
      if (stack) {
        writeConsole(level, stack);
      }
    }
  } catch {
    // Logging must never throw into application code.
  } finally {
    emitting = false;
  }
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
    // eslint-disable-next-line no-console -- this module is the main-process logging boundary.
    console.info(line);
    return;
  }

  // eslint-disable-next-line no-console -- this module is the main-process logging boundary.
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

function serializeContextForOutput(context: LogContext | undefined): string {
  if (context === undefined) {
    return '';
  }

  const serialized = safeStringify(context);
  if (!serialized) {
    return '';
  }
  if (serialized.length <= OUTPUT_CONTEXT_MAX_BYTES) {
    return ` ${serialized}`;
  }

  return ` ${serialized.slice(0, OUTPUT_CONTEXT_MAX_BYTES)}...`;
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

function getSerializedByteLength(value: unknown): number {
  const serialized = safeStringify(value);
  if (serialized === null) {
    return Number.POSITIVE_INFINITY;
  }

  return Buffer.byteLength(serialized, 'utf8');
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
      if (typeof (value as { nodeType?: unknown }).nodeType === 'number') {
        return '[node]';
      }
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    return value;
  };
}

function getPayloadShape(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return typeof value;
  }

  const payload = value as Record<string, unknown>;
  return [
    `level=${typeof payload.level}`,
    `level_min=${typeof payload.level_min}`,
    `category=${typeof payload.category}`,
    `msg=${typeof payload.msg}`,
    `ts=${typeof payload.ts}`,
    `ctx=${payload.ctx === undefined ? 'undefined' : typeof payload.ctx}`,
  ].join(',');
}
