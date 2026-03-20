import { For, Show, createMemo, type JSX } from 'solid-js';
import type { PeerPresenceSnapshot } from '../domain/server-state';
import { isElectronRuntime } from '../lib/browser-auth';
import { APP_BUILD_STAMP, APP_VERSION } from '../lib/build-info';
import { sf } from '../lib/fontScale';
import { alt, mod } from '../lib/platform';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { theme } from '../lib/theme';
import {
  getCompletedTasksTodayCount,
  getMergedLineTotals,
  listPeerSessions,
  toggleArena,
  toggleHelpDialog,
} from '../store/store';
import { isSidebarSectionCollapsed, toggleSidebarSection } from '../store/sidebar-sections';
import { SidebarSectionHeader } from './sidebar/SidebarSectionHeader';

const MAX_VISIBLE_SESSION_CHIPS = 3;
const MAX_COLLAPSED_SESSION_PREVIEW_CHIPS = 2;

interface SidebarSessionSummary {
  hiddenCount: number;
  overflowCount: number;
  sessions: PeerPresenceSnapshot[];
  totalCount: number;
  visibleCount: number;
}

interface SidebarSessionPreviewItem {
  label: string;
  statusColor: string;
}

interface SidebarSessionPreviewSummary {
  items: SidebarSessionPreviewItem[];
  overflowCount: number;
}

function getSessionPriority(session: PeerPresenceSnapshot, runtimeClientId: string): number {
  const isSelf = session.clientId === runtimeClientId;
  const visibilityScore = session.visibility === 'visible' ? 3 : 0;
  const controlScore = session.controllingAgentIds.length + session.controllingTaskIds.length;
  const activeTaskScore = session.activeTaskId ? 1 : 0;
  const selfPenalty = isSelf ? -1 : 0;
  return visibilityScore + controlScore + activeTaskScore + selfPenalty;
}

function comparePeerSessions(
  left: PeerPresenceSnapshot,
  right: PeerPresenceSnapshot,
  runtimeClientId: string,
): number {
  const priorityDifference =
    getSessionPriority(right, runtimeClientId) - getSessionPriority(left, runtimeClientId);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const recencyDifference = right.lastSeenAt - left.lastSeenAt;
  if (recencyDifference !== 0) {
    return recencyDifference;
  }

  return left.displayName.localeCompare(right.displayName);
}

function summarizePeerSessions(
  sessions: ReadonlyArray<PeerPresenceSnapshot>,
  runtimeClientId: string,
): SidebarSessionSummary {
  const sortedSessions = [...sessions].sort((left, right) =>
    comparePeerSessions(left, right, runtimeClientId),
  );
  const visibleCount = sortedSessions.filter((session) => session.visibility === 'visible').length;
  const hiddenCount = sortedSessions.length - visibleCount;

  return {
    hiddenCount,
    overflowCount: Math.max(0, sortedSessions.length - MAX_VISIBLE_SESSION_CHIPS),
    sessions: sortedSessions.slice(0, MAX_VISIBLE_SESSION_CHIPS),
    totalCount: sortedSessions.length,
    visibleCount,
  };
}

function getSessionChipLabel(session: PeerPresenceSnapshot, runtimeClientId: string): string {
  if (session.clientId === runtimeClientId) {
    return `${session.displayName} (you)`;
  }

  return session.displayName;
}

function getSessionIndicatorColor(session: PeerPresenceSnapshot): string {
  if (session.visibility === 'hidden') {
    return theme.fgSubtle;
  }

  return theme.success;
}

