import {
  recordBrowserStartupModeCompleted,
  recordBrowserStartupModeCanceled,
  recordBrowserStartupModeStarted,
  recordBrowserStartupTierReached,
  type BrowserStartupCancelReason,
} from './runtime-diagnostics';

export type BrowserStartupMode = 'cold-bootstrap' | 'reconnect-restore';
export type BrowserStartupTier =
  | 'idle'
  | 'shell'
  | 'summary'
  | 'selected-task'
  | 'selected-terminal'
  | 'background';

interface BrowserStartupState {
  coldBootstrapPending: boolean;
  currentMode: BrowserStartupMode | null;
  modeStartedAtMs: number | null;
  tier: BrowserStartupTier;
}

const TIER_ORDER: Record<BrowserStartupTier, number> = {
  idle: 0,
  shell: 1,
  summary: 2,
  'selected-task': 3,
  'selected-terminal': 4,
  background: 5,
};

let browserStartupState: BrowserStartupState = {
  coldBootstrapPending: false,
  currentMode: null,
  modeStartedAtMs: null,
  tier: 'idle',
};

function getNow(): number {
  return Date.now();
}

function getCurrentModeElapsedMs(): number | null {
  if (browserStartupState.modeStartedAtMs === null) {
    return null;
  }

  return Math.max(0, getNow() - browserStartupState.modeStartedAtMs);
}

function setBrowserStartupMode(mode: BrowserStartupMode): void {
  browserStartupState = {
    ...browserStartupState,
    currentMode: mode,
    modeStartedAtMs: getNow(),
  };
  recordBrowserStartupModeStarted(mode);
}

function completeBrowserStartupMode(mode: BrowserStartupMode): void {
  if (browserStartupState.currentMode !== mode || browserStartupState.modeStartedAtMs === null) {
    return;
  }

  recordBrowserStartupModeCompleted(
    mode,
    Math.max(0, getNow() - browserStartupState.modeStartedAtMs),
  );
  browserStartupState = {
    ...browserStartupState,
    currentMode: null,
    modeStartedAtMs: null,
  };
}

function cancelBrowserStartupMode(reason: BrowserStartupCancelReason): void {
  if (browserStartupState.currentMode === null || browserStartupState.modeStartedAtMs === null) {
    return;
  }

  recordBrowserStartupModeCanceled(
    browserStartupState.currentMode,
    reason,
    Math.max(0, getNow() - browserStartupState.modeStartedAtMs),
  );
  browserStartupState = {
    ...browserStartupState,
    currentMode: null,
    modeStartedAtMs: null,
  };
}

export function beginBrowserColdBootstrap(): void {
  if (browserStartupState.currentMode === 'reconnect-restore') {
    return;
  }

  cancelBrowserStartupMode('replaced');
  browserStartupState = {
    coldBootstrapPending: true,
    currentMode: null,
    modeStartedAtMs: null,
    tier: 'idle',
  };
  setBrowserStartupMode('cold-bootstrap');
  setBrowserStartupTier('shell');
}

export function setBrowserStartupTier(tier: BrowserStartupTier): void {
  if (
    browserStartupState.currentMode !== 'cold-bootstrap' ||
    !browserStartupState.coldBootstrapPending
  ) {
    return;
  }

  if (TIER_ORDER[tier] < TIER_ORDER[browserStartupState.tier]) {
    return;
  }

  if (browserStartupState.tier === tier) {
    return;
  }

  browserStartupState = {
    ...browserStartupState,
    tier,
  };
  recordBrowserStartupTierReached(tier, getCurrentModeElapsedMs());
}

export function markBrowserStartupSelectedTerminalReady(): void {
  if (
    browserStartupState.currentMode !== 'cold-bootstrap' ||
    !browserStartupState.coldBootstrapPending
  ) {
    return;
  }

  setBrowserStartupTier('selected-terminal');
  completeBrowserColdBootstrap();
}

export function completeBrowserColdBootstrap(): void {
  if (
    browserStartupState.currentMode !== 'cold-bootstrap' ||
    !browserStartupState.coldBootstrapPending
  ) {
    return;
  }

  setBrowserStartupTier('background');
  completeBrowserStartupMode('cold-bootstrap');
  browserStartupState = {
    ...browserStartupState,
    coldBootstrapPending: false,
  };
}

export function beginBrowserReconnectRestore(): void {
  cancelBrowserStartupMode('replaced');
  browserStartupState = {
    ...browserStartupState,
    coldBootstrapPending: false,
  };
  setBrowserStartupMode('reconnect-restore');
}

export function completeBrowserReconnectRestore(): void {
  completeBrowserStartupMode('reconnect-restore');
}

export function cancelBrowserReconnectRestore(
  reason: Extract<
    BrowserStartupCancelReason,
    'auth-expired' | 'cleanup' | 'restore-failed' | 'transport-lost'
  >,
): void {
  if (browserStartupState.currentMode !== 'reconnect-restore') {
    return;
  }

  cancelBrowserStartupMode(reason);
}

export function resetBrowserStartupState(): void {
  cancelBrowserStartupMode('reset');
  browserStartupState = {
    coldBootstrapPending: false,
    currentMode: null,
    modeStartedAtMs: null,
    tier: 'idle',
  };
}

export function isBrowserColdBootstrapPending(): boolean {
  return browserStartupState.coldBootstrapPending;
}

export function getBrowserStartupState(): Readonly<BrowserStartupState> {
  return browserStartupState;
}

export function resetBrowserStartupStateForTests(): void {
  resetBrowserStartupState();
}
