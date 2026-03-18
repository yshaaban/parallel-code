import { For, Show, createMemo, type JSX } from 'solid-js';
import { OPEN_DISPLAY_NAME_DIALOG_ACTION } from '../app/app-action-keys';
import type { PeerPresenceSnapshot } from '../domain/server-state';
import { isElectronRuntime } from '../lib/browser-auth';
import { APP_BUILD_STAMP, APP_VERSION } from '../lib/build-info';
import { getStoredDisplayName } from '../lib/display-name';
import { sf } from '../lib/fontScale';
import { alt, mod } from '../lib/platform';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { theme } from '../lib/theme';
import {
  getCompletedTasksTodayCount,
  getMergedLineTotals,
  listPeerSessions,
  triggerAction,
  toggleArena,
  toggleHelpDialog,
} from '../store/store';

const MAX_VISIBLE_SESSION_CHIPS = 3;

interface SidebarSessionSummary {
  hiddenCount: number;
  overflowCount: number;
  sessions: PeerPresenceSnapshot[];
  totalCount: number;
  visibleCount: number;
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

function getSelfSession(
  sessions: ReadonlyArray<PeerPresenceSnapshot>,
  runtimeClientId: string,
): PeerPresenceSnapshot | null {
  return sessions.find((session) => session.clientId === runtimeClientId) ?? null;
}

export function SidebarFooter(): JSX.Element {
  const runtimeClientId = getRuntimeClientId();
  const electronRuntime = isElectronRuntime();
  const completedTasksToday = createMemo(() => getCompletedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());
  const peerSessions = createMemo(() => listPeerSessions());
  const selfSession = createMemo(() => getSelfSession(peerSessions(), runtimeClientId));
  const localDisplayName = createMemo(() => getStoredDisplayName());
  const hasOtherSessions = createMemo(() =>
    peerSessions().some((session) => session.clientId !== runtimeClientId),
  );
  const sessionSummary = createMemo(() => summarizePeerSessions(peerSessions(), runtimeClientId));
  const sessionSummaryText = createMemo(() => formatSessionSummaryText(sessionSummary()));
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
        <span
          style={{
            'font-size': sf(10),
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          Progress
        </span>
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
            <span style={{ color: theme.success }}>+{mergedLines().added.toLocaleString()}</span>
            <span style={{ color: theme.error }}>-{mergedLines().removed.toLocaleString()}</span>
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

      <Show when={!electronRuntime}>
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
          <span
            style={{
              'font-size': sf(10),
              color: theme.fgSubtle,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Session
          </span>
          <button
            type="button"
            onClick={() => triggerAction(OPEN_DISPLAY_NAME_DIALOG_ACTION)}
            style={{
              width: '100%',
              display: 'grid',
              gap: '4px',
              padding: '10px 12px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '10px',
              cursor: 'pointer',
              'text-align': 'left',
              'font-family': 'inherit',
            }}
          >
            <span
              style={{
                'font-size': sf(11),
                color: theme.fg,
                'font-weight': '600',
              }}
            >
              Edit session name
            </span>
            <span
              style={{
                'font-size': sf(10),
                color: theme.fgMuted,
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
            >
              {localDisplayName() ??
                selfSession()?.displayName ??
                'Choose how other sessions see you'}
            </span>
          </button>
        </div>
      </Show>

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
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '10px',
            }}
          >
            <span
              style={{
                'font-size': sf(10),
                color: theme.fgSubtle,
                'text-transform': 'uppercase',
                'letter-spacing': '0.05em',
              }}
            >
              Sessions
            </span>
            <span
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '999px',
                padding: '2px 8px',
                'font-size': sf(10),
                color: theme.fgMuted,
                'font-variant-numeric': 'tabular-nums',
              }}
            >
              {sessionSummary().totalCount}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              'flex-wrap': 'wrap',
              gap: '6px',
            }}
          >
            <For each={sessionSummary().sessions}>
              {(session) => (
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
                      background: getSessionIndicatorColor(session),
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
                    {getSessionChipLabel(session, runtimeClientId)}
                  </span>
                </div>
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
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          'flex-shrink': '0',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            'font-size': sf(10),
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          Tips
        </span>
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
            {mod} + /
          </kbd>{' '}
          for all shortcuts
        </span>
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
    </>
  );
}
