import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from 'solid-js';
import type { RemoteAgent } from '../../electron/remote/protocol';
import { typography } from '../lib/typography';
import {
  getRemotePrimaryPreviewPort,
  getRemoteAgentViewTransitionName,
  deriveRemoteAgentPreview,
  formatRemoteLastPrompt,
  formatRemoteTaskContext,
  getRemoteAgentListStatePresentation,
  summarizeRemoteTaskReview,
  isRemoteCurrentBranchTask,
  shouldShowRemoteAgentPreview,
} from './agent-presentation';
import { RemoteAgentGlyph } from './RemoteAgentGlyph';
import {
  getRemoteTaskControllerOwnerStatus,
  getRemoteTaskPresenceOwnerStatus,
} from './remote-collaboration';
import {
  getRemoteAgentSupervision,
  getRemoteTaskPorts,
  getRemoteTaskReview,
} from './remote-task-state';
import {
  getConnectionBadgeLabel,
  getConnectionBannerText,
  getConnectionBannerTone,
  getConnectionTone,
  shouldShowConnectionSkeleton,
} from './status-helpers';
import { agents, getAgentPreview, status } from './ws';

interface AgentListProps {
  onEditSessionName: () => void;
  onSelect: (agentId: string, taskName: string) => void;
  sessionName: string;
}

interface AgentCardProps {
  agent: RemoteAgent;
  cardState: () => DerivedAgentCardState;
  index: number;
  onSelect: (agentId: string, taskName: string) => void;
}

type AgentMetaChipTone = 'accent' | 'danger' | 'neutral' | 'warning';

interface AgentMetaChip {
  label: string;
  tone: AgentMetaChipTone;
}

interface AgentHeaderChip {
  label: string;
  tone: 'accent' | 'danger' | 'muted' | 'success' | 'warning';
}

interface AgentListCounts {
  blocked: number;
  busy: number;
  done: number;
  failed: number;
  paused: number;
  protected: number;
  quiet: number;
  ready: number;
  syncing: number;
  total: number;
  waiting: number;
}

interface DerivedAgentCardState {
  cardLabel: string;
  contextLine: string | null;
  defaultPreview: string;
  metaChips: AgentMetaChip[];
  presentation: ReturnType<typeof getRemoteAgentListStatePresentation>;
  promptLine: string | null;
  supervisionPreview: string | null;
}

interface DerivedAgentListState {
  ownerBlocked: boolean;
  presentation: ReturnType<typeof getRemoteAgentListStatePresentation>;
}

interface DerivedAgentEntry extends DerivedAgentListState {
  agent: RemoteAgent;
  cardState: DerivedAgentCardState;
  sortOrder: number;
}

