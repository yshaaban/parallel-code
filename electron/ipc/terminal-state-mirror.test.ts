import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';
import { TerminalStateMirror } from './terminal-state-mirror.js';

let mirrors: TerminalStateMirror[] = [];

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
  const mirror = new TerminalStateMirror(cols, rows);
  mirrors.push(mirror);
  return mirror;
}

async function serializeMirrorText(mirror: TerminalStateMirror): Promise<string> {
  const state = await mirror.serialize();
  expect(state).not.toBeNull();
  return state?.data.toString('utf8') ?? '';
}

async function serializeMirrorOutput(output: string): Promise<string> {
  const mirror = createMirror();
  mirror.enqueueOutput(Buffer.from(output));
  return serializeMirrorText(mirror);
}

beforeEach(() => {
  resetBackendRuntimeDiagnostics();
  mirrors = [];
});

afterEach(() => {
  for (const mirror of mirrors) {
    mirror.dispose();
  }
  mirrors = [];
});

describe('TerminalStateMirror', () => {
  it('records enqueue and serialize diagnostics', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('hello'));
    const state = await mirror.serialize();

    expect(state?.data.toString('utf8')).toContain('hello');
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalStateMirror).toMatchObject({
      instances: 1,
      operationDrainCount: 1,
      outputBytes: 5,
      outputEnqueues: 1,
      serializeCacheHits: 0,
      serializeRequests: 1,
    });
  });

  it('serves repeated serializations from the cached terminal state', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('cached'));
    const first = await mirror.serialize();
    const second = await mirror.serialize();

    expect(first?.data.toString('utf8')).toContain('cached');
    expect(second?.data.toString('utf8')).toBe(first?.data.toString('utf8'));
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalStateMirror).toMatchObject({
      serializeCacheHits: 1,
      serializeRequests: 2,
    });
  });

  it('serves concurrent serializations from the cached terminal state after shared pending work', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('concurrent'));
    const [first, second] = await Promise.all([mirror.serialize(), mirror.serialize()]);

    expect(first?.data.toString('utf8')).toContain('concurrent');
    expect(second?.data.toString('utf8')).toBe(first?.data.toString('utf8'));
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalStateMirror).toMatchObject({
      serializeCacheHits: 1,
      serializeRequests: 2,
    });
  });

  it('invalidates the cached terminal state after output or resize work is queued', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('first'));
    await mirror.serialize();
    await mirror.serialize();
    mirror.enqueueOutput(Buffer.from(' second'));
    mirror.enqueueResize(100, 30);
    const state = await mirror.serialize();

    expect(state?.cols).toBe(100);
    expect(state?.rows).toBe(30);
    expect(state?.data.toString('utf8')).toContain('first second');
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalStateMirror).toMatchObject({
      outputEnqueues: 2,
      resizeEnqueues: 1,
      serializeCacheHits: 1,
      serializeRequests: 3,
    });
  });

  it('preserves output across queue storage compaction', async () => {
    const mirror = createMirror();
    const chunkCount = 1_100;

    for (let index = 0; index < chunkCount; index += 1) {
      mirror.enqueueOutput(Buffer.from('x'));
    }
    const serialized = await serializeMirrorText(mirror);

    expect(serialized.match(/x/g)).toHaveLength(chunkCount);
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalStateMirror).toMatchObject({
      operationDrainCount: chunkCount,
      outputEnqueues: chunkCount,
    });
  });

  it('preserves hidden cursor mode in serialized terminal state', async () => {
    const serialized = await serializeMirrorOutput('\x1b[?25lTUI draws its own cursor');

    expect(serialized).toContain('TUI draws its own cursor');
    expect(serialized.endsWith('\x1b[?25l')).toBe(true);
  });

  it('preserves restored visible cursor mode in serialized terminal state', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('\x1b[?25lhidden'));
    mirror.enqueueOutput(Buffer.from('\x1b[?25hvisible'));
    const serialized = await serializeMirrorText(mirror);

    expect(serialized).toContain('hiddenvisible');
    expect(serialized.endsWith('\x1b[?25h')).toBe(true);
  });

  it('preserves private mode sequences split across output chunks', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('\x1b[?2'));
    mirror.enqueueOutput(Buffer.from('5lhidden after split'));
    const serialized = await serializeMirrorText(mirror);

    expect(serialized).toContain('hidden after split');
    expect(serialized.endsWith('\x1b[?25l')).toBe(true);
  });

  it('preserves bracketed paste mode in serialized terminal state', async () => {
    const serialized = await serializeMirrorOutput('\x1b[?2004hbracketed paste');

    expect(serialized).toContain('bracketed paste');
    expect(serialized.endsWith('\x1b[?2004h')).toBe(true);
  });

  it('preserves combined DEC private mode updates', async () => {
    const serialized = await serializeMirrorOutput('\x1b[?25;2004hcombined private modes');

    expect(serialized).toContain('combined private modes');
    expect(serialized.endsWith('\x1b[?2004h\x1b[?25h')).toBe(true);
  });

  it('restores bracketed paste mode after terminal full reset', async () => {
    const serialized = await serializeMirrorOutput('\x1b[?2004hbracketed paste before reset\x1bc');

    expect(serialized.endsWith('\x1b[?2004l')).toBe(true);
  });

  it('preserves xterm cursor visibility state after terminal full reset', async () => {
    const serialized = await serializeMirrorOutput(
      '\x1b[?25l\x1b[?2004hprivate modes before reset\x1bc',
    );

    expect(serialized.endsWith('\x1b[?2004l\x1b[?25l')).toBe(true);
  });

  it('restores private mode defaults after terminal soft reset', async () => {
    const serialized = await serializeMirrorOutput(
      '\x1b[?25l\x1b[?2004hprivate modes before reset\x1b[!p',
    );

    expect(serialized.endsWith('\x1b[?2004l\x1b[?25h')).toBe(true);
  });
});

describe('TerminalStateMirror.serializeLatest', () => {
  it('jumps the queued backlog and reports the applied cursor', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('one'), 3);
    mirror.enqueueOutput(Buffer.from('two'), 6);
    mirror.enqueueOutput(Buffer.from('three'), 11);

    // serializeLatest waits only for the single in-flight write, never the
    // queued backlog, so callers compose the rest from the ring buffer.
    const latest = await mirror.serializeLatest();
    expect(latest).not.toBeNull();
    expect(latest?.appliedCursor).toBe(3);
    expect(latest?.data.toString('utf8')).toContain('one');
    expect(latest?.data.toString('utf8')).not.toContain('two');

    const full = await mirror.serialize();
    expect(full?.data.toString('utf8')).toContain('onetwothree');
  });

  it('reports the final cursor once the backlog has drained', async () => {
    const mirror = createMirror();

    mirror.enqueueOutput(Buffer.from('alpha'), 5);
    mirror.enqueueOutput(Buffer.from('beta'), 9);
    await mirror.serialize();

    const latest = await mirror.serializeLatest();
    expect(latest?.appliedCursor).toBe(9);
    expect(latest?.data.toString('utf8')).toContain('alphabeta');
  });

  it('returns null after dispose', async () => {
    const mirror = createMirror();
    mirror.enqueueOutput(Buffer.from('bytes'), 5);
    mirror.dispose();

    await expect(mirror.serializeLatest()).resolves.toBeNull();
  });
});
