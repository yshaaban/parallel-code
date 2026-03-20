import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { markDirty } from '../lib/terminalFitManager';
import { setWebglAddonPriority, touchWebglAddon } from '../lib/webglPool';
import { theme } from '../lib/theme';
import { store } from '../store/store';
import { clearTerminalStartupEntry, setTerminalStartupPhase } from '../store/terminal-startup';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { createTaskControlVisualState } from './task-control-visual-state';
import { registerTerminalAttachCandidate } from '../app/terminal-attach-scheduler';
import { startTerminalSession } from './terminal-view/terminal-session';
import type { TerminalViewProps, TerminalViewStatus } from './terminal-view/types';
import {
  getTerminalOutputPriority,
  getTerminalWebglPriority,
} from '../lib/terminal-output-priority';

function isElementVisibleInViewport(element: Element): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function getRoundedPerformanceNow(): number {
  return Math.round(performance.now() * 100) / 100;
}

interface TerminalAttachTraceEntry {
  agentId: string;
  attachBoundAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  key: string;
  readyAtMs: number | null;
  status: TerminalViewStatus | 'queued';
  taskId: string;
}

declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntry>;
  }
}

function shouldRecordTerminalAttachTrace(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ !== undefined;
}

function ensureTerminalAttachTraceEntry(
  key: string,
  taskId: string,
  agentId: string,
): TerminalAttachTraceEntry | null {
  if (!shouldRecordTerminalAttachTrace()) {
    return null;
  }

  const traceStore = window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ?? {};
  const existingEntry = traceStore[key];
  if (existingEntry) {
    return existingEntry;
  }

  const nextEntry: TerminalAttachTraceEntry = {
    agentId,
    attachBoundAtMs: null,
    attachQueuedAtMs: getRoundedPerformanceNow(),
    attachStartedAtMs: null,
    key,
    readyAtMs: null,
    status: 'queued',
    taskId,
  };
  traceStore[key] = nextEntry;
  window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = traceStore;
  return nextEntry;
}

