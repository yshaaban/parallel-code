import { IPC } from '../../electron/ipc/channels';
import {
  hasTrustExclusionKeywords,
  looksLikeTrustDialogInVisibleTail,
} from '../lib/prompt-detection';
import { invoke } from '../lib/ipc';
import { store } from './core';

const AUTO_TRUST_BG_THROTTLE_MS = 500;
const AUTO_TRUST_RENDER_DELAY_MS = 50;
const AUTO_TRUST_COOLDOWN_MS = 3_000;
const POST_AUTO_TRUST_SETTLE_MS = 1_000;

type AutoTrustCallbacks = {
  clearAgentReadyCallback(agentId: string): void;
  getVisibleTail(agentId: string): string;
  replaceTail(agentId: string, rawTail: string): void;
};

export type AutoTrustController = {
  clearState(agentId: string): void;
  hasScheduledSubmit(agentId: string): boolean;
  isSettling(agentId: string): boolean;
  maybeTryInBackground(agentId: string, now: number, isActiveTask: boolean): void;
  tryAutoTrust(agentId: string): boolean;
};

export function createAutoTrustController(callbacks: AutoTrustCallbacks): AutoTrustController {
  const autoTrustTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const autoTrustCooldowns = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAutoTrustCheckAt = new Map<string, number>();
  const autoTrustAcceptedAt = new Map<string, number>();

  function isPending(agentId: string): boolean {
    return autoTrustTimers.has(agentId) || autoTrustCooldowns.has(agentId);
  }

  function hasScheduledSubmit(agentId: string): boolean {
    return autoTrustTimers.has(agentId);
  }

  function isSettling(agentId: string): boolean {
    if (isPending(agentId)) return true;

    const acceptedAt = autoTrustAcceptedAt.get(agentId);
    if (!acceptedAt) return false;

    if (Date.now() - acceptedAt >= POST_AUTO_TRUST_SETTLE_MS) {
      autoTrustAcceptedAt.delete(agentId);
      return false;
    }

    return true;
  }

  function clearState(agentId: string): void {
    lastAutoTrustCheckAt.delete(agentId);
    autoTrustAcceptedAt.delete(agentId);

    const timer = autoTrustTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      autoTrustTimers.delete(agentId);
    }

    const cooldown = autoTrustCooldowns.get(agentId);
    if (cooldown) {
      clearTimeout(cooldown);
      autoTrustCooldowns.delete(agentId);
    }
  }

  function tryAutoTrust(agentId: string): boolean {
    if (!store.autoTrustFolders || isPending(agentId)) return false;

    const visibleTail = callbacks.getVisibleTail(agentId);
    if (!looksLikeTrustDialogInVisibleTail(visibleTail)) return false;
    if (hasTrustExclusionKeywords(visibleTail)) return false;

    const timer = setTimeout(() => {
      autoTrustTimers.delete(agentId);
      callbacks.replaceTail(agentId, '');
      callbacks.clearAgentReadyCallback(agentId);
      autoTrustAcceptedAt.set(agentId, Date.now());
      invoke(IPC.WriteToAgent, { agentId, data: '\r' }).catch(() => {});

      const cooldown = setTimeout(() => {
        autoTrustCooldowns.delete(agentId);
      }, AUTO_TRUST_COOLDOWN_MS);
      autoTrustCooldowns.set(agentId, cooldown);
    }, AUTO_TRUST_RENDER_DELAY_MS);

    autoTrustTimers.set(agentId, timer);
    return true;
  }

  function maybeTryInBackground(agentId: string, now: number, isActiveTask: boolean): void {
    if (!store.autoTrustFolders || isPending(agentId) || isActiveTask) return;

    const lastCheck = lastAutoTrustCheckAt.get(agentId) ?? 0;
    if (now - lastCheck < AUTO_TRUST_BG_THROTTLE_MS) return;

    lastAutoTrustCheckAt.set(agentId, now);
    tryAutoTrust(agentId);
  }

  return {
    clearState,
    hasScheduledSubmit,
    isSettling,
    maybeTryInBackground,
    tryAutoTrust,
  };
}