function formatSessionSummaryText(summary: SidebarSessionSummary): string | null {
  const parts: string[] = [];

  if (summary.visibleCount > 0) {
    parts.push(`${summary.visibleCount} online`);
  }
  if (summary.hiddenCount > 0) {
    parts.push(`${summary.hiddenCount} hidden`);
  }
  if (summary.overflowCount > 0) {
    const sessionSuffix = summary.overflowCount === 1 ? '' : 's';
    parts.push(`+${summary.overflowCount} more recent session${sessionSuffix}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' · ');
}

function summarizeCollapsedSessionPreview(
  summary: SidebarSessionSummary,
  runtimeClientId: string,
): SidebarSessionPreviewSummary {
  const items = summary.sessions.slice(0, MAX_COLLAPSED_SESSION_PREVIEW_CHIPS).map((session) => ({
    label: getSessionChipLabel(session, runtimeClientId),
    statusColor: getSessionIndicatorColor(session),
  }));

  return {
    items,
    overflowCount: Math.max(0, summary.totalCount - items.length),
  };
}

interface SessionChipProps {
  label: string;
  statusColor: string;
}

function SessionChip(props: SessionChipProps): JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '7px',
        'max-width': '100%',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
        'border-radius': '999px',
        padding: '5px 9px',
        'font-size': sf(11),
      }}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          'border-radius': '999px',
          background: props.statusColor,
          'flex-shrink': '0',
        }}
      />
      <span
        style={{
          color: theme.fg,
          'font-weight': '600',
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
        }}
      >
        {props.label}
      </span>
    </div>
  );
}

export function SidebarFooter(): JSX.Element {
  const runtimeClientId = getRuntimeClientId();
  const electronRuntime = isElectronRuntime();
  const completedTasksToday = createMemo(() => getCompletedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());
  const peerSessions = createMemo(() => listPeerSessions());
  const hasOtherSessions = createMemo(() =>
    peerSessions().some((session) => session.clientId !== runtimeClientId),
  );
  const sessionSummary = createMemo(() => summarizePeerSessions(peerSessions(), runtimeClientId));
  const collapsedSessionPreview = createMemo(() =>
    summarizeCollapsedSessionPreview(sessionSummary(), runtimeClientId),
  );
  const sessionSummaryText = createMemo(() => formatSessionSummaryText(sessionSummary()));
  const progressCollapsed = createMemo(() => isSidebarSectionCollapsed('progress'));
  const sessionsCollapsed = createMemo(() => isSidebarSectionCollapsed('sessions'));
  const tipsCollapsed = createMemo(() => isSidebarSectionCollapsed('tips'));
  const browserBuildLabel = createMemo(() => {
    if (electronRuntime) {
      return null;
    }

    return `Web build ${APP_VERSION} · ${APP_BUILD_STAMP}`;
  });

  return (
    <>
      <div
        style={{
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          'flex-shrink': '0',
        }}
      >
        <SidebarSectionHeader
          collapsed={progressCollapsed()}
          label="Progress"
          onToggle={() => toggleSidebarSection('progress')}
        />
        <Show when={!progressCollapsed()}>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 10px',
                'font-size': sf(11),
                color: theme.fgMuted,
              }}
            >
              <span>Completed today</span>
              <span
                style={{
                  color: theme.fg,
                  'font-weight': '600',
                  'font-variant-numeric': 'tabular-nums',
                }}
              >
                {completedTasksToday()}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 10px',
                'font-size': sf(11),
                color: theme.fgMuted,
              }}
            >
              <span>Merged to base branch</span>
              <span
                style={{
                  color: theme.fg,
                  'font-weight': '600',
                  'font-variant-numeric': 'tabular-nums',
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                }}
              >
                <span style={{ color: theme.success }}>
                  +{mergedLines().added.toLocaleString()}
                </span>
                <span style={{ color: theme.error }}>
                  -{mergedLines().removed.toLocaleString()}
                </span>
              </span>
            </div>
            <button
              onClick={() => toggleArena(true)}
              style={{
                width: '100%',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                gap: '6px',
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 14px',
                'font-size': sf(12),
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-family': 'inherit',
                'font-weight': '500',
                'margin-top': '6px',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 3L13 13M9 12L12 9" />
                <path d="M13 3L3 13M4 9L7 12" />
              </svg>
              Arena
            </button>
          </div>
        </Show>
      </div>
      <Show when={hasOtherSessions()}>
        <div
          style={{
            'border-top': `1px solid ${theme.border}`,
            'padding-top': '12px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            'flex-shrink': '0',
          }}
        >
          <SidebarSectionHeader
            collapsed={sessionsCollapsed()}
            count={sessionSummary().totalCount}
            label="Sessions"
            onToggle={() => toggleSidebarSection('sessions')}
          />
          <Show when={sessionsCollapsed()}>
            <div
              style={{
                display: 'flex',
                'flex-wrap': 'wrap',
                gap: '6px',
              }}
            >
              <For each={collapsedSessionPreview().items}>
                {(item) => <SessionChip label={item.label} statusColor={item.statusColor} />}
              </For>
              <Show when={collapsedSessionPreview().overflowCount > 0}>
                <div
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '999px',
                    padding: '5px 9px',
                    'font-size': sf(11),
                    color: theme.fgMuted,
                    'font-weight': '600',
                    'font-variant-numeric': 'tabular-nums',
                  }}
                >
                  +{collapsedSessionPreview().overflowCount}
                </div>
              </Show>
            </div>
          </Show>
          <Show when={!sessionsCollapsed()}>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  'flex-wrap': 'wrap',
                  gap: '6px',
                }}
              >
                <For each={sessionSummary().sessions}>
                  {(session) => (
                    <SessionChip
                      label={getSessionChipLabel(session, runtimeClientId)}
                      statusColor={getSessionIndicatorColor(session)}
                    />
                  )}
                </For>
              </div>

              <Show when={sessionSummaryText()}>
                {(currentSessionSummaryText) => (
                  <div
                    style={{
                      'font-size': sf(10),
                      color: theme.fgMuted,
                      'line-height': '1.4',
                    }}
                  >
                    {currentSessionSummaryText()}
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <div
        style={{
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          'flex-shrink': '0',
        }}
      >
        <SidebarSectionHeader
          collapsed={tipsCollapsed()}
          label="Tips"
          onToggle={() => toggleSidebarSection('tips')}
        />
        <Show when={!tipsCollapsed()}>
          <div
            onClick={() => toggleHelpDialog(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleHelpDialog(true);
              }
            }}
            tabIndex={0}
            role="button"
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
              'flex-shrink': '0',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                'font-size': sf(11),
                color: theme.fgMuted,
                'line-height': '1.4',
              }}
            >
              <kbd
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '3px',
                  padding: '1px 4px',
                  'font-size': sf(10),
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {alt} + Arrows
              </kbd>{' '}
              to navigate panels
            </span>
            <div
              style={{
                'font-size': sf(11),
                color: theme.fgMuted,
                'line-height': '1.4',
              }}
            >
              <kbd
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '3px',
                  padding: '1px 4px',
                  'font-size': sf(10),
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {mod} + /
              </kbd>{' '}
              for all shortcuts
            </div>
            <Show when={browserBuildLabel()}>
              {(label) => (
                <span
                  title={label()}
                  style={{
                    'font-size': sf(10),
                    color: theme.fgSubtle,
                    'font-family': "'JetBrains Mono', monospace",
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                  }}
                >
                  {label()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </>
  );
}
