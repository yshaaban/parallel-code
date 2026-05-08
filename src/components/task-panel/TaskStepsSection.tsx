import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { registerFocusFn, unregisterFocusFn } from '../../store/store';
import type {
  TaskStepEntry,
  TaskStepsSnapshot,
  TaskStepsSummarySnapshot,
} from '../../domain/task-steps';
import { sf } from '../../lib/fontScale';

interface TaskStepsSectionProps {
  loadError: Accessor<string | null>;
  loading: Accessor<boolean>;
  onFileClick: (filePath: string) => void;
  onFocusSteps: () => void;
  onJumpToStep: (step: TaskStepEntry) => void;
  onNaturalHeight?: (height: number) => void;
  onNextClick: (text: string) => void;
  snapshot: Accessor<TaskStepsSnapshot | null>;
  summary: Accessor<TaskStepsSummarySnapshot | null>;
  taskId: string;
}

const STATUS_COLORS: Record<TaskStepEntry['status'], string> = {
  starting: '#fb923c',
  investigating: '#60a5fa',
  implementing: '#c084fc',
  testing: '#e5a800',
  awaiting_review: '#f87171',
  done: theme.success,
};

function getStatusColor(status: TaskStepEntry['status']): string {
  return STATUS_COLORS[status] ?? theme.fgMuted;
}

function getRelativeTime(timestamp: string): string {
  const diffMs = Math.max(0, Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(diffMs)) {
    return '';
  }

  if (diffMs < 60_000) {
    return 'just now';
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function getTaskStepExpansionKey(step: TaskStepEntry): string {
  return JSON.stringify([step.timestamp, step.agentId ?? null, step.status, step.summary]);
}

function AgentBadge(props: { agentId: string }): JSX.Element {
  return (
    <span
      style={{
        'font-family': typography.monoMeta['font-family'],
        'font-size': sf(9),
        color: theme.fgSubtle,
        border: `1px dashed color-mix(in srgb, ${theme.fgSubtle} 45%, transparent)`,
        'border-radius': '999px',
        padding: '1px 6px',
        'max-width': '140px',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
        'flex-shrink': '0',
      }}
      title={props.agentId}
    >
      {props.agentId}
    </span>
  );
}

function FileBadge(props: { filePath: string; onClick: (filePath: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick(props.filePath);
      }}
      style={{
        background: `color-mix(in srgb, ${theme.fgMuted} 10%, transparent)`,
        border: `1px solid ${theme.border}`,
        'border-radius': '999px',
        color: theme.fgMuted,
        cursor: 'pointer',
        padding: '2px 7px',
        ...typography.monoMeta,
      }}
    >
      {props.filePath}
    </button>
  );
}

function StepCard(props: {
  expanded: boolean;
  onFileClick: (filePath: string) => void;
  onJumpToStep: (step: TaskStepEntry) => void;
  onNextClick: (text: string) => void;
  onToggle: () => void;
  step: TaskStepEntry;
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onToggle()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onToggle();
        }
      }}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        width: '100%',
        padding: '10px 12px',
        background: theme.taskPanelBg,
        border: `1px solid ${theme.border}`,
        'border-left': `3px solid ${getStatusColor(props.step.status)}`,
        'border-radius': '10px',
        cursor: 'pointer',
        'text-align': 'left',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
        <span
          style={{
            background: `color-mix(in srgb, ${getStatusColor(props.step.status)} 20%, transparent)`,
            color: getStatusColor(props.step.status),
            'border-radius': '999px',
            padding: '1px 8px',
            ...typography.metaStrong,
          }}
        >
          {props.step.status.replaceAll('_', ' ')}
        </span>
        <Show when={props.step.agentId}>
          <AgentBadge agentId={props.step.agentId ?? ''} />
        </Show>
        <span
          style={{
            color: theme.fgSubtle,
            'margin-left': 'auto',
            'flex-shrink': '0',
            ...typography.meta,
          }}
        >
          {getRelativeTime(props.step.timestamp)}
        </span>
      </div>

      <div style={{ color: theme.fg, ...typography.uiStrong }}>{props.step.summary}</div>

      <Show when={props.step.next}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onNextClick(props.step.next ?? '');
          }}
          style={{
            display: 'flex',
            'align-items': 'flex-start',
            gap: '6px',
            background: 'transparent',
            border: 'none',
            color: theme.accent,
            cursor: 'pointer',
            padding: '0',
            ...typography.ui,
          }}
        >
          <span style={{ opacity: '0.7' }}>›</span>
          <span style={{ 'font-style': 'italic', 'text-align': 'left' }}>{props.step.next}</span>
        </button>
      </Show>

      <Show when={props.expanded && props.step.detail}>
        <div style={{ color: theme.fgMuted, ...typography.ui }}>{props.step.detail}</div>
      </Show>

      <Show when={props.expanded && (props.step.filesTouched?.length ?? 0) > 0}>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
          <For each={props.step.filesTouched}>
            {(filePath) => <FileBadge filePath={filePath} onClick={props.onFileClick} />}
          </For>
        </div>
      </Show>

      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <span style={{ color: theme.fgSubtle, ...typography.meta }}>
          {props.expanded ? 'Hide details' : 'Show details'}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onJumpToStep(props.step);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgSubtle,
            cursor: 'pointer',
            ...typography.metaStrong,
          }}
        >
          Jump to terminal
        </button>
      </div>
    </div>
  );
}

