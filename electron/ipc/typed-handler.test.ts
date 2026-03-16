import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import { defineIpcHandler } from './typed-handler.js';

describe('typed-handler', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects missing payloads for required request channels', () => {
    const handler = defineIpcHandler(IPC.WriteToAgent, vi.fn());

    expect(() => handler()).toThrow(BadRequestError);
    expect(() => handler()).toThrow(`Missing request payload for ${IPC.WriteToAgent}`);
  });

  it('allows omitted payloads for optional request channels', () => {
    const callback = vi.fn().mockReturnValue([]);
    const handler = defineIpcHandler(IPC.ListAgents, callback);

    expect(handler()).toEqual([]);
    expect(callback).toHaveBeenCalledWith({});
  });
});
