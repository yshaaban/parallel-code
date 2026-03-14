export interface TerminalInputBatchPlan {
  flushDelayMs: number;
  flushImmediately: boolean;
  maxPendingChars: number;
}

export interface QueuedTerminalInputBatch {
  data: string;
}

export const DEFAULT_MAX_PENDING_CHARS = 2 * 1024;
export const PASTE_MAX_PENDING_CHARS = 32 * 1024;
export const MAX_SEND_BATCH_CHARS = 4_000;

const IMMEDIATE_FLUSH_INPUTS = ['\r', '\u0003', '\u0004', '\u001a'];

function isLikelyPaste(data: string): boolean {
  return data.length >= 256 || (data.includes('\n') && data.length >= 64);
}

export function hasImmediateFlushTerminalInput(data: string): boolean {
  return IMMEDIATE_FLUSH_INPUTS.some((value) => data.includes(value));
}

export function getTerminalInputBatchPlan(data: string): TerminalInputBatchPlan {
  if (hasImmediateFlushTerminalInput(data)) {
    return {
      flushDelayMs: 0,
      flushImmediately: true,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    };
  }

  if (isLikelyPaste(data)) {
    return {
      flushDelayMs: 2,
      flushImmediately: false,
      maxPendingChars: PASTE_MAX_PENDING_CHARS,
    };
  }

  return {
    flushDelayMs: data.length <= 1 ? 4 : 8,
    flushImmediately: false,
    maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
  };
}

export function mergePendingInputCharLimit(currentLimit: number, data: string): number {
  const nextLimit = getTerminalInputBatchPlan(data).maxPendingChars;
  return Math.max(currentLimit, nextLimit);
}

export function takeQueuedTerminalInputBatch(
  queue: ReadonlyArray<QueuedTerminalInputBatch>,
  maxBatchChars = MAX_SEND_BATCH_CHARS,
): { batch: string; count: number } | null {
  if (queue.length === 0) {
    return null;
  }

  let batch = queue[0]?.data ?? '';
  let count = batch ? 1 : 0;
  let chars = batch.length;

  while (count < queue.length) {
    const next = queue[count];
    if (!next) {
      break;
    }

    const nextChars = next.data.length;
    if (chars + nextChars > maxBatchChars) {
      break;
    }

    batch += next.data;
    chars += nextChars;
    count += 1;
  }

  if (!batch) {
    return null;
  }

  return { batch, count };
}

export function splitTerminalInputChunks(
  data: string,
  maxChunkChars = MAX_SEND_BATCH_CHARS,
): QueuedTerminalInputBatch[] {
  if (!data) {
    return [];
  }

  const chunks: QueuedTerminalInputBatch[] = [];
  let offset = 0;
  while (offset < data.length) {
    const end = getSafeChunkEnd(data, offset, maxChunkChars);
    chunks.push({ data: data.slice(offset, end) });
    offset = end;
  }

  return chunks;
}

function getSafeChunkEnd(data: string, start: number, maxChunkChars: number): number {
  const proposedEnd = Math.min(data.length, start + maxChunkChars);
  if (proposedEnd <= start) {
    return start + 1;
  }

  if (proposedEnd >= data.length) {
    return proposedEnd;
  }

  const previous = data.charCodeAt(proposedEnd - 1);
  const next = data.charCodeAt(proposedEnd);
  const previousIsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  const nextIsLowSurrogate = next >= 0xdc00 && next <= 0xdfff;

  if (previousIsHighSurrogate && nextIsLowSurrogate) {
    return proposedEnd - 1;
  }

  return proposedEnd;
}
