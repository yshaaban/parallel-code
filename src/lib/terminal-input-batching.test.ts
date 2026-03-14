import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_PENDING_CHARS,
  MAX_SEND_BATCH_CHARS,
  PASTE_MAX_PENDING_CHARS,
  getTerminalInputBatchPlan,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from './terminal-input-batching';

describe('terminal-input-batching', () => {
  it('flushes control input immediately', () => {
    expect(getTerminalInputBatchPlan('\r')).toEqual({
      flushDelayMs: 0,
      flushImmediately: true,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    });
    expect(getTerminalInputBatchPlan('\u0003')).toEqual({
      flushDelayMs: 0,
      flushImmediately: true,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    });
  });

  it('treats large multiline input as paste', () => {
    const plan = getTerminalInputBatchPlan(`line 1\n${'x'.repeat(80)}`);
    expect(plan.flushImmediately).toBe(false);
    expect(plan.flushDelayMs).toBe(2);
    expect(plan.maxPendingChars).toBe(PASTE_MAX_PENDING_CHARS);
  });

  it('uses a short delay for single-character typing', () => {
    expect(getTerminalInputBatchPlan('a')).toEqual({
      flushDelayMs: 4,
      flushImmediately: false,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    });
  });

  it('keeps the larger pending limit once paste is detected', () => {
    let limit = DEFAULT_MAX_PENDING_CHARS;
    limit = mergePendingInputCharLimit(limit, 'a');
    expect(limit).toBe(DEFAULT_MAX_PENDING_CHARS);
    limit = mergePendingInputCharLimit(limit, `${'x'.repeat(400)}\n${'y'.repeat(400)}`);
    expect(limit).toBe(PASTE_MAX_PENDING_CHARS);
    limit = mergePendingInputCharLimit(limit, 'b');
    expect(limit).toBe(PASTE_MAX_PENDING_CHARS);
  });

  it('coalesces queued chunks up to the send batch cap', () => {
    const queued = [{ data: 'abc' }, { data: 'def' }, { data: 'ghi' }];

    expect(takeQueuedTerminalInputBatch(queued)).toEqual({
      batch: 'abcdefghi',
      count: 3,
    });
  });

  it('supports a larger backend coalescing cap when requested', () => {
    const queued = [{ data: 'a'.repeat(8_000) }, { data: 'b'.repeat(8_000) }];

    expect(takeQueuedTerminalInputBatch(queued, 16_000)).toEqual({
      batch: 'a'.repeat(8_000) + 'b'.repeat(8_000),
      count: 2,
    });
  });

  it('preserves order and stops at the max send batch size', () => {
    const queued = [
      { data: 'a'.repeat(20_000) },
      { data: 'b'.repeat(10_000) },
      { data: 'c'.repeat(10_000) },
    ];

    expect(takeQueuedTerminalInputBatch(queued)).toEqual({
      batch: 'a'.repeat(20_000),
      count: 1,
    });
  });

  it('splits oversized input into protocol-safe chunks', () => {
    const chunks = splitTerminalInputChunks('x'.repeat(MAX_SEND_BATCH_CHARS * 2 + 25));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.data.length).toBe(MAX_SEND_BATCH_CHARS);
    expect(chunks[1]?.data.length).toBe(MAX_SEND_BATCH_CHARS);
    expect(chunks[2]?.data.length).toBe(25);
  });

  it('does not split surrogate pairs across chunks', () => {
    const input = `${'a'.repeat(MAX_SEND_BATCH_CHARS - 1)}😀tail`;
    const chunks = splitTerminalInputChunks(input);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.data.endsWith('\ud83d')).toBe(false);
    expect(chunks[0]?.data.length).toBe(MAX_SEND_BATCH_CHARS - 1);
    expect(chunks[1]?.data.startsWith('\ude00')).toBe(false);
    expect(chunks.map((chunk) => chunk.data).join('')).toBe(input);
  });
});