interface DerivedAgentListModel {
  cardStatesByAgentId: Map<string, DerivedAgentCardState>;
  counts: AgentListCounts;
  orderedAgents: RemoteAgent[];
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getHeaderChipStyle(tone: 'accent' | 'danger' | 'muted' | 'success' | 'warning'): {
  color: string;
} {
  switch (tone) {
    case 'success':
      return { color: 'var(--success)' };
    case 'warning':
      return { color: 'var(--warning)' };
    case 'danger':
      return { color: 'var(--danger)' };
    case 'accent':
      return { color: 'var(--accent)' };
    default:
      return { color: 'var(--text-secondary)' };
  }
}

function getMetaChipStyle(tone: AgentMetaChipTone): {
  background: string;
  border: string;
  color: string;
} {
  switch (tone) {
    case 'warning':
      return {
        background: 'rgba(255, 197, 105, 0.08)',
        border: '1px solid rgba(255, 197, 105, 0.18)',
        color: 'var(--warning)',
      };
    case 'danger':
      return {
        background: 'rgba(255, 95, 115, 0.08)',
        border: '1px solid rgba(255, 95, 115, 0.2)',
        color: 'var(--danger)',
      };
    case 'accent':
      return {
        background: 'rgba(46, 200, 255, 0.08)',
        border: '1px solid rgba(46, 200, 255, 0.18)',
        color: 'var(--accent)',
      };
    case 'neutral':
      return {
        background: 'rgba(16, 23, 31, 0.9)',
        border: '1px solid rgba(61, 92, 119, 0.18)',
        color: 'var(--text-secondary)',
      };
  }
}

function getConnectionIndicatorColor(tone: 'danger' | 'success' | 'warning'): string {
  switch (tone) {
    case 'success':
      return 'var(--success)';
    case 'warning':
      return 'var(--warning)';
    case 'danger':
      return 'var(--danger)';
  }
}

function getAgentTaskContext(agent: RemoteAgent): string | null {
  return formatRemoteTaskContext(
    agent.taskMeta?.branchName ?? null,
    agent.taskMeta?.folderName ?? null,
    isRemoteCurrentBranchTask(agent.taskMeta),
    agent.taskMeta?.worktreeOwnership ?? null,
    agent.taskMeta?.projectMode ?? null,
  );
}

function getLoadingSkeletonWidth(row: number): string {
  return row === 1 ? '62%' : '74%';
}

function deriveAgentListState(
  agent: RemoteAgent,
  supervision: ReturnType<typeof getRemoteAgentSupervision>,
  controllerOwnerStatus: ReturnType<typeof getRemoteTaskControllerOwnerStatus>,
): DerivedAgentListState {
  const presentation = getRemoteAgentListStatePresentation(
    agent.status,
    agent.exitCode,
    supervision,
  );
  return {
    ownerBlocked: Boolean(controllerOwnerStatus && !controllerOwnerStatus.isSelf),
    presentation,
  };
}

function deriveAgentCardState(
  agent: RemoteAgent,
  options: {
    controllerOwnerStatus: ReturnType<typeof getRemoteTaskControllerOwnerStatus>;
    presenceOwnerStatus: ReturnType<typeof getRemoteTaskPresenceOwnerStatus>;
    presentation: ReturnType<typeof getRemoteAgentListStatePresentation>;
    supervision: ReturnType<typeof getRemoteAgentSupervision>;
  },
): DerivedAgentCardState {
  const { controllerOwnerStatus, presenceOwnerStatus, presentation, supervision } = options;
  const contextLine = getAgentTaskContext(agent);
  const promptLine = formatRemoteLastPrompt(agent.taskMeta?.lastPrompt ?? null);
  const metaChips = buildAgentMetaChips(agent, {
    controllerOwnerStatus,
    presenceOwnerStatus,
  });
  const supervisionPreview = supervision?.preview?.trim() ?? null;

  const cardLabel = [
    `Open ${agent.taskName}`,
    presentation.badgeLabel,
    contextLine,
    ...metaChips.map((chip) => chip.label),
  ]
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    .join('. ');

  return {
    cardLabel,
    contextLine,
    defaultPreview: deriveRemoteAgentPreview(agent.lastLine, agent.status),
    metaChips,
    presentation,
    promptLine,
    supervisionPreview,
  };
}

function deriveAgentCardPreviewLine(
  agent: RemoteAgent,
  cardState: DerivedAgentCardState,
  livePreview: string,
): string | null {
  let preview = cardState.defaultPreview;
  if (livePreview.length > 0) {
    preview = livePreview;
  }
  if (cardState.supervisionPreview) {
    preview = cardState.supervisionPreview;
  }

  if (shouldShowRemoteAgentPreview(preview, agent.status)) {
    return preview;
  }
  if (!cardState.contextLine && cardState.promptLine) {
    return cardState.promptLine;
  }

  return null;
}

function deriveAgentEntry(agent: RemoteAgent): DerivedAgentEntry {
  const supervision = getRemoteAgentSupervision(agent.agentId);
  const controllerOwnerStatus = getRemoteTaskControllerOwnerStatus(agent.taskId);
  const presenceOwnerStatus = getRemoteTaskPresenceOwnerStatus(agent.taskId);
  const listState = deriveAgentListState(agent, supervision, controllerOwnerStatus);
  const cardState = deriveAgentCardState(agent, {
    controllerOwnerStatus,
    presenceOwnerStatus,
    presentation: listState.presentation,
    supervision,
  });

  return {
    agent,
    cardState,
    ownerBlocked: listState.ownerBlocked,
    presentation: listState.presentation,
    sortOrder: listState.presentation.sortOrder * 10 + (listState.ownerBlocked ? 1 : 0),
  };
}

function sortAgentEntries(entries: DerivedAgentEntry[]): DerivedAgentEntry[] {
  return entries.sort((left, right) => {
    const sortDelta = left.sortOrder - right.sortOrder;
    if (sortDelta !== 0) {
      return sortDelta;
    }

    const taskNameDelta = left.agent.taskName.localeCompare(right.agent.taskName);
    if (taskNameDelta !== 0) {
      return taskNameDelta;
    }

    return left.agent.agentId.localeCompare(right.agent.agentId);
  });
}

function getListCounts(entries: ReadonlyArray<DerivedAgentEntry>): AgentListCounts {
  const counts: AgentListCounts = {
    blocked: 0,
    busy: 0,
    done: 0,
    failed: 0,
    paused: 0,
    protected: 0,
    quiet: 0,
    ready: 0,
    syncing: 0,
    total: entries.length,
    waiting: 0,
  };

  for (const entry of entries) {
    counts[entry.presentation.key] += 1;

    if (entry.ownerBlocked) {
      counts.blocked += 1;
    }
  }

  return counts;
}

function deriveAgentListModel(remoteAgents: RemoteAgent[]): DerivedAgentListModel {
  const entries = sortAgentEntries(remoteAgents.map(deriveAgentEntry));

  return {
    cardStatesByAgentId: new Map(entries.map((entry) => [entry.agent.agentId, entry.cardState])),
    counts: getListCounts(entries),
    orderedAgents: entries.map((entry) => entry.agent),
  };
}

function getAgentCardState(model: DerivedAgentListModel, agentId: string): DerivedAgentCardState {
  const cardState = model.cardStatesByAgentId.get(agentId);
  if (!cardState) {
    throw new Error(`Missing remote agent card state for ${agentId}`);
  }

  return cardState;
}

function buildAgentMetaChips(
  agent: RemoteAgent,
  ownerStatuses?: {
    controllerOwnerStatus: ReturnType<typeof getRemoteTaskControllerOwnerStatus>;
    presenceOwnerStatus: ReturnType<typeof getRemoteTaskPresenceOwnerStatus>;
  },
): AgentMetaChip[] {
  const chips: AgentMetaChip[] = [];
  const controllerOwnerStatus = ownerStatuses
    ? ownerStatuses.controllerOwnerStatus
    : getRemoteTaskControllerOwnerStatus(agent.taskId);
  const presenceOwnerStatus = ownerStatuses
    ? ownerStatuses.presenceOwnerStatus
    : getRemoteTaskPresenceOwnerStatus(agent.taskId);

  if (controllerOwnerStatus && !controllerOwnerStatus.isSelf) {
    chips.push({
      label: controllerOwnerStatus.label,
      tone: 'warning',
    });
  } else if (presenceOwnerStatus && !presenceOwnerStatus.isSelf) {
    chips.push({
      label: `Presence: ${presenceOwnerStatus.label}`,
      tone: 'neutral',
    });
  }

  const reviewSummary = summarizeRemoteTaskReview(getRemoteTaskReview(agent.taskId));
  if (reviewSummary) {
    if (reviewSummary.source === 'unavailable') {
      chips.push({ label: 'Diff unavailable', tone: 'warning' });
    } else {
      if (reviewSummary.source === 'branch-fallback') {
        chips.push({ label: 'Branch diff', tone: 'accent' });
      }
      if (reviewSummary.conflictCount > 0) {
        chips.push({
          label: formatCountLabel(reviewSummary.conflictCount, 'conflict'),
          tone: 'danger',
        });
      }
      if (reviewSummary.fileCount > 0) {
        chips.push({
          label: formatCountLabel(reviewSummary.fileCount, 'file'),
          tone: 'neutral',
        });
      }
    }
  }

  const previewPort = getRemotePrimaryPreviewPort(getRemoteTaskPorts(agent.taskId));
  if (previewPort) {
    chips.push({
      label: `Port ${previewPort.port}`,
      tone: 'accent',
    });
  }

  return chips;
}

function getAgentHeaderChips(counts: AgentListCounts): AgentHeaderChip[] {
  const chips: AgentHeaderChip[] = [
    {
      label: formatCountLabel(counts.total, 'agent'),
      tone: 'muted',
    },
  ];

  if (counts.waiting > 0) {
    chips.push({
      label: formatCountLabel(counts.waiting, 'waiting agent', 'waiting agents'),
      tone: 'warning',
    });
  }
  if (counts.ready > 0) {
    chips.push({
      label: formatCountLabel(counts.ready, 'ready agent', 'ready agents'),
      tone: 'success',
    });
  }
  if (counts.quiet > 0) {
    chips.push({
      label: formatCountLabel(counts.quiet, 'quiet agent', 'quiet agents'),
      tone: 'muted',
    });
  }
  if (counts.blocked > 0) {
    chips.push({
      label: formatCountLabel(counts.blocked, 'blocked agent', 'blocked agents'),
      tone: 'warning',
    });
  }
  if (counts.failed > 0) {
    chips.push({
      label: formatCountLabel(counts.failed, 'failed agent', 'failed agents'),
      tone: 'danger',
    });
  }
  if (counts.busy > 0) {
    chips.push({
      label: formatCountLabel(counts.busy, 'busy agent', 'busy agents'),
      tone: 'accent',
    });
  }

  return chips;
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'grid',
        gap: 'var(--space-sm)',
      }}
    >
      <For each={[0, 1, 2]}>
        {(row) => (
          <div
            class="remote-panel remote-panel--soft"
            style={{
              padding: 'var(--space-md)',
              'border-radius': '1rem',
              display: 'grid',
              gap: 'var(--space-xs)',
              animation: `cardIn 0.28s ease-out ${row * 0.05}s both`,
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: 'var(--space-sm)' }}>
              <div
                class="skeleton-block"
                style={{
                  width: '24px',
                  height: '24px',
                  'border-radius': '0.65rem',
                  'flex-shrink': '0',
                }}
              />
              <div
                style={{
                  flex: '1',
                  display: 'grid',
                  gap: 'var(--space-xs)',
                }}
              >
                <div
                  class="skeleton-block"
                  style={{
                    width: getLoadingSkeletonWidth(row),
                    height: '13px',
                    'border-radius': '999px',
                  }}
                />
                <div
                  class="skeleton-block"
                  style={{
                    width: row === 0 ? '48%' : '40%',
                    height: '10px',
                    'border-radius': '999px',
                    opacity: '0.75',
                  }}
                />
              </div>
              <div
                class="skeleton-block"
                style={{
                  width: '56px',
                  height: '24px',
                  'border-radius': '999px',
                  'flex-shrink': '0',
                }}
              />
            </div>
            <div
              class="skeleton-block"
              style={{
                width: row === 0 ? '84%' : '72%',
                height: '10px',
                'border-radius': '999px',
              }}
            />
          </div>
        )}
      </For>
    </div>
  );
}

