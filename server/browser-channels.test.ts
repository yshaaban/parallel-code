import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import { createBrowserChannelManager } from './browser-channels.js';

const CHANNEL_ID = '12345678-1234-1234-1234-123456789012';

function createFakeClient(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
  } as unknown as WebSocket;
}

function encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeChannelData(frame: Buffer | string): { channelId: string; text: string } {
  if (Buffer.isBuffer(frame)) {
    return {
      channelId: frame.subarray(1, 37).toString('ascii'),
      text: frame.subarray(37).toString('utf8'),
    };
  }

  const message = JSON.parse(frame) as {
    channelId: string;
    payload: { data?: string; type?: string };
  };

  return {
    channelId: message.channelId,
    text: Buffer.from(message.payload.data ?? '', 'base64').toString('utf8'),
  };
}

function decodeJsonPayload(frame: Buffer | string): unknown {
  if (Buffer.isBuffer(frame)) {
    throw new Error('Expected a JSON frame');
  }

  return JSON.parse(frame);
}

describe('browser channel manager', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetBackendRuntimeDiagnostics();
  });

  it('coalesces disconnected terminal backlog into one queued frame', () => {
    const sent: Array<Buffer | string> = [];
    const client = createFakeClient();
    const manager = createBrowserChannelManager({
      clearAutoPauseReasonsForChannel: vi.fn(),
      coalescedChannelDataMaxBytes: 64 * 1024,
      send: (_client, data) => {
        sent.push(data);
        return true;
      },
    });

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('hello '),
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('world'),
    });

    manager.bindChannel(client, CHANNEL_ID);

    expect(sent).toHaveLength(1);
    expect(decodeChannelData(sent[0])).toEqual({
      channelId: CHANNEL_ID,
      text: 'hello world',
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      coalescedMessages: 1,
    });
    manager.cleanup();
  });

  it('immediately resets a newly bound client when the pending backlog is already too large', () => {
    const sent: Array<Buffer | string> = [];
    const client = createFakeClient();
    const manager = createBrowserChannelManager({
      clearAutoPauseReasonsForChannel: vi.fn(),
      clientDegradedMaxQueuedBytes: 8,
      coalescedChannelDataMaxBytes: 64 * 1024,
      send: (_client, data) => {
        sent.push(data);
        return true;
      },
    });

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('backlog payload'),
    });

    manager.bindChannel(client, CHANNEL_ID);

    expect(sent).toHaveLength(1);
    expect(decodeJsonPayload(sent[0])).toMatchObject({
      channelId: CHANNEL_ID,
      payload: {
        reason: 'backpressure',
        type: 'ResetRequired',
      },
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      degradedClientChannels: 1,
      maxQueuedBytes: expect.any(Number),
      resetBindings: 1,
    });
    manager.cleanup();
  });

  it('coalesces queued terminal data for a backpressured client', async () => {
    vi.useFakeTimers();

    const sent: Array<Buffer | string> = [];
    const client = createFakeClient();
    let blocked = true;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      coalescedChannelDataMaxBytes: 64 * 1024,
      send: (_client, data) => {
        if (blocked) {
          return false;
        }
        sent.push(data);
        return true;
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('alpha '),
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('beta'),
    });

    blocked = false;
    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(1);
    expect(decodeChannelData(sent[0])).toEqual({
      channelId: CHANNEL_ID,
      text: 'alpha beta',
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      coalescedMessages: 1,
    });
    manager.cleanup();
  });

  it('does not coalesce terminal data across non-data payload boundaries', () => {
    const sent: Array<Buffer | string> = [];
    const client = createFakeClient();
    const manager = createBrowserChannelManager({
      clearAutoPauseReasonsForChannel: vi.fn(),
      coalescedChannelDataMaxBytes: 64 * 1024,
      send: (_client, data) => {
        sent.push(data);
        return true;
      },
    });

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('before'),
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Exit',
      data: {
        exit_code: 0,
        last_output: [],
        signal: null,
      },
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('after'),
    });

    manager.bindChannel(client, CHANNEL_ID);

    expect(sent).toHaveLength(3);
    expect(decodeChannelData(sent[0]).text).toBe('before');
    expect(decodeJsonPayload(sent[1])).toMatchObject({
      channelId: CHANNEL_ID,
      payload: {
        type: 'Exit',
      },
    });
    expect(decodeChannelData(sent[2]).text).toBe('after');
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels.coalescedMessages).toBe(0);
    manager.cleanup();
  });

  it('degrades a slow client and keeps healthy peers receiving live data', async () => {
    vi.useFakeTimers();

    const slowClient = createFakeClient();
    const healthyClient = createFakeClient();
    const slowSent: Array<Buffer | string> = [];
    const healthySent: Array<Buffer | string> = [];
    let slowBlocked = true;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      clientDegradedMaxDrainPasses: 2,
      clientDegradedMaxQueueAgeMs: 10_000,
      clientDegradedMaxQueuedBytes: 512 * 1024,
      send: (client, data) => {
        if (client === slowClient) {
          if (slowBlocked) {
            return false;
          }
          slowSent.push(data);
          return true;
        }

        healthySent.push(data);
        return true;
      },
    });

    manager.bindChannel(slowClient, CHANNEL_ID);
    manager.bindChannel(healthyClient, CHANNEL_ID);

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });

    await vi.advanceTimersByTimeAsync(120);

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('second'),
    });

    slowBlocked = false;
    await vi.advanceTimersByTimeAsync(60);

    expect(healthySent).toHaveLength(2);
    expect(decodeChannelData(healthySent[0]).text).toBe('first');
    expect(decodeChannelData(healthySent[1]).text).toBe('second');
    expect(slowSent).toHaveLength(1);
    expect(decodeJsonPayload(slowSent[0])).toMatchObject({
      channelId: CHANNEL_ID,
      payload: {
        reason: 'backpressure',
        type: 'ResetRequired',
      },
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      degradedClientChannels: 1,
      droppedDataMessages: 1,
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels.maxQueueAgeMs).toBeGreaterThan(0);
    manager.cleanup();
  });

  it('stops retrying live data while a client is waiting on reset required delivery', async () => {
    vi.useFakeTimers();

    const slowClient = createFakeClient();
    const healthyClient = createFakeClient();
    const healthySent: Array<Buffer | string> = [];
    const slowAttempts: Array<Buffer | string> = [];
    let slowMode: 'queue' | 'drain-reset' | 'open' = 'queue';
    let resetDelivered = false;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      clientDegradedMaxDrainPasses: 1,
      clientDegradedMaxQueueAgeMs: 10_000,
      clientDegradedMaxQueuedBytes: 512 * 1024,
      send: (client, data) => {
        if (client === healthyClient) {
          healthySent.push(data);
          return true;
        }

        slowAttempts.push(data);
        switch (slowMode) {
          case 'queue':
            return false;
          case 'drain-reset':
            if (resetDelivered) {
              return false;
            }
            resetDelivered = true;
            return true;
          case 'open':
            return true;
        }
      },
    });

    manager.bindChannel(slowClient, CHANNEL_ID);
    manager.bindChannel(healthyClient, CHANNEL_ID);

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });

    await vi.advanceTimersByTimeAsync(60);
    const attemptsAfterResetQueued = slowAttempts.length;

    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('second'),
    });
    expect(slowAttempts).toHaveLength(attemptsAfterResetQueued);

    slowMode = 'drain-reset';
    await vi.advanceTimersByTimeAsync(60);

    slowMode = 'open';
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('third'),
    });

    expect(healthySent).toHaveLength(3);
    expect(slowAttempts.length).toBeGreaterThan(attemptsAfterResetQueued);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      degradedClientChannels: 1,
      droppedDataMessages: 1,
      recoveredClientChannels: 1,
    });
    manager.cleanup();
  });

  it('does not treat a partial drain as a failed drain pass', async () => {
    vi.useFakeTimers();

    const client = createFakeClient();
    const sent: Array<Buffer | string> = [];
    let mode: 'queue' | 'partial-drain' | 'open' = 'queue';
    let partialDrainSent = false;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      clientDegradedMaxDrainPasses: 1,
      clientDegradedMaxQueueAgeMs: 10_000,
      clientDegradedMaxQueuedBytes: 512 * 1024,
      coalescedChannelDataMaxBytes: 1,
      send: (_client, data) => {
        switch (mode) {
          case 'queue':
            return false;
          case 'partial-drain':
            if (partialDrainSent) {
              return false;
            }
            partialDrainSent = true;
            sent.push(data);
            return true;
          case 'open':
            sent.push(data);
            return true;
        }
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('second'),
    });

    mode = 'partial-drain';
    await vi.advanceTimersByTimeAsync(60);
    mode = 'open';
    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(2);
    expect(decodeChannelData(sent[0]).text).toBe('first');
    expect(decodeChannelData(sent[1]).text).toBe('second');
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels.degradedClientChannels).toBe(0);
    manager.cleanup();
  });

  it('keeps channel message order once a client already has queued backlog', async () => {
    vi.useFakeTimers();

    const client = createFakeClient();
    const sent: Array<Buffer | string> = [];
    let blocked = true;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      coalescedChannelDataMaxBytes: 1,
      send: (_client, data) => {
        if (blocked) {
          return false;
        }
        sent.push(data);
        return true;
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });

    blocked = false;
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('second'),
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(2);
    expect(decodeChannelData(sent[0]).text).toBe('first');
    expect(decodeChannelData(sent[1]).text).toBe('second');
    manager.cleanup();
  });

  it('does not count transport-busy drain deferrals as failed drain passes', async () => {
    vi.useFakeTimers();

    const client = createFakeClient();
    const sent: Array<Buffer | string> = [];
    let sendBlocked = true;
    let transportBusyState: null | {
      queueAgeMs: number;
      queueBytes: number;
      queueDepth: number;
    } = null;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      clientDegradedMaxDrainPasses: 1,
      clientDegradedMaxQueueAgeMs: 10_000,
      clientDegradedMaxQueuedBytes: 512 * 1024,
      getPendingChannelSendState: () => transportBusyState,
      send: (_client, data) => {
        if (sendBlocked) {
          return false;
        }
        sent.push(data);
        return true;
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });

    transportBusyState = {
      queueAgeMs: 60,
      queueBytes: 128 * 1024,
      queueDepth: 4,
    };
    await vi.advanceTimersByTimeAsync(120);

    sendBlocked = false;
    transportBusyState = null;
    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(1);
    expect(decodeChannelData(sent[0]).text).toBe('first');
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels).toMatchObject({
      degradedClientChannels: 0,
      transportBusyDeferrals: 2,
    });
    manager.cleanup();
  });

  it('throttles queued channel drains while delayed transport pressure stays high', async () => {
    vi.useFakeTimers();

    const client = createFakeClient();
    const sent: Array<Buffer | string> = [];
    let sendBlocked = true;
    let transportBusyState: null | {
      queueAgeMs: number;
      queueBytes: number;
      queueDepth: number;
    } = null;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      coalescedChannelDataMaxBytes: 1,
      getPendingChannelSendState: () => transportBusyState,
      send: (_client, data) => {
        if (sendBlocked) {
          return false;
        }
        sent.push(data);
        return true;
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('second'),
    });

    sendBlocked = false;
    transportBusyState = {
      queueAgeMs: 60,
      queueBytes: 128 * 1024,
      queueDepth: 4,
    };
    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(1);
    expect(decodeChannelData(sent[0]).text).toBe('first');

    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(2);
    expect(decodeChannelData(sent[1]).text).toBe('second');
    manager.cleanup();
  });

  it('still drains queued channel data when delayed transport pressure stays shallow', async () => {
    vi.useFakeTimers();

    const client = createFakeClient();
    const sent: Array<Buffer | string> = [];
    let sendBlocked = true;
    let transportBusyState: null | {
      queueAgeMs: number;
      queueBytes: number;
      queueDepth: number;
    } = null;
    const manager = createBrowserChannelManager({
      backpressureDrainIntervalMs: 50,
      clearAutoPauseReasonsForChannel: vi.fn(),
      getPendingChannelSendState: () => transportBusyState,
      send: (_client, data) => {
        if (sendBlocked) {
          return false;
        }
        sent.push(data);
        return true;
      },
    });

    manager.bindChannel(client, CHANNEL_ID);
    manager.sendChannelMessage(CHANNEL_ID, {
      type: 'Data',
      data: encodeText('first'),
    });

    sendBlocked = false;
    transportBusyState = {
      queueAgeMs: 10,
      queueBytes: 8 * 1024,
      queueDepth: 1,
    };
    await vi.advanceTimersByTimeAsync(60);

    expect(sent).toHaveLength(1);
    expect(decodeChannelData(sent[0]).text).toBe('first');
    expect(getBackendRuntimeDiagnosticsSnapshot().browserChannels.transportBusyDeferrals).toBe(0);
    manager.cleanup();
  });
});