export function TaskStepsSection(props: TaskStepsSectionProps): JSX.Element {
  const [expandedStepKeys, setExpandedStepKeys] = createSignal<Set<string>>(new Set());
  let scrollRef: HTMLDivElement | undefined;

  const steps = createMemo(() => props.snapshot()?.steps ?? []);
  const latestStep = createMemo(() => {
    const currentSteps = steps();
    return currentSteps[currentSteps.length - 1] ?? null;
  });
  const historySteps = createMemo(() => {
    const currentSteps = steps();
    return currentSteps.length > 1 ? currentSteps.slice(0, -1) : [];
  });
  const errorMessage = createMemo(() => {
    const summary = props.summary();
    if (summary?.state === 'error') {
      return summary.errorMessage ?? 'Failed to read task steps.';
    }

    return props.loadError();
  });
  const headerLabel = createMemo(() => {
    const summary = props.summary();
    if (props.loading()) {
      return 'Loading…';
    }
    if (errorMessage()) {
      return 'Steps unavailable';
    }
    if (!summary) {
      return 'Waiting for the first step';
    }
    switch (summary.state) {
      case 'error':
        return 'Steps unavailable';
      case 'waiting':
        return 'Waiting for the first step';
      case 'ready':
        return 'Waiting for next step';
      case 'done':
        return 'Done';
      case 'active':
        return 'Interacting';
    }
  });

  createEffect(() => {
    const focusKey = `${props.taskId}:steps`;
    registerFocusFn(focusKey, () => scrollRef?.focus());
    onCleanup(() => {
      unregisterFocusFn(focusKey);
    });
  });

  createEffect(() => {
    props.loading();
    headerLabel();
    props.snapshot();
    props.summary();
    expandedStepKeys();

    const element = scrollRef;
    const reportNaturalHeight = props.onNaturalHeight;
    if (!element || !reportNaturalHeight) {
      return;
    }

    queueMicrotask(() => {
      if (scrollRef !== element) {
        return;
      }

      const nextHeight = Math.max(72, Math.min(260, element.scrollHeight + 20));
      reportNaturalHeight(nextHeight);
    });
  });

  function toggleStepExpansion(stepKey: string): void {
    setExpandedStepKeys((previous) => {
      const next = new Set(previous);
      if (next.has(stepKey)) {
        next.delete(stepKey);
      } else {
        next.add(stepKey);
      }
      return next;
    });
  }

  return (
    <div
      class="focusable-panel"
      onClick={() => props.onFocusSteps()}
      style={{
        height: '100%',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.taskPanelBg,
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '8px 10px 6px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <span style={{ color: theme.fgSubtle, ...typography.label }}>Steps</span>
        <span style={{ color: theme.fgMuted, ...typography.meta }}>{headerLabel()}</span>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.altKey || !scrollRef) {
            return;
          }

          const pageDelta = scrollRef.clientHeight;
          switch (event.key) {
            case 'ArrowDown':
              event.preventDefault();
              scrollRef.scrollBy({ top: 60, behavior: 'smooth' });
              break;
            case 'ArrowUp':
              event.preventDefault();
              scrollRef.scrollBy({ top: -60, behavior: 'smooth' });
              break;
            case 'PageDown':
              event.preventDefault();
              scrollRef.scrollBy({ top: pageDelta, behavior: 'smooth' });
              break;
            case 'PageUp':
              event.preventDefault();
              scrollRef.scrollBy({ top: -pageDelta, behavior: 'smooth' });
              break;
          }
        }}
        style={{
          flex: '1',
          overflow: 'auto',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          padding: '10px',
          outline: 'none',
        }}
      >
        <Show when={errorMessage()}>
          {(message) => (
            <div
              role="status"
              aria-live="polite"
              style={{
                color: theme.error,
                background: `color-mix(in srgb, ${theme.error} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${theme.error} 35%, transparent)`,
                'border-radius': '10px',
                padding: '10px 12px',
                ...typography.ui,
              }}
            >
              {message()}
            </div>
          )}
        </Show>

        <Show when={!props.loading() && steps().length === 0 && !errorMessage()}>
          <div
            style={{
              color: theme.fgMuted,
              border: `1px dashed ${theme.border}`,
              'border-radius': '10px',
              padding: '12px',
              ...typography.ui,
            }}
          >
            Steps tracking is enabled. The agent has not written any step entries yet.
          </div>
        </Show>

        <For each={historySteps()}>
          {(step) => {
            const stepKey = getTaskStepExpansionKey(step);
            return (
              <StepCard
                expanded={expandedStepKeys().has(stepKey)}
                onFileClick={props.onFileClick}
                onJumpToStep={props.onJumpToStep}
                onNextClick={props.onNextClick}
                onToggle={() => toggleStepExpansion(stepKey)}
                step={step}
              />
            );
          }}
        </For>

        <Show when={latestStep()}>
          {(step) => (
            <StepCard
              expanded
              onFileClick={props.onFileClick}
              onJumpToStep={props.onJumpToStep}
              onNextClick={props.onNextClick}
              onToggle={() => {}}
              step={step()}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