function updateTerminalAttachTrace(
  key: string,
  updater: (entry: TerminalAttachTraceEntry) => void,
): void {
  if (!shouldRecordTerminalAttachTrace()) {
    return;
  }

  const traceStore = window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
  const existingEntry = traceStore?.[key];
  if (!existingEntry) {
    return;
  }

  updater(existingEntry);
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  let shellRef!: HTMLDivElement;
  let containerRef!: HTMLDivElement;
  let session: ReturnType<typeof startTerminalSession> | undefined;
  let attachRegistration: ReturnType<typeof registerTerminalAttachCandidate> | undefined;
  const taskId = untrack(() => props.taskId);
  const agentId = untrack(() => props.agentId);
  const terminalStartupKey = `${taskId}:${agentId}`;
  const isInitiallyFocused = untrack(() => props.isFocused === true);
  const [sessionStatus, setSessionStatus] = createSignal<TerminalViewStatus>('binding');
  const [takingOver, setTakingOver] = createSignal(false);
  const [isVisible, setIsVisible] = createSignal(isInitiallyFocused);
  const attachPriority = createMemo(() => {
    if (props.isFocused === true) {
      return 0;
    }

    if (store.activeTaskId === props.taskId && isVisible()) {
      return 1;
    }

    if (isVisible()) {
      return 2;
    }

    return 3;
  });
  const outputPriority = createMemo(() =>
    getTerminalOutputPriority({
      isActiveTask: store.activeTaskId === props.taskId,
      isFocused: props.isFocused === true,
      isRestoring: sessionStatus() === 'restoring' || sessionStatus() === 'attaching',
      isVisible: isVisible(),
    }),
  );
  const controlVisualState = createTaskControlVisualState({
    fallbackAction: 'type in the terminal',
    isActive: () => props.isFocused === true,
    taskId,
  });

  async function handleTakeOver(): Promise<void> {
    if (!session || takingOver()) {
      return;
    }

    setTakingOver(true);
    try {
      const acquired = await session.requestInputTakeover();
      if (acquired) {
        session.term.focus();
      }
    } finally {
      setTakingOver(false);
    }
  }

  onMount(() => {
    let observer: IntersectionObserver | undefined;
    setIsVisible(isInitiallyFocused || isElementVisibleInViewport(shellRef));
    ensureTerminalAttachTraceEntry(terminalStartupKey, taskId, agentId);

    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          setIsVisible(entries.some((entry) => entry.isIntersecting));
        },
        { threshold: 0.1 },
      );
      observer.observe(shellRef);
    } else {
      setIsVisible(true);
    }

    attachRegistration = registerTerminalAttachCandidate({
      attach: () => {
        updateTerminalAttachTrace(terminalStartupKey, (entry) => {
          entry.attachStartedAtMs = getRoundedPerformanceNow();
          entry.status = 'binding';
        });
        session = startTerminalSession({
          containerRef,
          getOutputPriority: outputPriority,
          onAttachBound: () => {
            updateTerminalAttachTrace(terminalStartupKey, (entry) => {
              entry.attachBoundAtMs = getRoundedPerformanceNow();
            });
            attachRegistration?.release();
          },
          onReadOnlyInputAttempt: controlVisualState.expandBanner,
          onStatusChange: setSessionStatus,
          props,
        });
      },
      getPriority: attachPriority,
      key: terminalStartupKey,
      taskId,
    });

    onCleanup(() => {
      observer?.disconnect();
      attachRegistration?.unregister();
      attachRegistration = undefined;
      session?.cleanup();
      session = undefined;
    });
  });

  createEffect(() => {
    attachPriority();
    attachRegistration?.updatePriority();
  });

  createEffect(() => {
    outputPriority();
    session?.updateOutputPriority?.();
  });

  createEffect(() => {
    const status = sessionStatus();

    updateTerminalAttachTrace(terminalStartupKey, (entry) => {
      entry.status = status;
      if (status === 'ready' || status === 'error') {
        entry.readyAtMs = getRoundedPerformanceNow();
      }
    });

    switch (status) {
      case 'attaching':
        setTerminalStartupPhase(terminalStartupKey, 'attaching');
        return;
      case 'restoring':
        setTerminalStartupPhase(terminalStartupKey, 'restoring');
        return;
      case 'ready':
      case 'error':
        clearTerminalStartupEntry(terminalStartupKey);
        return;
      default:
        return;
    }
  });

  createEffect(() => {
    if (sessionStatus() === 'error') {
      attachRegistration?.release();
    }
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || size === null || !session) return;
    session.term.options.fontSize = size;
    markDirty(agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!session) return;
    session.term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(agentId);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!session) return;
    session.term.options.theme = getTerminalTheme(preset);
    markDirty(agentId);
  });

  createEffect(() => {
    if (!session) return;
    session.term.options.cursorBlink = props.isFocused === true;
    setWebglAddonPriority(agentId, getTerminalWebglPriority(outputPriority()));
    if (props.isFocused === true) {
      touchWebglAddon(agentId);
    }
  });

  const loadingLabel = createMemo(() => {
    switch (sessionStatus()) {
      case 'binding':
        return 'Connecting to terminal…';
      case 'attaching':
        return 'Attaching terminal…';
      case 'restoring':
        return 'Restoring terminal output…';
      default:
        return null;
    }
  });
  const hasPeerController = createMemo(() => Boolean(controlVisualState.status()));
  const readOnlyBorder = createMemo(() => theme.warning ?? '#d4a017');

  return (
    <div
      ref={shellRef}
      data-terminal-agent-id={props.agentId}
      data-terminal-status={sessionStatus()}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        'border-radius': '12px',
        'box-shadow':
          !loadingLabel() && hasPeerController()
            ? `inset 0 0 0 1px color-mix(in srgb, ${readOnlyBorder()} 60%, ${theme.border})`
            : undefined,
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          padding: '4px 0 0 4px',
          contain: 'strict',
        }}
      />
      <Show when={loadingLabel()}>
        {(label) => (
          <div
            style={{
              position: 'absolute',
              inset: '0',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              background: 'linear-gradient(180deg, rgba(12, 15, 20, 0.9), rgba(12, 15, 20, 0.72))',
              color: theme.fg,
              'pointer-events': 'none',
            }}
          >
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                padding: '10px 14px',
                background: 'color-mix(in srgb, var(--island-bg) 82%, transparent)',
                border: `1px solid ${theme.border}`,
                'border-radius': '12px',
                'box-shadow': '0 12px 30px rgba(0, 0, 0, 0.24)',
              }}
            >
              <span class="inline-spinner" aria-hidden="true" />
              <span style={{ 'font-size': '12px', color: theme.fgMuted }}>{label()}</span>
            </div>
          </div>
        )}
      </Show>
      <Show
        when={
          !loadingLabel() && !controlVisualState.isBannerVisible() && controlVisualState.status()
        }
      >
        {(status) => (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              'z-index': '11',
            }}
          >
            <TaskControlChip
              busy={takingOver()}
              label={status().label}
              onTakeOver={() => {
                void handleTakeOver();
              }}
              takeOverLabel="Take Over"
            />
          </div>
        )}
      </Show>
      <Show
        when={
          !loadingLabel() && controlVisualState.isBannerVisible() && controlVisualState.status()
        }
      >
        {(status) => (
          <TaskControlBanner
            busy={takingOver()}
            message={status().message}
            onDismiss={controlVisualState.dismissBanner}
            onTakeOver={() => {
              void handleTakeOver();
            }}
            style={{
              position: 'absolute',
              top: '8px',
              left: '8px',
              right: '8px',
              'z-index': '12',
              background: 'color-mix(in srgb, var(--island-bg) 88%, rgba(18, 22, 28, 0.18))',
            }}
          />
        )}
      </Show>
    </div>
  );
}

export type { TerminalViewProps } from './terminal-view/types';
