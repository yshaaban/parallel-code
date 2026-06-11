import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackendFocusReporter, type BackendFocusPayload } from './backend-focus-reporter';

interface ReporterHarness {
  dispose: () => void;
  rerunEffect: () => void;
  sendFocus: ReturnType<typeof vi.fn>;
  sent: BackendFocusPayload[];
  setFocusedChannelIds: (channelIds: string[]) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setVisibleTaskIds: (taskIds: string[]) => void;
  triggerForcedResend: () => void;
}

function createReporterHarness(): ReporterHarness {
  let selectedTaskId: string | null = null;
  let visibleTaskIds: string[] | null = null;
  let focusedChannelIds: string[] = [];
  let effect: (() => void) | null = null;
  let forcedResend: (() => void) | null = null;
  let focusedChannelListener: (() => void) | null = null;
  const sent: BackendFocusPayload[] = [];
  const sendFocus = vi.fn((payload: BackendFocusPayload) => {
    sent.push(payload);
    return Promise.resolve();
  });

  const dispose = createBackendFocusReporter({
    createReactiveEffect: (run) => {
      effect = run;
      run();
    },
    getFocusedChannelIds: () => focusedChannelIds,
    getSelectedTaskId: () => selectedTaskId,
    getVisibleTaskIds: (selected) => visibleTaskIds ?? (selected ? [selected] : []),
    sendFocus,
    subscribeFocusedChannelChanges: (listener) => {
      focusedChannelListener = listener;
      return () => {
        focusedChannelListener = null;
      };
    },
    subscribeForcedResend: (resend) => {
      forcedResend = resend;
      return () => {
        forcedResend = null;
      };
    },
  });

  return {
    dispose,
    rerunEffect: () => effect?.(),
    sendFocus,
    sent,
    setFocusedChannelIds: (channelIds) => {
      focusedChannelIds = channelIds;
      focusedChannelListener?.();
    },
    setSelectedTaskId: (taskId) => {
      selectedTaskId = taskId;
      effect?.();
    },
    setVisibleTaskIds: (taskIds) => {
      visibleTaskIds = taskIds;
      effect?.();
    },
    triggerForcedResend: () => forcedResend?.(),
  };
}

describe('backend focus reporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays quiet on empty focus and sends leading-edge on selection change', () => {
    const harness = createReporterHarness();

    expect(harness.sent).toEqual([]);
    harness.triggerForcedResend();
    vi.advanceTimersByTime(30_000);
    expect(harness.sent).toEqual([]);

    harness.setSelectedTaskId('task-1');
    expect(harness.sent).toEqual([
      { focusedChannelIds: [], selectedTaskId: 'task-1', visibleTaskIds: ['task-1'] },
    ]);

    harness.setSelectedTaskId(null);
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]).toEqual({
      focusedChannelIds: [],
      selectedTaskId: null,
      visibleTaskIds: [],
    });

    harness.dispose();
  });

  it('does not resend when nothing changed', () => {
    const harness = createReporterHarness();
    harness.setSelectedTaskId('task-1');
    const sendsAfterSelection = harness.sent.length;

    harness.rerunEffect();
    harness.rerunEffect();
    vi.advanceTimersByTime(1_000);

    expect(harness.sent).toHaveLength(sendsAfterSelection);
    harness.dispose();
  });

  it('debounces visibility-set churn while keeping selection sends immediate', () => {
    const harness = createReporterHarness();
    harness.setSelectedTaskId('task-1');
    const sendsAfterSelection = harness.sent.length;

    harness.setVisibleTaskIds(['task-1', 'task-2']);
    harness.setVisibleTaskIds(['task-1', 'task-2', 'task-3']);
    expect(harness.sent).toHaveLength(sendsAfterSelection);

    vi.advanceTimersByTime(250);
    expect(harness.sent).toHaveLength(sendsAfterSelection + 1);
    expect(harness.sent.at(-1)).toEqual({
      focusedChannelIds: [],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1', 'task-2', 'task-3'],
    });

    harness.dispose();
  });

  it('resends the current focus on forced resend (reconnect) and on keepalive', () => {
    const harness = createReporterHarness();
    harness.setSelectedTaskId('task-1');
    const sendsAfterSelection = harness.sent.length;

    harness.triggerForcedResend();
    expect(harness.sent).toHaveLength(sendsAfterSelection + 1);

    vi.advanceTimersByTime(30_000);
    expect(harness.sent).toHaveLength(sendsAfterSelection + 2);
    expect(harness.sent.at(-1)).toEqual({
      focusedChannelIds: [],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1'],
    });

    harness.dispose();
  });

  it('sends focused-channel changes leading-edge without waiting for the visibility debounce', () => {
    const harness = createReporterHarness();

    harness.setFocusedChannelIds(['channel-1']);
    expect(harness.sent).toEqual([]);

    harness.setSelectedTaskId('task-1');
    expect(harness.sent.at(-1)).toEqual({
      focusedChannelIds: ['channel-1'],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1'],
    });
    const sendsAfterSelection = harness.sent.length;

    harness.setFocusedChannelIds(['channel-2']);
    expect(harness.sent).toHaveLength(sendsAfterSelection + 1);
    expect(harness.sent.at(-1)).toEqual({
      focusedChannelIds: ['channel-2'],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1'],
    });

    harness.setFocusedChannelIds(['channel-2']);
    expect(harness.sent).toHaveLength(sendsAfterSelection + 1);

    harness.dispose();
  });

  it('stops sending after dispose', () => {
    const harness = createReporterHarness();
    harness.dispose();
    const sendsAtDispose = harness.sent.length;

    harness.setSelectedTaskId('task-2');
    harness.triggerForcedResend();
    vi.advanceTimersByTime(60_000);

    expect(harness.sent).toHaveLength(sendsAtDispose);
  });
});
