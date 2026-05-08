import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMinLevel,
  handleRendererLogPayload,
  isValidRendererLogPayload,
  setMinLevel,
  type RendererLogPayload,
} from './log.js';

const validPayload: RendererLogPayload = {
  category: 'terminal',
  level: 'warn',
  level_min: 'warn',
  msg: 'paste failed',
  ts: 1,
};

describe('main logger renderer payload validation', () => {
  afterEach(() => {
    setMinLevel('debug');
    vi.restoreAllMocks();
  });

  it('accepts a valid renderer payload', () => {
    expect(isValidRendererLogPayload(validPayload)).toBe(true);
  });

  it('rejects malformed or oversized renderer payloads', () => {
    expect(isValidRendererLogPayload(undefined)).toBe(false);
    expect(isValidRendererLogPayload({ ...validPayload, level: 'trace' })).toBe(false);
    expect(isValidRendererLogPayload({ ...validPayload, category: 'x'.repeat(257) })).toBe(false);
    expect(isValidRendererLogPayload({ ...validPayload, msg: 'x'.repeat(4097) })).toBe(false);
    expect(isValidRendererLogPayload({ ...validPayload, ctx: ['not', 'an', 'object'] })).toBe(
      false,
    );
    expect(isValidRendererLogPayload({ ...validPayload, ctx: { value: 'x'.repeat(20_000) } })).toBe(
      false,
    );
  });

  it('counts circular context toward the size cap', () => {
    const small: Record<string, unknown> = { name: 'small' };
    small.self = small;
    const large: Record<string, unknown> = { value: 'x'.repeat(20_000) };
    large.self = large;

    expect(isValidRendererLogPayload({ ...validPayload, ctx: small })).toBe(true);
    expect(isValidRendererLogPayload({ ...validPayload, ctx: large })).toBe(false);
  });

  it('logs valid renderer payloads through the main logger', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    handleRendererLogPayload({
      ...validPayload,
      category: 'clipboard',
      ctx: { taskId: 'task-1' },
      msg: 'copy failed',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('renderer.clipboard'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('copy failed'));
  });

  it('does not let renderer payloads mutate the main logger threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMinLevel('error');

    handleRendererLogPayload({
      ...validPayload,
      level: 'warn',
      level_min: 'debug',
      msg: 'lower main threshold',
    });

    expect(getMinLevel()).toBe('error');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
