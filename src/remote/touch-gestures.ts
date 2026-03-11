import type { Terminal } from '@xterm/xterm';

const SWIPE_EDGE_PX = 28;
const SWIPE_TRIGGER_PX = 72;

interface AttachAgentDetailTouchGesturesOptions {
  detailRoot: HTMLDivElement;
  termContainer: HTMLDivElement;
  getTerm: () => Terminal | undefined;
  showKillConfirm: () => boolean;
  agentMissing: () => boolean;
  swipeOffset: () => number;
  setSwipeOffset: (value: number) => void;
  onBack: () => void;
  onHaptic: () => void;
}

export function attachAgentDetailTouchGestures(
  options: AttachAgentDetailTouchGesturesOptions,
): () => void {
  const {
    detailRoot,
    termContainer,
    getTerm,
    showKillConfirm,
    agentMissing,
    swipeOffset,
    setSwipeOffset,
    onBack,
    onHaptic,
  } = options;

  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeTracking = false;
  let swipeConfirmed = false;
  let swipeShouldCancelTerminalScroll = false;
  let touchStartY = 0;
  let touchActive = false;

  function handleSwipeStart(event: TouchEvent): void {
    if (showKillConfirm() || agentMissing() || event.touches.length !== 1) return;

    const touch = event.touches[0];
    if (touch.clientX > SWIPE_EDGE_PX) return;

    swipeStartX = touch.clientX;
    swipeStartY = touch.clientY;
    swipeTracking = true;
    swipeConfirmed = false;
    swipeShouldCancelTerminalScroll = false;
  }

  function handleSwipeMove(event: TouchEvent): void {
    if (!swipeTracking || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - swipeStartX;
    const deltaY = touch.clientY - swipeStartY;

    if (!swipeConfirmed) {
      if (Math.abs(deltaY) > 16 && Math.abs(deltaY) > Math.max(deltaX, 0)) {
        swipeTracking = false;
        setSwipeOffset(0);
        return;
      }
      if (deltaX > 12 && deltaX > Math.abs(deltaY)) {
        swipeConfirmed = true;
        swipeShouldCancelTerminalScroll = true;
      }
    }

    if (!swipeConfirmed) return;

    const nextOffset = Math.max(0, Math.min(deltaX, 120));
    setSwipeOffset(nextOffset);
    event.preventDefault();
  }

  function handleSwipeEnd(): void {
    if (!swipeTracking) return;

    swipeTracking = false;
    swipeShouldCancelTerminalScroll = false;
    if (swipeConfirmed && swipeOffset() >= SWIPE_TRIGGER_PX) {
      onHaptic();
      onBack();
      return;
    }

    swipeConfirmed = false;
    setSwipeOffset(0);
  }

  function handleTerminalTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    touchStartY = event.touches[0].clientY;
    touchActive = true;
  }

  function handleTerminalTouchMove(event: TouchEvent): void {
    const term = getTerm();
    if (swipeShouldCancelTerminalScroll || !touchActive || !term || event.touches.length !== 1) {
      return;
    }

    const deltaY = touchStartY - event.touches[0].clientY;
    const lineHeight = term.options.fontSize ?? 13;
    const lines = Math.trunc(deltaY / lineHeight);
    if (lines !== 0) {
      term.scrollLines(lines);
      touchStartY = event.touches[0].clientY;
    }
    event.preventDefault();
  }

  function handleTerminalTouchEnd(): void {
    touchActive = false;
  }

  termContainer.addEventListener('touchstart', handleTerminalTouchStart, { passive: true });
  termContainer.addEventListener('touchmove', handleTerminalTouchMove, { passive: false });
  termContainer.addEventListener('touchend', handleTerminalTouchEnd, { passive: true });

  detailRoot.addEventListener('touchstart', handleSwipeStart, { capture: true, passive: true });
  detailRoot.addEventListener('touchmove', handleSwipeMove, { capture: true, passive: false });
  detailRoot.addEventListener('touchend', handleSwipeEnd, { capture: true, passive: true });
  detailRoot.addEventListener('touchcancel', handleSwipeEnd, { capture: true, passive: true });

  return () => {
    termContainer.removeEventListener('touchstart', handleTerminalTouchStart);
    termContainer.removeEventListener('touchmove', handleTerminalTouchMove);
    termContainer.removeEventListener('touchend', handleTerminalTouchEnd);
    detailRoot.removeEventListener('touchstart', handleSwipeStart, true);
    detailRoot.removeEventListener('touchmove', handleSwipeMove, true);
    detailRoot.removeEventListener('touchend', handleSwipeEnd, true);
    detailRoot.removeEventListener('touchcancel', handleSwipeEnd, true);
  };
}
