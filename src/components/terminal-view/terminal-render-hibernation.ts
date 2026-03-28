import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';

export interface CreateTerminalRenderHibernationOptions {
  getOutputPriority: () => TerminalOutputPriority;
  getRenderHibernationDelayMs: () => number | null;
  hasQueuedOutput: () => boolean;
  hasSuppressedOutputSinceHibernation: () => boolean;
  hasWriteInFlight: () => boolean;
  isDisposed: () => boolean;
  isRestoreBlocked: () => boolean;
  isSpawnFailed: () => boolean;
  isSpawnReady: () => boolean;
  onRenderHibernationChange?: (isHibernating: boolean) => void;
  onShouldKeepRenderLive?: () => boolean;
  restoreTerminalOutput: () => Promise<void>;
  scheduleOutputFlush: () => void;
}

type TerminalRenderHibernationState =
  | { kind: 'hibernating' }
  | { kind: 'live' }
  | { kind: 'waking' };

export interface TerminalRenderHibernationController {
  cleanup(): void;
  isHibernating(): boolean;
  isRecoveryVisible(): boolean;
  prewarm(): Promise<void>;
  sync(): void;
}

export function createTerminalRenderHibernationController(
  options: CreateTerminalRenderHibernationOptions,
): TerminalRenderHibernationController {
  let renderHibernationTimer: number | undefined;
  let renderHibernationState: TerminalRenderHibernationState = { kind: 'live' };

  function isHibernating(): boolean {
    return renderHibernationState.kind === 'hibernating';
  }

  function isRecoveryVisible(): boolean {
    return renderHibernationState.kind !== 'live';
  }

  function isWakeInFlight(): boolean {
    return renderHibernationState.kind === 'waking';
  }

  function setState(nextState: TerminalRenderHibernationState): void {
    if (renderHibernationState.kind === nextState.kind) {
      return;
    }

    renderHibernationState = nextState;
    options.onRenderHibernationChange?.(nextState.kind === 'hibernating');
  }

  function clearTimer(): void {
    if (renderHibernationTimer === undefined) {
      return;
    }

    window.clearTimeout(renderHibernationTimer);
    renderHibernationTimer = undefined;
  }

  function shouldAllowRenderHibernation(delayMs: number): boolean {
    return (
      delayMs >= 0 &&
      options.onShouldKeepRenderLive?.() !== true &&
      options.isSpawnReady() &&
      !options.isDisposed() &&
      !options.isSpawnFailed()
    );
  }

  function canEnterRenderHibernation(): boolean {
    return !options.isRestoreBlocked() && !options.hasWriteInFlight();
  }

  function enterRenderHibernation(): void {
    if (isHibernating()) {
      return;
    }

    setState({ kind: 'hibernating' });
  }

  function shouldWakeRenderHibernation(): boolean {
    if (!isHibernating() || isWakeInFlight()) {
      return false;
    }

    if (!options.hasSuppressedOutputSinceHibernation()) {
      setState({ kind: 'live' });
      return false;
    }

    return true;
  }

  function canPrewarmRenderHibernation(): boolean {
    return (
      isHibernating() &&
      !isWakeInFlight() &&
      options.getOutputPriority() === 'hidden' &&
      !options.isRestoreBlocked()
    );
  }

  function finishWake(): void {
    setState({ kind: 'live' });
    if (!options.isDisposed() && options.onShouldKeepRenderLive?.() === true) {
      if (options.hasQueuedOutput()) {
        options.scheduleOutputFlush();
      }
      return;
    }

    if (!options.isDisposed()) {
      sync();
    }
  }

  async function restore(): Promise<void> {
    setState({ kind: 'waking' });
    try {
      await options.restoreTerminalOutput();
    } finally {
      finishWake();
    }
  }

  async function wake(): Promise<void> {
    if (!shouldWakeRenderHibernation()) {
      return;
    }

    await restore();
  }

  function disableRenderHibernation(): void {
    clearTimer();
    if (isHibernating()) {
      void wake();
    }
  }

  function schedule(delayMs: number): void {
    renderHibernationTimer = window.setTimeout(() => {
      renderHibernationTimer = undefined;
      if (!shouldAllowRenderHibernation(delayMs) || !canEnterRenderHibernation()) {
        return;
      }

      enterRenderHibernation();
    }, delayMs);
  }

  function sync(): void {
    const delayMs = options.getRenderHibernationDelayMs();
    if (delayMs === null || !shouldAllowRenderHibernation(delayMs)) {
      disableRenderHibernation();
      return;
    }

    if (isHibernating() || renderHibernationTimer !== undefined) {
      return;
    }

    if (delayMs === 0) {
      if (canEnterRenderHibernation()) {
        enterRenderHibernation();
      }
      return;
    }

    schedule(delayMs);
  }

  async function prewarm(): Promise<void> {
    if (!canPrewarmRenderHibernation() || !options.hasSuppressedOutputSinceHibernation()) {
      return;
    }

    await restore();
  }

  function cleanup(): void {
    clearTimer();
    if (isHibernating()) {
      setState({ kind: 'live' });
    }
  }

  return {
    cleanup,
    isHibernating,
    isRecoveryVisible,
    prewarm,
    sync,
  };
}