function ConnectedEmptyState(): JSX.Element {
  return (
    <div
      class="remote-panel"
      style={{
        padding: 'var(--space-2xl) var(--space-lg)',
        'text-align': 'center',
        animation: 'fadeIn 0.35s ease-out',
        display: 'grid',
        gap: 'var(--space-sm)',
        'justify-items': 'center',
        'border-radius': '1.35rem',
      }}
    >
      <div
        class="empty-state-pulse"
        style={{
          width: '56px',
          height: '56px',
          'border-radius': '1rem',
          background: 'rgba(46, 200, 255, 0.08)',
          border: '1px solid rgba(46, 200, 255, 0.16)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path
            d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
            stroke="var(--accent)"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-2xs)', 'justify-items': 'center' }}>
        <p style={{ color: 'var(--text-primary)', ...typography.title }}>No active agents</p>
        <p
          style={{
            color: 'var(--text-muted)',
            'max-width': '18rem',
            ...typography.ui,
          }}
        >
          Start an agent on desktop to control it here.
        </p>
      </div>
    </div>
  );
}

function AgentCard(props: AgentCardProps): JSX.Element {
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const cardState = createMemo(() => props.cardState());
  const livePreview = createMemo(() => getAgentPreview(props.agent.agentId));
  const previewLine = createMemo(() =>
    deriveAgentCardPreviewLine(props.agent, cardState(), livePreview()),
  );

  createEffect(
    on(
      () => cardState().presentation.key,
      (next, prev) => {
        if (prev && prev !== next) {
          setStatusFlashClass((current) =>
            current === 'status-flash-a' ? 'status-flash-b' : 'status-flash-a',
          );
        }
      },
    ),
  );

  return (
    <button
      type="button"
      class="card-btn tap-feedback remote-panel remote-agent-card"
      aria-label={`${cardState().cardLabel}${previewLine() ? `. ${previewLine()}` : ''}.`}
      onClick={() => props.onSelect(props.agent.agentId, props.agent.taskName)}
      style={{
        width: '100%',
        position: 'relative',
        overflow: 'hidden',
        'border-radius': '1.05rem',
        padding: 'var(--space-md)',
        cursor: 'pointer',
        display: 'grid',
        gap: 'var(--space-xs)',
        'text-align': 'left',
        'touch-action': 'manipulation',
        animation: `cardIn 0.3s ease-out ${props.index * 0.05}s both`,
        'view-transition-name': getRemoteAgentViewTransitionName(props.agent.agentId),
      }}
    >
      <div
        class="remote-agent-card__head"
        style={{
          display: 'flex',
          'align-items': 'flex-start',
          gap: 'var(--space-sm)',
        }}
      >
        <RemoteAgentGlyph
          agentDefId={props.agent.taskMeta?.agentDefId ?? null}
          agentDefName={props.agent.taskMeta?.agentDefName ?? null}
          class={`remote-agent-card__glyph status-indicator ${statusFlashClass()}`}
          size={40}
          variant="card"
        />

        <div style={{ flex: '1', display: 'grid', gap: '0.35rem', 'min-width': '0' }}>
          <div
            style={{
              display: 'flex',
              'align-items': 'flex-start',
              'justify-content': 'space-between',
              gap: 'var(--space-sm)',
            }}
          >
            <div style={{ display: 'grid', gap: '0.12rem', 'min-width': '0' }}>
              <span
                style={{
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                  ...typography.uiStrong,
                }}
              >
                {props.agent.taskName}
              </span>
              <Show when={cardState().contextLine}>
                <span class="remote-agent-card__context" style={{ ...typography.metaStrong }}>
                  {cardState().contextLine}
                </span>
              </Show>
            </div>
            <span
              class="remote-agent-card__status"
              style={{
                padding: '0.35rem 0.65rem',
                'border-radius': '999px',
                background: cardState().presentation.badgeBackground,
                border: `1px solid ${cardState().presentation.badgeBorder}`,
                color: cardState().presentation.accent,
                'flex-shrink': '0',
                ...typography.label,
              }}
            >
              {cardState().presentation.badgeLabel}
            </span>
          </div>

          <div class="remote-agent-card__meta">
            <For each={cardState().metaChips}>
              {(chip) => (
                <span
                  class="remote-agent-meta-chip"
                  style={{
                    ...getMetaChipStyle(chip.tone),
                    ...typography.metaStrong,
                  }}
                >
                  {chip.label}
                </span>
              )}
            </For>
          </div>
        </div>
      </div>

      <Show when={previewLine()}>
        <p class="remote-agent-card__preview" style={{ ...typography.meta }}>
          {previewLine()}
        </p>
      </Show>

      <div
        class="remote-card-signal"
        style={{
          background: `linear-gradient(90deg, ${cardState().presentation.accent} 0%, transparent 100%)`,
        }}
      />
    </button>
  );
}

export function AgentList(props: AgentListProps): JSX.Element {
  const [showTopFade, setShowTopFade] = createSignal(false);
  const agentListModel = createMemo(() => deriveAgentListModel(agents()));
  const counts = createMemo(() => agentListModel().counts);
  const headerChips = createMemo(() => getAgentHeaderChips(counts()));
  const connectionTone = createMemo(() => getConnectionTone(status()));
  const showSkeleton = createMemo(
    () => counts().total === 0 && shouldShowConnectionSkeleton(status()),
  );
  const connectionBannerText = createMemo(() => getConnectionBannerText(status()));
  const connectionBannerTone = createMemo(() => getConnectionBannerTone(status()));
  const connectionBadgeLabel = createMemo(() => getConnectionBadgeLabel(status()));

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        padding: 'var(--space-md)',
        gap: 'var(--space-md)',
      }}
    >
      <div
        class="remote-panel"
        style={{
          padding: 'var(--space-md)',
          'border-radius': '1.2rem',
          display: 'grid',
          gap: 'var(--space-sm)',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'flex-start',
            'justify-content': 'space-between',
            gap: 'var(--space-sm)',
          }}
        >
          <div style={{ display: 'grid', gap: 'var(--space-xs)', 'min-width': '0' }}>
            <button
              type="button"
              class="surface-btn tap-feedback"
              aria-label="Edit mobile session name"
              onClick={() => props.onEditSessionName()}
              style={{
                background: 'none',
                border: 'none',
                padding: '0',
                cursor: 'pointer',
                'min-width': '0',
                display: 'grid',
                gap: '0.25rem',
                'text-align': 'left',
              }}
            >
              <span
                style={{
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                  ...typography.title,
                }}
              >
                {props.sessionName}
              </span>
            </button>
          </div>

          <div
            role="status"
            aria-live="polite"
            aria-label={`Connection ${status()}, ${counts().total} agents.`}
            class="remote-chip"
            style={{
              color: connectionTone() === 'danger' ? 'var(--danger)' : 'var(--text-primary)',
              'flex-shrink': '0',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '0.5rem',
                height: '0.5rem',
                'border-radius': '50%',
                background: getConnectionIndicatorColor(connectionTone()),
                'box-shadow': `0 0 10px ${getConnectionIndicatorColor(connectionTone())}`,
              }}
            />
            <span style={typography.metaStrong}>{connectionBadgeLabel()}</span>
          </div>
        </div>

        <div class="remote-chip-row remote-chip-scroll">
          <For each={headerChips()}>
            {(chip) => (
              <span class="remote-chip" style={getHeaderChipStyle(chip.tone)}>
                <span style={typography.metaStrong}>{chip.label}</span>
              </span>
            )}
          </For>
        </div>

        <Show when={connectionBannerText()}>
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: '0.8rem 0.95rem',
              'border-radius': '1rem',
              background: connectionBannerTone().background,
              color: connectionBannerTone().color,
              ...typography.metaStrong,
            }}
          >
            {connectionBannerText()}
          </div>
        </Show>
      </div>

      <div
        class="remote-scroll-shell"
        onScroll={(event) => setShowTopFade(event.currentTarget.scrollTop > 8)}
      >
        <div
          style={{
            position: 'sticky',
            top: '0',
            height: showTopFade() ? '1.2rem' : '0',
            'margin-bottom': showTopFade() ? '-1.2rem' : '0',
            background:
              'linear-gradient(180deg, rgba(8, 12, 18, 0.94) 0%, rgba(8, 12, 18, 0) 100%)',
            'pointer-events': 'none',
            'z-index': '5',
            transition: 'height 0.18s ease, margin-bottom 0.18s ease',
          }}
        />

        <div
          style={{
            display: 'grid',
            gap: 'var(--space-sm)',
            padding: '0 var(--space-2xs) var(--space-xl)',
          }}
        >
          <Show when={!showSkeleton()} fallback={<LoadingSkeleton />}>
            <Show when={counts().total > 0} fallback={<ConnectedEmptyState />}>
              <For each={agentListModel().orderedAgents}>
                {(agent, index) => (
                  <AgentCard
                    agent={agent}
                    cardState={() => getAgentCardState(agentListModel(), agent.agentId)}
                    index={index()}
                    onSelect={props.onSelect}
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
