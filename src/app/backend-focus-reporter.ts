import { createRenderEffect } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke, onBrowserAuthenticated } from '../lib/ipc';
import { store } from '../store/state';
import {
  getFocusedTerminalChannelIds,
  subscribeFocusedTerminalChannels,
} from './terminal-focused-channels';

// Single renderer owner for the backend focus signal. Watches the selected
// task and the visible task set, then reports them fire-and-forget through
// ReportClientTaskFocus so the backend work queue can prioritize selected and
// visible tasks over background recomputation. Selection changes send
// leading-edge; visibility-set churn is debounced; a periodic keepalive
// refreshes the backend focus-registry TTL for long-lived clients.

export interface BackendFocusPayload {
  focusedChannelIds?: string[];
  selectedTaskId: string | null;
  visibleTaskIds: string[];
}

export interface CreateBackendFocusReporterOptions {
  createReactiveEffect?: (run: () => void) => void;
  getFocusedChannelIds?: () => string[];
  getSelectedTaskId?: () => string | null;
  getVisibleTaskIds?: (selectedTaskId: string | null) => string[];
  keepaliveIntervalMs?: number;
  sendFocus?: (payload: BackendFocusPayload) => Promise<unknown> | unknown;
  subscribeFocusedChannelChanges?: (listener: () => void) => () => void;
  subscribeForcedResend?: (resend: () => void) => () => void;
  visibilityDebounceMs?: number;
}

const DEFAULT_VISIBILITY_DEBOUNCE_MS = 250;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;

function areStringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function defaultSendFocus(payload: BackendFocusPayload): Promise<unknown> {
  return invoke(IPC.ReportClientTaskFocus, payload);
}

function defaultGetSelectedTaskId(): string | null {
  return store.activeTaskId;
}

function defaultGetVisibleTaskIds(selectedTaskId: string | null): string[] {
  return selectedTaskId ? [selectedTaskId] : [];
}

export function createBackendFocusReporter(
  options: CreateBackendFocusReporterOptions = {},
): () => void {
  const createReactiveEffect = options.createReactiveEffect ?? createRenderEffect;
  const getFocusedChannelIds = options.getFocusedChannelIds ?? getFocusedTerminalChannelIds;
  const getSelectedTaskId = options.getSelectedTaskId ?? defaultGetSelectedTaskId;
  const getVisibleTaskIds = options.getVisibleTaskIds ?? defaultGetVisibleTaskIds;
  const sendFocus = options.sendFocus ?? defaultSendFocus;
  const subscribeFocusedChannelChanges =
    options.subscribeFocusedChannelChanges ?? subscribeFocusedTerminalChannels;
  const subscribeForcedResend = options.subscribeForcedResend ?? onBrowserAuthenticated;
  const visibilityDebounceMs = options.visibilityDebounceMs ?? DEFAULT_VISIBILITY_DEBOUNCE_MS;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

  let disposed = false;
  let lastSentSelectedTaskId: string | null = null;
  let lastSentVisibleTaskIds: string[] = [];
  let lastSentFocusedChannelIds: string[] = [];
  let hasSent = false;
  let visibilityTimer: ReturnType<typeof setTimeout> | null = null;

  function clearVisibilityTimer(): void {
    if (visibilityTimer !== null) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
  }

  function sendCurrentFocus(): void {
    if (disposed) {
      return;
    }

    clearVisibilityTimer();
    const selectedTaskId = getSelectedTaskId();
    const visibleTaskIds = getVisibleTaskIds(selectedTaskId);
    const focusedChannelIds = getFocusedChannelIds();
    lastSentSelectedTaskId = selectedTaskId;
    lastSentVisibleTaskIds = visibleTaskIds;
    lastSentFocusedChannelIds = focusedChannelIds;
    hasSent = true;
    void Promise.resolve(sendFocus({ focusedChannelIds, selectedTaskId, visibleTaskIds })).catch(
      () => {},
    );
  }

  function scheduleVisibilitySend(): void {
    if (visibilityTimer !== null) {
      return;
    }

    visibilityTimer = setTimeout(() => {
      visibilityTimer = null;
      sendCurrentFocus();
    }, visibilityDebounceMs);
  }

  createReactiveEffect(() => {
    const selectedTaskId = getSelectedTaskId();
    const visibleTaskIds = getVisibleTaskIds(selectedTaskId);
    if (disposed) {
      return;
    }

    if (!hasSent) {
      // An empty focus signal carries no scheduling value; stay quiet until a
      // restored or user-driven selection produces real focus.
      if (selectedTaskId !== null || visibleTaskIds.length > 0) {
        sendCurrentFocus();
      }
      return;
    }

    if (selectedTaskId !== lastSentSelectedTaskId) {
      sendCurrentFocus();
      return;
    }

    if (!areStringArraysEqual(visibleTaskIds, lastSentVisibleTaskIds)) {
      scheduleVisibilitySend();
    }
  });

  const unsubscribeForcedResend = subscribeForcedResend(() => {
    if (hasSent) {
      sendCurrentFocus();
    }
  });

  // Focused-channel changes send leading-edge: switch-window echo priority
  // cannot wait behind the visibility debounce.
  const unsubscribeFocusedChannels = subscribeFocusedChannelChanges(() => {
    if (disposed || !hasSent) {
      return;
    }

    if (!areStringArraysEqual(getFocusedChannelIds(), lastSentFocusedChannelIds)) {
      sendCurrentFocus();
    }
  });

  const keepaliveTimer = setInterval(() => {
    if (hasSent) {
      sendCurrentFocus();
    }
  }, keepaliveIntervalMs);
  (keepaliveTimer as { unref?: () => void }).unref?.();

  return () => {
    disposed = true;
    clearVisibilityTimer();
    clearInterval(keepaliveTimer);
    unsubscribeFocusedChannels();
    unsubscribeForcedResend();
  };
}
